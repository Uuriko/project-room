import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

// #3322 / #3323 / #3349 regression family (probe-shaped, per the filed
// issues): usage reports bind to the attempt they name via attemptCount —
// the session's attempt_count at claim time, read from the session card.
// A stale report cannot trip the live attempt's budget wire or move its
// counters; a report naming no attempt trips only on stored history; and
// when the wire's generated stop/pause cannot commit, the outcome says so
// (budget_stop_pending / round_pause_pending) instead of claiming success.

async function serve(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-session-binding-"));
  const store = new RoomStore(join(directory, "room.sqlite"), options);
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const memberId of ["agent", "agent2"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: `Test ${memberId}`, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const agentKey = store.issueAccessKey("commons", "agent");
  const agent2Key = store.issueAccessKey("commons", "agent2");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  const propose = title => {
    const workItemId = `w-${randomUUID()}`;
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED,
      data: { workItemId, title, definitionOfDone: "done", accountableMemberId: "agent", mode: "read" } });
    return workItemId;
  };
  const claim = (workItemId, body, token = agentKey) => request("/api/rooms/commons/work-sessions", {
    method: "POST", token, data: { requestId: randomUUID(), workItemId, expectedRevision: 0,
      action: "set_status", status: "processing", ...body } });
  const mutate = (workItemId, revision, body, token = agentKey) => request("/api/rooms/commons/work-sessions", {
    method: "POST", token, data: { requestId: randomUUID(), workItemId, expectedRevision: revision,
      action: "set_status", ...body } });
  const card = async workItemId => (await request("/api/rooms/commons/work-sessions", { token: agentKey }))
    .json.sessions.find(s => s.workItemId === workItemId);
  const stops = async workItemId => {
    const events = await request("/api/rooms/commons/events", { token: agentKey });
    return (events.json?.events ?? []).map(e => e.event ?? e)
      .filter(e => e.type === "session.stopped" && e.data?.workItemId === workItemId);
  };
  return { store, origin, ownerKey, agentKey, agent2Key, propose, claim, mutate, card, request, stops };
}

test("a report naming the live attempt trips on its own numbers, and the stop records the spend (#3322 matched, #3349)", async t => {
  const { propose, claim, mutate, card, stops } = await serve(t);
  const workItemId = propose("bound run");
  assert.equal((await claim(workItemId, { budget: { maxSpendCents: 1000 } })).status, 201);
  assert.equal((await card(workItemId)).attempt_count, 1);
  assert.equal((await mutate(workItemId, 1, { status: "active", spendCents: 900, attemptCount: 1 })).status, 201);
  const over = await mutate(workItemId, 2, { status: "active", spendCents: 1500, attemptCount: 1 });
  assert.equal(over.status, 409);
  assert.equal(over.json?.error?.code, "budget_exceeded");
  assert.equal((await card(workItemId)).status, "failed");
  const recorded = await stops(workItemId);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].data.limit, "maxSpendCents");
  assert.equal(recorded[0].data.spendCents, 1500, "#3349: the stop records the spend figure that tripped it");
});

test("a stale report cannot stop the live attempt or move its counters (#3322 probe)", async t => {
  const { propose, claim, mutate, card, stops } = await serve(t);
  const workItemId = propose("retried run");
  assert.equal((await claim(workItemId, { budget: { maxSpendCents: 1000 } })).status, 201);
  // Attempt 1 reports 900, then fails.
  assert.equal((await mutate(workItemId, 1, { status: "active", spendCents: 900, attemptCount: 1 })).status, 201);
  assert.equal((await mutate(workItemId, 2, { status: "failed" })).status, 201);
  // Attempt 2 starts; the budget is inherited, the counters reset.
  const retry = await mutate(workItemId, 3, { status: "processing" });
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  let session = await card(workItemId);
  assert.equal(session.attempt_count, 2);
  assert.equal((await mutate(workItemId, session.revision, { status: "active", spendCents: 100, attemptCount: 2 })).status, 201);
  session = await card(workItemId);
  assert.equal(session.spendCents, 100);
  // The stale report arrives carrying attempt 1's cumulative 1500.
  const stale = await mutate(workItemId, session.revision, { status: "active", spendCents: 1500, attemptCount: 1 });
  assert.equal(stale.status, 201, `stale report must not 409: ${JSON.stringify(stale.json)}`);
  session = await card(workItemId);
  assert.equal(session.status, "active", "attempt 2 was not force-stopped by a stale report");
  assert.equal(session.spendCents, 100, "the stale report's numbers did not move the live counters");
  const recorded = await stops(workItemId);
  assert.equal(recorded.length, 1, "only attempt 1's own stop is in the log");
  assert.equal(recorded[0].data.budgetEnforced, undefined);
  // The quieter variant: a stale under-budget report must not rewind or
  // overwrite the live attempt's spend either.
  const staleQuiet = await mutate(workItemId, session.revision, { status: "active", spendCents: 500, attemptCount: 1 });
  assert.equal(staleQuiet.status, 201);
  assert.equal((await card(workItemId)).spendCents, 100);
});

test("spend reports are monotonic: a lower later report never rewinds the counter (#3322 sub-fix)", async t => {
  const { propose, claim, mutate, card } = await serve(t);
  const workItemId = propose("monotonic run");
  assert.equal((await claim(workItemId, { budget: { maxSpendCents: 1000 } })).status, 201);
  assert.equal((await mutate(workItemId, 1, { status: "active", spendCents: 500, attemptCount: 1 })).status, 201);
  assert.equal((await mutate(workItemId, 2, { status: "active", spendCents: 300, attemptCount: 1 })).status, 201);
  assert.equal((await card(workItemId)).spendCents, 500);
});

test("attemptCount is validated like the other report fields", async t => {
  const { propose, claim, mutate } = await serve(t);
  const workItemId = propose("validated run");
  assert.equal((await claim(workItemId, {})).status, 201);
  const negative = await mutate(workItemId, 1, { status: "active", attemptCount: -1 });
  assert.equal(negative.status, 422);
  assert.equal(negative.json?.error?.code, "invalid_session_attempt");
  const fractional = await mutate(workItemId, 1, { status: "active", attemptCount: 1.5 });
  assert.equal(fractional.status, 422);
  assert.equal(fractional.json?.error?.code, "invalid_session_attempt");
});

test("a foreign reporter's refused stop is reported as pending, never as done (#3323 D1)", async t => {
  const { propose, claim, mutate, card, stops, agent2Key } = await serve(t);
  const workItemId = propose("steered run");
  assert.equal((await claim(workItemId, { budget: { maxSpendCents: 100 } })).status, 201);
  assert.equal((await mutate(workItemId, 1, { status: "active", spendCents: 100, attemptCount: 1 })).status, 201);
  // agent2 is not the claim holder and holds no manage_claims: its
  // over-budget report trips the wire, but the generated stop is refused
  // by the claim gate inside command().
  const foreign = await mutate(workItemId, 2, { status: "active", spendCents: 1500, attemptCount: 1 }, agent2Key);
  assert.equal(foreign.status, 409, JSON.stringify(foreign.json));
  assert.equal(foreign.json?.error?.code, "budget_stop_pending");
  assert.doesNotMatch(foreign.json?.error?.message ?? "", /the session was stopped/);
  const session = await card(workItemId);
  assert.equal(session.status, "active", "the session was NOT stopped");
  assert.equal((await stops(workItemId)).length, 0, "no session.stopped was recorded");
  // Enforcement is not wedged: the holder's own over-budget report stops it.
  const own = await mutate(workItemId, session.revision, { status: "active", spendCents: 1500, attemptCount: 1 });
  assert.equal(own.status, 409);
  assert.equal(own.json?.error?.code, "budget_exceeded");
  assert.equal((await card(workItemId)).status, "failed");
});

test("a fault mid-stop rolls the whole generated stop back (#3323 D2)", async t => {
  const { store, propose, claim, mutate, card, stops } = await serve(t);
  const workItemId = propose("faulted stop");
  assert.equal((await claim(workItemId, { budget: { maxSpendCents: 100 } })).status, 201);
  assert.equal((await mutate(workItemId, 1, { status: "active", spendCents: 100, attemptCount: 1 })).status, 201);
  // Inject the D2 fault: the stop's in-transaction side effect throws after
  // the event and commands rows were written. Pre-fix those writes
  // committed and the caller was still told the session was stopped.
  const original = store.workWakes.transition;
  store.workWakes.transition = () => { throw new Error("injected fault"); };
  const faulted = await mutate(workItemId, 2, { status: "active", spendCents: 1500, attemptCount: 1 });
  store.workWakes.transition = original;
  assert.equal(faulted.status, 409, JSON.stringify(faulted.json));
  assert.equal(faulted.json?.error?.code, "budget_stop_pending");
  const session = await card(workItemId);
  assert.equal(session.status, "active", "no prefix of the generated stop committed");
  assert.equal(session.spendCents, 100);
  assert.equal((await stops(workItemId)).length, 0, "the stop event rolled back with the rest");
  // With the fault cleared, the same report completes the stop honestly.
  const retried = await mutate(workItemId, session.revision, { status: "active", spendCents: 1500, attemptCount: 1 });
  assert.equal(retried.status, 409);
  assert.equal(retried.json?.error?.code, "budget_exceeded");
  assert.equal((await card(workItemId)).status, "failed");
});

test("a foreign reporter's refused pause is reported as pending (#3323 rounds leg)", async t => {
  const { propose, claim, mutate, card, agent2Key } = await serve(t);
  const workItemId = propose("steered rounds");
  assert.equal((await claim(workItemId, { budget: { maxRounds: 2 } })).status, 201);
  assert.equal((await mutate(workItemId, 1, { status: "active", rounds: 2, attemptCount: 1 })).status, 201);
  const foreign = await mutate(workItemId, 2, { status: "active", rounds: 5, attemptCount: 1 }, agent2Key);
  assert.equal(foreign.status, 409, JSON.stringify(foreign.json));
  assert.equal(foreign.json?.error?.code, "round_pause_pending");
  assert.equal((await card(workItemId)).status, "active", "the session was NOT paused");
  // The holder's own over-limit report pauses it, with the original code.
  const session = await card(workItemId);
  const own = await mutate(workItemId, session.revision, { status: "active", rounds: 5, attemptCount: 1 });
  assert.equal(own.status, 409);
  assert.equal(own.json?.error?.code, "round_limit_exceeded");
  assert.equal((await card(workItemId)).status, "suspended");
});
