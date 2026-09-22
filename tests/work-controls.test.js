// RC-2026-09-19-063 — agent-work controls: loop/round limits with owner-gated
// resume, tool-call budgets, idempotency proof, and fact/inference/proposal
// result segments.
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
import { validateResultSegments } from "../src/work-packet.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-work-controls-"));
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
  const feed = async token => (await request("/api/rooms/commons/notifications", { token })).json;
  const send = (token, type, data, id = randomUUID()) => store.command(token, "commons", { id, type, data });
  return { store, origin, ownerKey, agentKey, propose, claim, mutate, card, request, feed, send, signEvidence: makeTestSigner(store) };
}

test("round limit: reporting past maxRounds auto-suspends; the pause is recorded, not silent", async t => {
  const { propose, claim, mutate, card } = await serve(t);
  const workItemId = propose("loopy run");
  assert.equal((await claim(workItemId, { budget: { maxRounds: 3 } })).status, 201);
  const session = await card(workItemId);
  assert.deepEqual(session.budget.maxRounds, 3);
  assert.equal(session.rounds, 0);
  // Under the cap: reports land and the session continues.
  assert.equal((await mutate(workItemId, session.revision, { status: "active", rounds: 2 })).status, 201);
  assert.equal((await card(workItemId)).rounds, 2);
  // Over the cap: the session is paused by the room, and the caller is told why.
  const over = await mutate(workItemId, session.revision + 1, { status: "active", rounds: 4 });
  assert.equal(over.status, 409);
  assert.equal(over.json?.error?.code, "round_limit_exceeded");
  const paused = await card(workItemId);
  assert.equal(paused.status, "suspended", "the over-round session was auto-paused, not merely rejected");
  assert.equal(paused.suspendedBy, "round_limit");
  assert.equal(paused.rounds, 2, "the rejected report does not rewrite history");
  assert.equal(paused.worker_member_id, "agent", "the worker is retained through the pause");
});

test("round limit: the worker cannot self-resume; the owner resumes and the round count resets", async t => {
  const { propose, claim, mutate, card, request, ownerKey, agentKey } = await serve(t);
  const workItemId = propose("paused run");
  assert.equal((await claim(workItemId, { budget: { maxRounds: 1 } })).status, 201);
  const paused = await card(workItemId);
  assert.equal((await mutate(workItemId, paused.revision, { status: "active", rounds: 5 })).status, 409);
  const stuck = await card(workItemId);
  assert.equal(stuck.status, "suspended");
  // The worker's own resume is rejected.
  const selfResume = await mutate(workItemId, stuck.revision, { status: "active" });
  assert.equal(selfResume.status, 409);
  assert.equal(selfResume.json?.error?.code, "round_limit_exceeded");
  // The room owner resumes: 201, a fresh round count, the worker unchanged.
  const resume = await mutate(workItemId, stuck.revision, { status: "active" }, ownerKey);
  assert.equal(resume.status, 201, JSON.stringify(resume.json));
  const resumed = await card(workItemId);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.suspendedBy, null);
  assert.equal(resumed.rounds, 0, "resume restarts the round count");
  assert.equal(resumed.worker_member_id, "agent", "the paused worker keeps the session");
  // The worker can report again after the approved resume.
  assert.equal((await mutate(workItemId, resumed.revision, { status: "processing", rounds: 1 })).status, 201);
  // The pause and the owner resume are in the event log.
  const events = await request("/api/rooms/commons/events", { token: agentKey });
  const rows = (events.json?.events ?? []).map(e => e.event ?? e).filter(e => e.data?.workItemId === workItemId);
  const pause = rows.find(e => e.type === "session.status_changed" && e.data.status === "suspended");
  assert.ok(pause && pause.data.suspendReason === "round_limit");
  const approved = rows.find(e => e.type === "session.status_changed" && e.data.status === "active" && e.data.resumeApproved === true);
  assert.ok(approved, "the owner-approved resume is recorded as such");
});

test("round-limit pause and budget stop notify the room owner", async t => {
  const { propose, claim, mutate, card, feed, ownerKey } = await serve(t);
  const first = propose("paused notify run"), second = propose("stopped notify run");
  assert.equal((await claim(first, { budget: { maxRounds: 1 } })).status, 201);
  assert.equal((await claim(second, { budget: { maxToolCalls: 1 } })).status, 201);
  const paused = await card(first), stopped = await card(second);
  assert.equal((await mutate(first, paused.revision, { status: "active", rounds: 2 })).status, 409);
  assert.equal((await mutate(second, stopped.revision, { status: "active", toolCalls: 9 })).status, 409);
  const ownerFeed = await feed(ownerKey);
  const items = ownerFeed.notifications ?? [];
  const pauseNote = items.find(item => item.workItemId === first && item.kind === "work_update");
  const stopNote = items.find(item => item.workItemId === second && item.kind === "work_update");
  assert.ok(pauseNote, "the owner is told about the round-limit pause");
  assert.ok(stopNote, "the owner is told about the tool-call budget stop");
});

test("tool-call limit: reporting past maxToolCalls force-stops the session like spend", async t => {
  const { propose, claim, mutate, card, request, agentKey } = await serve(t);
  const workItemId = propose("chatty run");
  assert.equal((await claim(workItemId, { budget: { maxToolCalls: 10 } })).status, 201);
  const session = await card(workItemId);
  assert.deepEqual(session.budget.maxToolCalls, 10);
  assert.equal(session.toolCalls, 0);
  // Under the cap: the report lands.
  assert.equal((await mutate(workItemId, session.revision, { status: "active", toolCalls: 8 })).status, 201);
  assert.equal((await card(workItemId)).toolCalls, 8);
  // Over the cap: force-stop, not a pause.
  const over = await mutate(workItemId, session.revision + 1, { status: "active", toolCalls: 11 });
  assert.equal(over.status, 409);
  assert.equal(over.json?.error?.code, "budget_exceeded");
  assert.match(over.json?.error?.message ?? "", /maxToolCalls/);
  const halted = await card(workItemId);
  assert.equal(halted.status, "failed");
  assert.equal(halted.toolCalls, 11, "the tripping report is recorded on the stop");
  const events = await request("/api/rooms/commons/events", { token: agentKey });
  const stop = (events.json?.events ?? []).map(e => e.event ?? e)
    .find(e => e.type === "session.stopped" && e.data?.workItemId === workItemId);
  assert.ok(stop, "a session.stopped event was recorded");
  assert.equal(stop.data.limit, "maxToolCalls");
  assert.equal(stop.data.budgetEnforced, true);
});

test("usage counters are monotonic: stale reports never rewind them", async t => {
  const { propose, claim, mutate, card } = await serve(t);
  const workItemId = propose("steady run");
  assert.equal((await claim(workItemId, {})).status, 201);
  const session = await card(workItemId);
  assert.equal((await mutate(workItemId, session.revision, { status: "active", rounds: 5, toolCalls: 7 })).status, 201);
  assert.equal((await mutate(workItemId, session.revision + 1, { status: "processing", rounds: 3, toolCalls: 2 })).status, 201);
  const after = await card(workItemId);
  assert.equal(after.rounds, 5, "a stale round report does not rewind the counter");
  assert.equal(after.toolCalls, 7, "a stale tool-call report does not rewind the counter");
});

test("accept/complete/record are idempotent: exact retry duplicates, reused IDs conflict", async t => {
  const { store, ownerKey, agentKey, propose, signEvidence } = await serve(t);
  const workItemId = propose("idempotent run");
  const op = randomUUID();
  const accept = { id: op, type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } };
  const first = store.command(agentKey, "commons", accept);
  assert.equal(first.duplicate, false, "the first accept is not a duplicate");
  const retry = store.command(agentKey, "commons", { ...accept });
  assert.equal(retry.duplicate, true, "the exact retry returns duplicate, not a second accept");
  assert.equal(retry.sequence, first.sequence);
  const conflict = { id: op, type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 1 } };
  assert.throws(() => store.command(agentKey, "commons", conflict), error => error?.code === "idempotency_conflict"
    || /idempotency_conflict/.test(error?.message ?? ""), "reusing the ID for different content conflicts");
  // Record (complete) follows the same rule.
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_STARTED, data: { workItemId, expectedRevision: 1 } });
  const recordOp = randomUUID();
  const complete = { id: recordOp, type: T.WORK_COMPLETED,
    data: { workItemId, expectedRevision: 2, summary: "done", evidenceUrl: "https://example.com/out.txt",
      evidenceVersion: "v1", nextAction: "none", signedEvidence: signEvidence() } };
  store.command(agentKey, "commons", complete);
  const recordRetry = store.command(agentKey, "commons", structuredClone(complete));
  assert.equal(recordRetry.duplicate, true, "the exact record retry returns duplicate");
  const recordConflict = { id: recordOp, type: T.WORK_COMPLETED,
    data: { ...complete.data, summary: "done differently" } };
  assert.throws(() => store.command(agentKey, "commons", recordConflict), error => error?.code === "idempotency_conflict");
  void ownerKey;
});

test("fact/inference/proposal segments validate and persist on the completion receipt", async t => {
  const { store, agentKey, propose, signEvidence } = await serve(t);
  const workItemId = propose("segmented run");
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_STARTED, data: { workItemId, expectedRevision: 1 } });
  const segments = [
    { kind: "fact", text: "The endpoint returned 200 on three probes." },
    { kind: "inference", text: "The outage was likely a deploy, not a config change." },
    { kind: "proposal", text: "Add a canary check before the next deploy." }
  ];
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_COMPLETED,
    data: { workItemId, expectedRevision: 2, summary: "done", evidenceUrl: "https://example.com/out.txt",
      evidenceVersion: "v1", nextAction: "none", segments, signedEvidence: signEvidence() } });
  const receipt = store.room("commons").state.workItems[workItemId].receipt;
  assert.deepEqual(receipt.segments, segments, "the validated segments persist on the receipt");
  // The validator accepts the valid set and rejects everything else.
  assert.deepEqual(validateResultSegments(segments), segments);
  assert.equal(validateResultSegments(undefined), null);
  assert.throws(() => validateResultSegments([]), /1–20/);
  assert.throws(() => validateResultSegments(new Array(21).fill({ kind: "fact", text: "x" })), /1–20/);
  assert.throws(() => validateResultSegments([{ kind: "guess", text: "x" }]), /fact, inference, or proposal/);
  assert.throws(() => validateResultSegments([{ kind: "fact", text: "   " }]), /1–2000/);
  assert.throws(() => validateResultSegments([{ kind: "inference", text: "x".repeat(2001) }]), /1–2000/);
});

test("a completion without segments still works: the receipt carries segments null", async t => {
  const { store, agentKey, propose, signEvidence } = await serve(t);
  const workItemId = propose("plain completion");
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_STARTED, data: { workItemId, expectedRevision: 1 } });
  store.command(agentKey, "commons", { id: randomUUID(), type: T.WORK_COMPLETED,
    data: { workItemId, expectedRevision: 2, summary: "done", evidenceUrl: "https://example.com/out.txt",
      evidenceVersion: "v1", nextAction: "none", signedEvidence: signEvidence() } });
  const receipt = store.room("commons").state.workItems[workItemId].receipt;
  assert.equal(receipt.segments, null, "unmarked completions replay with segments null, never guessed");
});

test("legacy projections backfill work-control defaults on replay (no migration)", async t => {
  const { store, propose } = await serve(t);
  const workItemId = propose("legacy item");
  // Simulate a pre-controls stored projection: strip the new fields as the
  // old code would have written them, then rebuild from the event log.
  const room = store.room("commons");
  const item = room.state.workItems[workItemId];
  delete item.round_count; delete item.tool_calls; delete item.suspended_by;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(room.state));
  const rebuilt = store.rebuildProjection("commons");
  const backfilled = rebuilt.state.workItems[workItemId];
  assert.equal(backfilled.round_count, 0);
  assert.equal(backfilled.tool_calls, 0);
  assert.equal(backfilled.suspended_by, null);
});
