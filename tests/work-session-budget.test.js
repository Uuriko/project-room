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
import { validateSessionBudget, budgetCard, budgetLimitExceeded } from "../src/work-item-session.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-session-budget-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
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
  return { store, origin, ownerKey, agentKey, propose, claim, mutate, card, request };
}

test("budget validation: unknown keys, bad values and empty budgets are rejected", () => {
  assert.throws(() => validateSessionBudget({ bogus: 1 }), /Budget keys/);
  assert.throws(() => validateSessionBudget({}), /Budget keys/);
  assert.throws(() => validateSessionBudget({ maxRuntimeMs: 0 }), /must be an integer/);
  assert.throws(() => validateSessionBudget({ maxAttempts: -2 }), /must be an integer/);
  assert.throws(() => validateSessionBudget({ maxSpendCents: 1.5 }), /must be an integer/);
  assert.throws(() => validateSessionBudget({ maxConcurrent: 26 }), /must be an integer/);
  assert.equal(validateSessionBudget(undefined), null);
  assert.equal(validateSessionBudget(null), null);
  assert.deepEqual(validateSessionBudget({ maxRuntimeMs: 60000 }), { maxRuntimeMs: 60000 });
});

test("a claimed budget is visible on the card; undeclared quotas read 'unknown'", async t => {
  const { propose, claim, card } = await serve(t);
  const workItemId = propose("budgeted run");
  const res = await claim(workItemId, { budget: { maxRuntimeMs: 3600000, maxAttempts: 3 } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const session = await card(workItemId);
  assert.deepEqual(session.budget, { maxRuntimeMs: 3600000, maxAttempts: 3, maxConcurrent: "unknown", maxSpendCents: "unknown" });
  assert.equal(session.attempt_count, 1);
  assert.ok(session.started_at, "start time is recorded");
  assert.equal(session.spendCents, "unknown", "unreported spend is labeled unknown, not zero");
  const otherId = propose("plain run");
  await claim(otherId, {});
  const other = await card(otherId);
  assert.deepEqual(other.budget, budgetCard(null));
  assert.ok(Object.values(other.budget).every(v => v === "unknown"));
});

test("a runaway session is stopped by its runtime limit on the next interaction", async t => {
  const { propose, claim, mutate, card, request, origin, agentKey } = await serve(t);
  const workItemId = propose("runaway run");
  assert.equal((await claim(workItemId, { budget: { maxRuntimeMs: 1 } })).status, 201);
  // The 1ms budget has elapsed by the time the worker heartbeats again.
  const beat = await mutate(workItemId, 1, { status: "active" });
  assert.equal(beat.status, 409);
  assert.equal(beat.json?.error?.code, "budget_exceeded");
  assert.match(beat.json?.error?.message ?? "", /maxRuntimeMs/);
  const session = await card(workItemId);
  assert.equal(session.status, "failed", "the runaway session was force-stopped, not merely rejected");
  // The stop is in the event log with its reason, attributed and inspectable.
  const events = await request("/api/rooms/commons/events", { token: agentKey });
  const stop = (events.json?.events ?? []).map(e => e.event ?? e)
    .find(e => e.type === "session.stopped" && e.data?.workItemId === workItemId);
  assert.ok(stop, "a session.stopped event was recorded");
  assert.equal(stop.data.reason, "budget_exceeded");
  assert.equal(stop.data.limit, "maxRuntimeMs");
  assert.equal(stop.data.budgetEnforced, true);
});

test("concurrency budget follows the worker to the next claim", async t => {
  const { propose, claim } = await serve(t);
  const first = propose("first run"), second = propose("second run");
  assert.equal((await claim(first, { budget: { maxConcurrent: 1 } })).status, 201);
  const clash = await claim(second, {});
  assert.equal(clash.status, 409);
  assert.equal(clash.json?.error?.code, "budget_exceeded");
  assert.match(clash.json?.error?.message ?? "", /Concurrency budget of 1/);
});

test("spend trips only on reported numbers; unknown spend never authorizes overage", async t => {
  const { propose, claim, mutate, card } = await serve(t);
  const workItemId = propose("spendy run");
  assert.equal((await claim(workItemId, { budget: { maxSpendCents: 100 } })).status, 201);
  // Under the cap: the report lands and the session continues.
  assert.equal((await mutate(workItemId, 1, { status: "active", spendCents: 60 })).status, 201);
  assert.equal((await card(workItemId)).spendCents, 60);
  assert.equal(budgetLimitExceeded({ status: "active", budget: { maxSpendCents: 100 }, spend_cents: null }, Date.now()), null);
  // Over the cap: this very report stops the session.
  const over = await mutate(workItemId, 2, { status: "active", spendCents: 150 });
  assert.equal(over.status, 409);
  assert.equal(over.json?.error?.code, "budget_exceeded");
  assert.equal((await card(workItemId)).status, "failed");
});

test("budgets are rejected off the start transition and on malformed input", async t => {
  const { propose, claim, mutate, card } = await serve(t);
  const workItemId = propose("picky run");
  assert.equal((await claim(workItemId, { budget: { maxRuntimeMs: 0 } })).status, 422);
  assert.equal((await claim(workItemId, { budget: { whatever: 5 } })).status, 422);
  assert.equal((await claim(workItemId, { budget: { maxRuntimeMs: 60000 } })).status, 201);
  const session = await card(workItemId);
  // A budget on a later status change is rejected — the brief is fixed at start.
  const late = await mutate(workItemId, session.revision, { status: "active", budget: { maxRuntimeMs: 1 } });
  assert.equal(late.status, 422);
  assert.equal(late.json?.error?.code, "invalid_session_budget");
  const badSpend = await mutate(workItemId, session.revision, { status: "active", spendCents: -5 });
  assert.equal(badSpend.status, 422);
});
