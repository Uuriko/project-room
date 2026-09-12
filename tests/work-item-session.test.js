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
  SESSION_STATUSES, SESSION_EVENT_TYPES, sessionRecord, sessionCommandType,
  listWorkItemSessions, workItemSessionContract, applySessionFields, sessionWorker,
  SESSION_HEARTBEAT_STALE_MS
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
    started_at: null, attempt_count: 0, budget: null, spend_cents: null });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, at: "2026-09-10T21:00:00.000Z" });
  assert.equal(item.status, SESSION_STATUSES.PROCESSING);
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STATUS_CHANGED, at: "2026-09-10T21:01:00.000Z", data: { status: "active" } });
  assert.equal(item.status, SESSION_STATUSES.ACTIVE);
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOP_REQUESTED, at: "2026-09-10T21:02:00.000Z" });
  assert.equal(item.stop_requested_at, "2026-09-10T21:02:00.000Z");
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, at: "2026-09-10T21:03:00.000Z", data: { status: "done" } });
  assert.equal(item.status, SESSION_STATUSES.DONE);
  assert.throws(() => applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, at: "2026-09-10T21:04:00.000Z" }), /Invalid session/);
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
    started_at: null, attempt_count: 0, budget: null, spend_cents: null });
  const next = applyEvent(state, {
    id: "session-seed-start", idempotencyKey: "session-seed-start", roomId: state.room.id,
    type: T.SESSION_STARTED, actorId: "codex", at: "2026-09-10T21:10:00.000Z",
    data: { workItemId: "work-spec-review", expectedRevision: review.revision }
  });
  assert.equal(next.workItems["work-spec-review"].status, "processing");
  assert.equal(next.workItems["work-spec-review"].state, "completed");
  assert.equal(next.workItems["work-spec-review"].revision, review.revision + 1);
});

test("HTTP lists by status, sets status, and Stop writes stop_requested_at plus Event", async t => {
  const { store, request, ownerKey, agentKey } = await serve(t);
  const contract = await request("/api/work-item-sessions");
  assert.equal(contract.status, 200);
  assert.deepEqual(await contract.json(), workItemSessionContract());
  assert.equal((await request("/api/work-item-sessions", { method: "HEAD" })).status, 200);

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
  assert.equal(store.storagePlatform.version(store.db), 27);
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
