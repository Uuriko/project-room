import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { validAgentNext } from "../src/agent-error.mjs";
import {
  SESSION_STATUSES, SESSION_EVENT_TYPES, sessionRecord, sessionCommandType, attemptReceipts, cancellationState,
  listWorkItemSessions, workItemSessionContract, applySessionFields, sessionWorker,
  presentedSessionStatus, SESSION_HEARTBEAT_STALE_MS,
  roundLimitExceeded, reportRounds, reportToolCalls
} from "../src/work-item-session.js";

const PEOPLE = /@gmail|John |Potter |acct-|accountId|people-data/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-work-session-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "session-one", title: "Draft the agenda", definitionOfDone: "Named next step",
    accountableMemberId: "agent", mode: "read"
  } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, request, ownerKey, agentKey };
}

function sessionBody(extras = {}) {
  return { requestId: randomUUID(), workItemId: "session-one", expectedRevision: 0, ...extras };
}

test("session contract stays on writer 27 and off Compute / Slack-with-bots / people-data", () => {
  const contract = workItemSessionContract();
  assert.equal(contract.status, "live");
  assert.equal(contract.schemaBump, false);
  assert.equal(contract.writer, 27);
  assert.deepEqual(contract.statuses, ["queued", "processing", "active", "suspended", "done", "failed"]);
  assert.deepEqual(contract.events, [
    SESSION_EVENT_TYPES.STARTED, SESSION_EVENT_TYPES.STATUS_CHANGED,
    SESSION_EVENT_TYPES.STOP_REQUESTED, SESSION_EVENT_TYPES.STOPPED
  ]);
  assert.equal(contract.compute, false);
  assert.equal(contract.slackWithBotsUi, false);
  assert.equal(contract.peopleData, false);
  assert.equal(contract.workStateSeparate, true);
});

test("legacy work items read as queued; started/status/stop/stopped are exact transitions", () => {
  const item = { id: "legacy", title: "Old", state: "accepted", revision: 2, accountableMemberId: "agent" };
  assert.deepEqual(sessionRecord(item), { status: "queued", stop_requested_at: null, heartbeat_at: null, worker_member_id: null,
    started_at: null, attempt_count: 0, budget: null, spend_cents: null, round_count: 0, tool_calls: 0, suspended_by: null, attempts: [] });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, at: "2026-09-10T21:00:00.000Z" });
  assert.equal(item.status, SESSION_STATUSES.PROCESSING);
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STATUS_CHANGED, at: "2026-09-10T21:01:00.000Z", data: { status: "active" } });
  assert.equal(item.status, SESSION_STATUSES.ACTIVE);
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOP_REQUESTED, at: "2026-09-10T21:02:00.000Z" });
  assert.equal(item.stop_requested_at, "2026-09-10T21:02:00.000Z");
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, at: "2026-09-10T21:03:00.000Z", data: { status: "done" } });
  assert.equal(item.status, SESSION_STATUSES.DONE);
  // A finished session may be started again as a retry (attempt 2), so this no longer throws.
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-10T21:04:00.000Z" });
  assert.equal(item.status, SESSION_STATUSES.PROCESSING);
  assert.equal(item.attempt_count, 2);
  assert.equal(sessionCommandType({ status: "failed" }, "set_status", "processing"), SESSION_EVENT_TYPES.STARTED);
  assert.equal(sessionCommandType({ status: "done" }, "set_status", "processing"), SESSION_EVENT_TYPES.STARTED);
  // Running sessions still cannot be "started" again.
  assert.throws(() => applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, at: "2026-09-10T21:05:00.000Z" }), /Invalid session/);
  assert.equal(sessionCommandType({ status: "queued" }, "set_status", "processing"), SESSION_EVENT_TYPES.STARTED);
  assert.equal(sessionCommandType({ status: "active" }, "request_stop"), SESSION_EVENT_TYPES.STOP_REQUESTED);
  assert.equal(sessionCommandType({ status: "active" }, "set_status", "failed"), SESSION_EVENT_TYPES.STOPPED);
  assert.deepEqual(listWorkItemSessions({ a: { id: "a", title: "A", state: "proposed", revision: 0, accountableMemberId: "x", status: "active" },
    b: { id: "b", title: "B", state: "superseded", revision: 1, accountableMemberId: "x", status: "active" } }, "active").map(card => card.workItemId), ["a"]);
});

test("seed work keeps assignment state; session defaults do not rewrite history", () => {
  const state = replay(seedEvents);
  const review = state.workItems["work-spec-review"];
  assert.equal(review.state, "completed");
  assert.deepEqual(sessionRecord(review), { status: "queued", stop_requested_at: null, heartbeat_at: null, worker_member_id: null,
    started_at: null, attempt_count: 0, budget: null, spend_cents: null, round_count: 0, tool_calls: 0, suspended_by: null, attempts: [] });
  const next = applyEvent(state, {
    id: "session-seed-start", idempotencyKey: "session-seed-start", roomId: state.room.id,
    type: T.SESSION_STARTED, actorId: "codex", at: "2026-09-10T21:10:00.000Z",
    data: { workItemId: "work-spec-review", expectedRevision: review.revision }
  });
  assert.equal(next.workItems["work-spec-review"].status, "processing");
  assert.equal(next.workItems["work-spec-review"].state, "completed");
  assert.equal(next.workItems["work-spec-review"].revision, review.revision + 1);
  assert.equal(presentedSessionStatus(review), "done");
  assert.equal(listWorkItemSessions({ review })[0].status, "done");
  assert.equal(listWorkItemSessions({ review }, "queued").length, 0);
  assert.equal(listWorkItemSessions({ review }, "done")[0].workItemId, "work-spec-review");
});

test("HTTP lists by status, sets status, and Stop writes stop_requested_at plus Event", async t => {
  const { store, request, ownerKey, agentKey } = await serve(t);

  const listed = await request("/api/rooms/commons/work-sessions", { token: agentKey });
  assert.equal(listed.status, 200);
  const page = await listed.json();
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0].title, "Draft the agenda");
  assert.equal(page.sessions[0].status, "queued");
  assert.equal(page.sessions[0].stop_requested_at, null);
  assert.doesNotMatch(JSON.stringify(page), PEOPLE);

  const filtered = await request("/api/rooms/commons/work-sessions?status=queued", { token: agentKey });
  assert.equal((await filtered.json()).sessions.length, 1);
  const empty = await request("/api/rooms/commons/work-sessions?status=active", { token: agentKey });
  assert.equal((await empty.json()).sessions.length, 0);
  const bad = await request("/api/rooms/commons/work-sessions?status=working", { token: agentKey });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_session_status");

  const started = await request("/api/rooms/commons/work-sessions", {
    method: "POST", token: agentKey, data: sessionBody({ action: "set_status", status: "processing" })
  });
  assert.equal(started.status, 201);
  const startEvent = await started.json();
  assert.equal(startEvent.event.type, T.SESSION_STARTED);
  assert.equal(store.room("commons").state.workItems["session-one"].status, "processing");
  assert.equal(store.workContext(agentKey, "commons", "session-one").work.status, "processing");
  assert.equal(store.workContext(agentKey, "commons", "session-one").work.state, "proposed");

  const activated = await request("/api/rooms/commons/work-sessions", {
    method: "POST", token: agentKey,
    data: sessionBody({ action: "set_status", status: "active", expectedRevision: 1 })
  });
  assert.equal(activated.status, 201);
  assert.equal((await activated.json()).event.type, T.SESSION_STATUS_CHANGED);

  const stop = await request("/api/rooms/commons/work-sessions", {
    method: "POST", token: ownerKey,
    data: sessionBody({ action: "request_stop", expectedRevision: 2 })
  });
  assert.equal(stop.status, 201);
  const stopEvent = await stop.json();
  assert.equal(stopEvent.event.type, T.SESSION_STOP_REQUESTED);
  const afterStop = store.room("commons").state.workItems["session-one"];
  assert.equal(afterStop.status, "active");
  assert.equal(typeof afterStop.stop_requested_at, "string");

  const stopped = await request("/api/rooms/commons/work-sessions", {
    method: "POST", token: agentKey,
    data: sessionBody({ action: "set_status", status: "done", expectedRevision: 3 })
  });
  assert.equal(stopped.status, 201);
  assert.equal((await stopped.json()).event.type, T.SESSION_STOPPED);
  assert.equal(store.room("commons").state.workItems["session-one"].status, "done");
  const doneList = await request("/api/rooms/commons/work-sessions?status=done", { token: agentKey });
  assert.equal((await doneList.json()).sessions[0].status, "done");
});

test("strangers cannot mutate; commands are idempotent; writer stays 26", async t => {
  const { store, request, ownerKey, agentKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "guest", displayName: "Test guest", kind: "human", permissions: [] } });
  const guestKey = store.issueAccessKey("commons", "guest");
  const denied = await request("/api/rooms/commons/work-sessions", {
    method: "POST", token: guestKey, data: sessionBody({ action: "request_stop" })
  });
  assert.equal(denied.status, 422);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, "command_rejected");
  assert.ok(validAgentNext(deniedBody.next));

  const body = sessionBody({ action: "set_status", status: "processing" });
  const first = await request("/api/rooms/commons/work-sessions", { method: "POST", token: agentKey, data: body });
  assert.equal(first.status, 201);
  const retry = await request("/api/rooms/commons/work-sessions", { method: "POST", token: agentKey, data: body });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);

  const viaCommand = store.command(agentKey, "commons", {
    id: randomUUID(), type: T.SESSION_STATUS_CHANGED,
    data: { workItemId: "session-one", expectedRevision: 1, status: "active" }
  });
  assert.equal(viaCommand.event.type, T.SESSION_STATUS_CHANGED);
  assert.equal(store.storagePlatform.version(store.db), 35);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'work_item_session%'").all().length, 0);
});

test("session claims: worker recorded on start, visible on card, cleared on stop; stale heartbeats are takeable", () => {
  const item = { id: "w", title: "W", state: "accepted", revision: 0, accountableMemberId: "agent" };
  assert.equal(sessionWorker(item), null);
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-10T21:00:00.000Z" });
  assert.equal(item.worker_member_id, "agent");
  assert.equal(listWorkItemSessions({ w: item })[0].worker_member_id, "agent");
  const beat = Date.parse("2026-09-10T21:00:00.000Z");
  assert.equal(sessionWorker(item, beat + SESSION_HEARTBEAT_STALE_MS - 1000), "agent");
  assert.equal(sessionWorker(item, beat + SESSION_HEARTBEAT_STALE_MS + 1000), null);
  // stop_requested does not steal the claim
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOP_REQUESTED, actorId: "owner", at: "2026-09-10T21:01:00.000Z" });
  assert.equal(item.worker_member_id, "agent");
  // status change by the worker keeps the claim
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STATUS_CHANGED, actorId: "agent", at: "2026-09-10T21:02:00.000Z", data: { status: "active" } });
  assert.equal(item.worker_member_id, "agent");
  // terminal stop clears it
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-10T21:03:00.000Z", data: { status: "done" } });
  assert.equal(item.worker_member_id, null);
  assert.equal(sessionWorker(item), null);
});

test("HTTP: second agent gets 409 on a claimed session; owner can override; card shows the worker", async t => {
  const { store, request, ownerKey, agentKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent-b", displayName: "Agent B", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const bKey = store.issueAccessKey("commons", "agent-b");
  const post = (token, data) => request("/api/rooms/commons/work-sessions", { method: "POST", token, data });

  const started = await post(agentKey, sessionBody({ action: "set_status", status: "processing" }));
  assert.equal(started.status, 201);

  const listed = await request("/api/rooms/commons/work-sessions", { token: agentKey });
  const card = (await listed.json()).sessions.find(c => c.workItemId === "session-one");
  assert.equal(card.worker_member_id, "agent");

  const stolen = await post(bKey, sessionBody({ action: "set_status", status: "suspended", expectedRevision: 1 }));
  assert.equal(stolen.status, 409);
  assert.equal((await stolen.json()).error.code, "session_claimed");

  // request_stop is still restricted to the accountable member or steerers (pre-existing model)
  const nudge = await post(bKey, sessionBody({ action: "request_stop", expectedRevision: 1 }));
  assert.equal(nudge.status, 422);

  // owner holds manage_claims: may drive someone else's session
  const over = await post(ownerKey, sessionBody({ action: "set_status", status: "suspended", expectedRevision: 1 }));
  assert.ok([200, 201].includes(over.status));
  const after = (await (await request("/api/rooms/commons/work-sessions", { token: agentKey })).json())
    .sessions.find(c => c.workItemId === "session-one");
  assert.equal(after.worker_member_id, "owner");
});

test("a retry from a terminal status increments attempt_count, resets run fields, keeps the budget and stops at maxAttempts", () => {
  const item = { id: "retry", title: "R", state: "accepted", revision: 0, accountableMemberId: "agent" };
  const at = minute => `2026-09-10T21:${String(minute).padStart(2, "0")}:00.000Z`;
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: at(0), data: { budget: { maxAttempts: 2 } } });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOP_REQUESTED, actorId: "owner", at: at(1) });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: at(2), data: { status: "failed", spendCents: 40 } });
  assert.equal(item.attempt_count, 1); assert.equal(item.spend_cents, 40); assert.ok(item.stop_requested_at);
  // Retry without redeclaring a budget: the earlier budget stays in force.
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent-b", at: at(3) });
  assert.equal(item.status, SESSION_STATUSES.PROCESSING);
  assert.equal(item.attempt_count, 2);
  assert.equal(item.worker_member_id, "agent-b");
  assert.equal(item.started_at, at(3)); assert.equal(item.heartbeat_at, at(3));
  assert.equal(item.stop_requested_at, null); assert.equal(item.spend_cents, null);
  assert.deepEqual(item.budget, { maxAttempts: 2 });
  assert.equal(sessionWorker(item, Date.parse(at(3)) + 1000), "agent-b");
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent-b", at: at(4), data: { status: "done" } });
  const before = structuredClone(item);
  assert.throws(() => applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: at(5) }), /attempt 3 exceeds the attempt budget of 2/);
  assert.deepEqual(item, before, "a refused retry changes nothing");
  // A retry may declare a wider budget explicitly; a stop requested on the earlier run does not block it.
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: at(6), data: { budget: { maxAttempts: 3 } } });
  assert.equal(item.attempt_count, 3);
});

test("G1 attempt contract: starts record attributable attempts; stops close them with outputs", () => {
  const item = { id: "w", title: "Attempted", state: "accepted", revision: 3, accountableMemberId: "owner" };
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent-a", at: "2026-09-13T10:00:00.000Z",
    data: { budget: { maxAttempts: 5 }, environment: "local-mac-1" } });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent-a", at: "2026-09-13T10:20:00.000Z",
    data: { status: "failed", outputs: ["log:run-1"] } });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent-b", at: "2026-09-13T11:00:00.000Z", data: {} });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent-b", at: "2026-09-13T11:30:00.000Z",
    data: { status: "done", outputs: ["msg:result-9", "https://example.invalid/evidence"] } });
  const ledger = JSON.parse(JSON.stringify(sessionRecord(item).attempts));
  assert.deepEqual(ledger, [
    { attempt: 1, performer: "agent-a", startedAt: "2026-09-13T10:00:00.000Z", inputRevision: 3,
      environment: "local-mac-1", limits: { maxAttempts: 5 }, endedAt: "2026-09-13T10:20:00.000Z",
      outcome: "failed", outputs: ["log:run-1"], usageCents: null },
    // A retry that declares no budget keeps the previous limits - recorded as in force.
    { attempt: 2, performer: "agent-b", startedAt: "2026-09-13T11:00:00.000Z", inputRevision: 3,
      environment: null, limits: { maxAttempts: 5 }, endedAt: "2026-09-13T11:30:00.000Z",
      outcome: "done", outputs: ["msg:result-9", "https://example.invalid/evidence"], usageCents: null }
  ]);
  assert.equal(item.attempt_count, 2);
});

test("G1 attempt fields validate; historical events without them replay to nulls", () => {
  const item = { id: "w2", title: "Old attempt", state: "accepted", revision: 0, accountableMemberId: "owner" };
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-01T00:00:00.000Z" });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-01T01:00:00.000Z", data: { status: "done" } });
  assert.deepEqual(JSON.parse(JSON.stringify(sessionRecord(item).attempts)),
    [{ attempt: 1, performer: "agent", startedAt: "2026-09-01T00:00:00.000Z", inputRevision: 0,
      environment: null, limits: null, endedAt: "2026-09-01T01:00:00.000Z", outcome: "done", outputs: null, usageCents: null }]);
  for (const bad of [42, {}, "", "  ", "x".repeat(201)])
    assert.throws(() => applySessionFields({ id: "x", state: "accepted", revision: 0 },
      { type: SESSION_EVENT_TYPES.STARTED, actorId: "a", at: "2026-09-01T00:00:00.000Z", data: { environment: bad } }));
  for (const bad of [[], ["ok", 5], ["x".repeat(501)], Array(11).fill("ref"), "", "  ", "x".repeat(501)])
    assert.throws(() => applySessionFields(
      { id: "x", state: "accepted", revision: 0, status: "processing", heartbeat_at: "2026-09-01T00:00:00.000Z", attempt_count: 1, attempts: [{ attempt: 1, performer: "a", startedAt: "2026-09-01T00:00:00.000Z", endedAt: null }] },
      { type: SESSION_EVENT_TYPES.STOPPED, actorId: "a", at: "2026-09-01T01:00:00.000Z", data: { status: "done", outputs: bad } }));
});

test("G1 legacy string outputs (v11-v18 shape) stay valid and record as one reference", () => {
  const item = { id: "w3", title: "Legacy", state: "accepted", revision: 0, accountableMemberId: "owner" };
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-01T00:00:00.000Z" });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-01T01:00:00.000Z",
    data: { status: "done", outputs: "A reviewed result" } });
  assert.deepEqual(JSON.parse(JSON.stringify(sessionRecord(item).attempts)),
    [{ attempt: 1, performer: "agent", startedAt: "2026-09-01T00:00:00.000Z", inputRevision: 0,
      environment: null, limits: null, endedAt: "2026-09-01T01:00:00.000Z", outcome: "done", outputs: ["A reviewed result"], usageCents: null }]);
});

test("G6 output and usage receipts: measured usage stays apart from estimates; incomplete success reads unverified", () => {
  const item = { id: "wr", title: "Receipted", state: "accepted", revision: 0, accountableMemberId: "owner" };
  // Attempt 1: done WITH exact outputs and measured usage -> verified success.
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-13T00:00:00.000Z",
    data: { budget: { maxSpendCents: 500 } } });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-13T00:10:00.000Z",
    data: { status: "done", outputs: ["msg:result-1"], spendCents: 120 } });
  // Attempt 2: done but NO outputs recorded -> cannot claim success.
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-13T01:00:00.000Z", data: {} });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-13T01:10:00.000Z", data: { status: "done" } });
  const receipts = JSON.parse(JSON.stringify(attemptReceipts(item)));
  assert.equal(receipts[0].successClaim, "verified");
  assert.equal(receipts[0].usageCents, 120);        // measured
  assert.equal(receipts[0].estimateCents, 500);     // estimate, kept separate
  assert.deepEqual(receipts[0].outputs, ["msg:result-1"]);
  assert.equal(receipts[1].successClaim, "unverified");
  assert.equal(receipts[1].outputs, null);

  // Unknown measured usage (spend never reported) also blocks the claim.
  const unknown = { id: "wu", title: "No spend", state: "accepted", revision: 0, accountableMemberId: "owner" };
  applySessionFields(unknown, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-13T02:00:00.000Z", data: {} });
  applySessionFields(unknown, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-13T02:10:00.000Z",
    data: { status: "done", outputs: ["msg:result-2"] } });
  assert.equal(attemptReceipts(unknown)[0].successClaim, "unverified");
  assert.equal(attemptReceipts(unknown)[0].usageCents, null);

  // A failed attempt makes no success claim at all.
  const failed = { id: "wf", title: "Failed", state: "accepted", revision: 0, accountableMemberId: "owner" };
  applySessionFields(failed, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-13T03:00:00.000Z", data: {} });
  applySessionFields(failed, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-13T03:10:00.000Z", data: { status: "failed" } });
  assert.equal(attemptReceipts(failed)[0].successClaim, "not-claimed");

  // The session card surfaces receipts alongside the ledger.
  assert.equal(listWorkItemSessions({ wr: item })[0].receipts.length, 2);
});

test("G7 meaningful cancellation: stop requested, dispatch disabled, access revoked and runtime stopped stay distinct; silence never means stopped", () => {
  const at = Date.parse("2026-09-13T04:00:00.000Z");
  const live = () => { const item = { id: "c", title: "Live", state: "accepted", revision: 0, accountableMemberId: "owner" };
    applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-13T03:50:00.000Z", data: {} });
    return item; };

  // stop requested: signal sent, run may still be live - not terminated.
  const stopping = live();
  applySessionFields(stopping, { type: SESSION_EVENT_TYPES.STOP_REQUESTED, actorId: "owner", at: "2026-09-13T03:59:00.000Z" });
  const s1 = cancellationState(stopping, { nowMs: at });
  assert.deepEqual({ stopRequested: s1.stopRequested, runtimeStopped: s1.runtimeStopped, unresponsive: s1.unresponsive },
    { stopRequested: true, runtimeStopped: false, unresponsive: false });

  // dispatch disabled: a tripped budget wire forbids further dispatch; still not a stop.
  const over = live();
  over.budget = { maxSpendCents: 100 }; over.spend_cents = 150;
  const s2 = cancellationState(over, { nowMs: at });
  assert.equal(s2.dispatchDisabled, "maxSpendCents");
  assert.equal(s2.runtimeStopped, false);

  // access revoked: the worker's membership is inactive while the run shows live.
  const s3 = cancellationState(live(), { nowMs: at, workerActive: false });
  assert.equal(s3.accessRevoked, true);
  assert.equal(s3.runtimeStopped, false);

  // runtime stopped: an actual stop event is the only termination proof.
  const done = live();
  applySessionFields(done, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-09-13T03:59:30.000Z", data: { status: "done" } });
  const s4 = cancellationState(done, { nowMs: at });
  assert.deepEqual({ stopRequested: s4.stopRequested, dispatchDisabled: s4.dispatchDisabled,
    accessRevoked: s4.accessRevoked, runtimeStopped: s4.runtimeStopped, unresponsive: s4.unresponsive },
    { stopRequested: false, dispatchDisabled: null, accessRevoked: false, runtimeStopped: true, unresponsive: false });

  // silence: heartbeat long stale -> unresponsive, NEVER runtimeStopped.
  const silent = { id: "s", title: "Silent", state: "accepted", revision: 0, accountableMemberId: "owner" };
  applySessionFields(silent, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-09-13T01:00:00.000Z", data: {} });
  const s5 = cancellationState(silent, { nowMs: at });
  assert.equal(s5.unresponsive, true);
  assert.equal(s5.runtimeStopped, false, "silence must never read as termination");

  // the session card carries the derivation
  const card = listWorkItemSessions({ s: silent }, null, { nowMs: at })[0];
  assert.equal(card.cancellation.unresponsive, true);
  assert.equal(card.cancellation.runtimeStopped, false);
});

test("G1 attempt environment and outputs flow through the session command path", async t => {
  const { request, ownerKey } = await serve(t);
  const start = await request("/api/rooms/commons/work-sessions", { method: "POST", token: ownerKey,
    data: sessionBody({ action: "set_status", status: "processing", environment: "ci-runner-2" }) });
  assert.equal(start.status, 201);
  const stopId = randomUUID();
  const stop = await request("/api/rooms/commons/work-sessions", { method: "POST", token: ownerKey,
    data: sessionBody({ requestId: stopId, action: "set_status", status: "done", outputs: ["msg:done-1"], expectedRevision: 1 }) });
  assert.equal(stop.status, 201);
  const listed = await (await request("/api/rooms/commons/work-sessions", { token: ownerKey })).json();
  const card = listed.sessions.find(s => s.workItemId === "session-one");
  assert.deepEqual(card.attempts, [{ attempt: 1, performer: "owner", startedAt: card.attempts[0].startedAt,
    inputRevision: 0, environment: "ci-runner-2", limits: null, endedAt: card.attempts[0].endedAt,
    outcome: "done", outputs: ["msg:done-1"], usageCents: null }]);
  // Wrong placement is rejected.
  const misplaced = await request("/api/rooms/commons/work-sessions", { method: "POST", token: ownerKey,
    data: sessionBody({ action: "set_status", status: "processing", outputs: ["msg:x"] }) });
  assert.equal(misplaced.status, 422);
  // Idempotent replay of the same request returns the same event; a changed one conflicts.
  const again = await request("/api/rooms/commons/work-sessions", { method: "POST", token: ownerKey,
    data: sessionBody({ requestId: stopId, action: "set_status", status: "done", outputs: ["msg:done-1"], expectedRevision: 1 }) });
  assert.equal(again.status, 200);
  const conflict = await request("/api/rooms/commons/work-sessions", { method: "POST", token: ownerKey,
    data: sessionBody({ requestId: stopId, action: "set_status", status: "done", outputs: ["msg:different"], expectedRevision: 1 }) });
  assert.equal(conflict.status, 409);
});

// RC-2026-09-19-063: round limits pause rather than stop; usage reports are
// monotonic; the applier guards the owner-approval gate on replay.
test("roundLimitExceeded reads the pending count; reportRounds/reportToolCalls never rewind", () => {
  const item = { id: "w", title: "T", state: "accepted", revision: 0, accountableMemberId: "a",
    status: "active", budget: { maxRounds: 3 }, round_count: 2, tool_calls: 4 };
  assert.equal(roundLimitExceeded(item), false);
  assert.equal(roundLimitExceeded(item, 3), false, "at the limit is not over it");
  assert.equal(roundLimitExceeded(item, 4), true);
  assert.equal(roundLimitExceeded({ ...item, status: "done" }, 99), false, "terminal sessions are exempt");
  assert.equal(roundLimitExceeded({ ...item, budget: null }, 99), false, "no declared limit is not a limit");
  reportRounds(item, { data: { rounds: 1 } });
  reportToolCalls(item, { data: { toolCalls: 2 } });
  assert.equal(item.round_count, 2, "stale reports do not rewind rounds");
  assert.equal(item.tool_calls, 4, "stale reports do not rewind tool calls");
  reportRounds(item, { data: { rounds: 9 } });
  reportToolCalls(item, { data: { toolCalls: 11 } });
  assert.equal(item.round_count, 9);
  assert.equal(item.tool_calls, 11);
  assert.throws(() => reportRounds(item, { data: { rounds: -1 } }), /non-negative/);
  assert.throws(() => reportToolCalls(item, { data: { toolCalls: 1.5 } }), /non-negative/);
});

test("a round-limit pause records its reason; resume without approval is refused on replay", () => {
  const item = { id: "w", title: "T", state: "accepted", revision: 0, accountableMemberId: "a", status: "processing" };
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STATUS_CHANGED, actorId: "agent",
    at: "2026-09-10T21:00:00.000Z", data: { status: "suspended", suspendReason: "round_limit" } });
  assert.equal(item.status, "suspended");
  assert.equal(sessionRecord(item).suspended_by, "round_limit");
  // The worker's own resume is refused even if the event log were tampered with.
  assert.throws(() => applySessionFields(item, { type: SESSION_EVENT_TYPES.STATUS_CHANGED, actorId: "agent",
    at: "2026-09-10T21:01:00.000Z", data: { status: "active" } }), /owner approval/);
  // An approved resume clears the pause with a fresh round count and keeps the worker.
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STATUS_CHANGED, actorId: "owner",
    at: "2026-09-10T21:02:00.000Z", data: { status: "active", resumeApproved: true, rounds: 7 } });
  const record = sessionRecord(item);
  assert.equal(record.status, "active");
  assert.equal(record.suspended_by, null);
  assert.equal(record.round_count, 0, "the approved resume restarts the round count");
  assert.equal(record.worker_member_id, "agent", "the paused worker keeps the session");
  // A non-round-limit suspendReason is rejected at the gate.
  assert.throws(() => applySessionFields({ ...item, status: "processing" },
    { type: SESSION_EVENT_TYPES.STATUS_CHANGED, actorId: "agent", at: "2026-09-10T21:03:00.000Z",
      data: { status: "suspended", suspendReason: "lunch" } }), /suspendReason/);
});
