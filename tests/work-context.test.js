import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { RoomAgentClient, workContextMarkdown } from "../client/room-agent.mjs";
import { selectedWorkContext, WORK_CONTEXT_OMISSIONS } from "../server/work-context.mjs";
import { verifyAccessSummary } from "../src/client.js";
import { nextWorkStep, workActions } from "../src/workflow.js";
import { EVENT_TYPES as T } from "../src/events.js";
import { workContinuity, SESSION_HEARTBEAT_STALE_MS } from "../src/work-item-session.js";
import { initialRoom } from "../server/bootstrap.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = actor => new RoomAgentClient({ origin, roomId: "commons", token: f.keys[actor] });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  const view = (actor = "producer", options) => f.store.workContext(f.keys[actor], "commons", "test-handoff", options);
  const signEvidence = makeTestSigner(f.store);
  return { ...f, origin, client, send, view, signEvidence };
}

test("selected context is one authenticated read with current actor/gates and explicit context omissions", async t => {
  const f = await fixture(t);
  f.send("owner", T.MESSAGE_POSTED, { messageId: "unrelated", body: "UNRELATED-CONTEXT-SENTINEL" });
  f.send("owner", T.WORK_PROPOSED, { workItemId: "another", title: "UNRELATED-WORK-SENTINEL", definitionOfDone: "Unrelated", accountableMemberId: "owner", mode: "read" });
  f.store.reminders.mutate(f.keys.owner, "commons", { requestId: crypto.randomUUID(), workItemId: "test-handoff", expectedRevision: 0, action: "schedule", dueAt: Date.now() + 60000 });
  const snapshot = f.store.snapshot(f.keys.owner, "commons"), reminders = f.store.reminders.list(f.keys.owner, "commons");
  let reads = 0;
  const transaction = f.store.readTransaction.bind(f.store);
  f.store.readTransaction = callback => { reads++; return transaction(callback); };
  const context = f.view();
  assert.equal(reads, 1);
  assert.equal(context.viewer.id, "producer"); assert.equal(context.viewerId, "producer");
  assert.equal(context.next.action, "accept"); assert.equal(context.next.addressedToViewer, true);
  assert.deepEqual(context.suggestedActions.map(action => action.action), ["accept"]);
  assert.equal(context.context.source.status, "not_requested"); assert.equal(context.context.source.message, null);
  for (const key of ["receiptHistory", "verificationHistory", "decisionHistory"]) assert.equal(Object.hasOwn(context.work, key), false);
  for (const key of ["cursor", "state", "eventLog", "messages", "reminders"]) assert.equal(Object.hasOwn(context, key), false);
  assert.equal(JSON.stringify(context).includes("UNRELATED-"), false);
  assert.equal(context.scope.membership, "room"); assert.equal(context.scope.externalExecution, false);
  assert.match(context.scope.guidance, /not authority/);
  const selected = f.view("producer", { includeSource: true });
  assert.deepEqual(selected.context.source.message, { id: "test-request", authorId: "guest", body: snapshot.state.messages.find(message => message.id === "test-request").body,
    createdAt: snapshot.state.messages.find(message => message.id === "test-request").createdAt });
  assert.equal(selected.context.source.status, "included");
  assert.ok(selected.context.participants.some(member => member.id === "guest"));
  assert.equal(f.view("reviewer").next.addressedToViewer, false);
  assert.deepEqual(f.view("guest").suggestedActions, []);
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), snapshot);
  assert.deepEqual(f.store.reminders.list(f.keys.owner, "commons").reminders, reminders.reminders);
  // No nested returned object can mutate the stored projection by reference.
  selected.viewer.permissions.push("invented"); selected.work.title = "mutated";
  assert.equal(f.view().viewer.permissions.includes("invented"), false);
  assert.notEqual(f.view().work.title, "mutated");
  const reopened = new RoomStore(`${f.directory}/room.sqlite`, { readOnly: true });
  try {
    const retained = reopened.workContext(f.keys.producer, "commons", "test-handoff", { includeSource: true });
    assert.deepEqual(retained.work, context.work);
    assert.deepEqual(retained.context.source, f.view("producer", { includeSource: true }).context.source);
    assert.equal(retained.evaluatedThrough, context.evaluatedThrough);
  } finally { reopened.close(); }
});

test("projection uses one explicit clock and exact source IDs without guessing or hidden histories", async t => {
  const f = await fixture(t), snapshot = f.store.snapshot(f.keys.owner, "commons");
  const state = structuredClone(snapshot.state), item = state.workItems["test-handoff"];
  item.mode = "write"; item.state = "accepted";
  item.claim = { holderId: "producer", status: "active", expiresAt: new Date(2000).toISOString(), privateExtra: "OMIT-NESTED-SENTINEL" };
  state.members.producer.permissions.push("write_external");
  const project = (now, options = {}) => selectedWorkContext({ state, workItemId: item.id, viewerId: "producer", sequence: snapshot.sequence, now, ...options });
  for (const now of [1999, 2000]) {
    const context = project(now);
    assert.deepEqual(context.next, { ...nextWorkStep(item, now), addressedToViewer: true });
    assert.deepEqual(context.suggestedActions, workActions(item, state.members.producer, now).map(([action, label]) => ({ action, label })));
    assert.equal(context.evaluatedAt, new Date(now).toISOString());
    assert.equal(context.next.action, now === 1999 ? "start" : "claim");
    assert.equal(JSON.stringify(context).includes("OMIT-NESTED-SENTINEL"), false);
  }
  state.members.producer.permissions = [];
  assert.equal(project(1999).next.addressedToViewer, true);
  assert.deepEqual(project(1999).suggestedActions.map(action => action.action), ["release", "renew"], "holder may release or renew scope, but assignment never grants start/completion");
  item.sourceMessageId = "missing-id";
  assert.equal(project(2000, { includeSource: true }).context.source.status, "unavailable");
  item.sourceMessageId = null;
  assert.equal(project(2000, { includeSource: true }).context.source.status, "not_linked");
  item.supersededBy = "another";
  assert.equal(project(2000).next.action, "superseded"); assert.deepEqual(project(2000).suggestedActions, []);
});

test("selected handoff tracks exact corrections/reviews while preserving human decision and stale revision checks", async t => {
  const f = await fixture(t), producer = f.client("producer"), reviewer = f.client("reviewer");
  const mutate = async (client, type, data = {}) => {
    const context = await client.workContext("test-handoff");
    return client.command({ id: crypto.randomUUID(), type, data: { workItemId: context.work.id, expectedRevision: context.work.revision, ...data } });
  };
  const stale = await producer.workContext("test-handoff");
  f.send("owner", T.MESSAGE_POSTED, { body: "Unrelated activity does not change the work revision." });
  await producer.command({ id: crypto.randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId: stale.work.id, expectedRevision: stale.work.revision } });
  await assert.rejects(producer.command({ id: crypto.randomUUID(), type: T.WORK_STARTED, data: { workItemId: stale.work.id, expectedRevision: stale.work.revision } }), error => error.status === 409);
  await mutate(producer, T.WORK_STARTED);
  assert.equal((await producer.workContext("test-handoff")).next.needsAttention, false);
  const complete = version => mutate(producer, T.WORK_COMPLETED, { summary: "Synthetic evidence", evidenceUrl: "https://example.invalid/synthetic", evidenceVersion: version, producerId: "producer", nextAction: "Review exact version", signedEvidence: f.signEvidence() });
  await complete("v1");
  let context = await reviewer.workContext("test-handoff");
  assert.equal(context.next.action, "verify"); assert.equal(context.next.addressedToViewer, true);
  await mutate(reviewer, T.VERIFICATION_RECORDED, { result: "fail", completionEventId: context.work.receipt.eventId, evidenceVersion: "v1", summary: "Synthetic correction needed", nextAction: "Revise" });
  assert.equal((await producer.workContext("test-handoff")).work.blocker.reason, "Synthetic correction needed");
  await mutate(producer, T.WORK_BLOCKER_RESOLVED, { resolution: "Understood" }); await complete("v2");
  context = await reviewer.workContext("test-handoff");
  assert.equal(context.work.verification, null); assert.equal(context.work.decision, null);
  assert.equal(context.next.evidenceVersion, "v2");
  await mutate(reviewer, T.VERIFICATION_RECORDED, { result: "pass", completionEventId: context.work.receipt.eventId, evidenceVersion: "v2", summary: "Synthetic current check" });
  const ownerView = await f.client("owner").workContext("test-handoff");
  assert.equal(ownerView.next.action, "decide"); assert.equal(ownerView.next.addressedToViewer, true);
  assert.equal(ownerView.work.decision, null);
  assert.equal((await reviewer.workContext("test-handoff")).suggestedActions.some(action => action.action === "decide"), false);
  await mutate(producer, T.WORK_BLOCKED, { reason: "Explicit new correction", nextAction: "Revise again" });
  const reopened = await producer.workContext("test-handoff");
  assert.equal(reopened.work.verification.result, "pass", "prior exact receipt remains inspectable during rework");
  assert.equal(reopened.next.action, "revise", "retained PASS does not hide the current blocker");
  assert.equal(reopened.work.decision, null);
  await mutate(producer, T.WORK_BLOCKER_RESOLVED, { resolution: "New correction understood" });
  assert.equal((await producer.workContext("test-handoff")).next.action, "start");
  await complete("v3");
  const latest = await reviewer.workContext("test-handoff");
  assert.equal(latest.work.verification, null); assert.equal(latest.work.decision, null);
  assert.equal(latest.next.action, "verify"); assert.equal(latest.next.evidenceVersion, "v3");
});

test("HTTP selected reads enforce authentication, exact query, binding, cache policy and ID scope", async t => {
  const f = await fixture(t), base = f.origin + "/api/rooms/commons/work-context";
  const headers = { Authorization: `Bearer ${f.keys.producer}` };
  const response = await fetch(base + "?workItemId=test-handoff", { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).viewerId, "producer");
  for (const query of ["", "?workItemId=__proto__", "?workItemId=test-handoff&workItemId=another", "?workItemId=test-handoff&includeSource=1", "?workItemId=test-handoff&viewerId=owner", "?workItemId=test-handoff&includeSource=true&includeSource=false"]) {
    assert.equal((await fetch(base + query, { headers })).status, 422, query);
  }
  assert.equal((await fetch(base + "?workItemId=missing", { headers })).status, 404);
  assert.equal((await fetch(base + "?workItemId=test-handoff")).status, 401);
  assert.equal((await fetch(f.origin + "/api/rooms/elsewhere/work-context?workItemId=test-handoff", { headers })).status, 403);
  f.send("owner", T.WORK_PROPOSED, { workItemId: "task:with.punctuation-1", title: "Punctuation", definitionOfDone: "Read exact ID", accountableMemberId: "producer", mode: "read" });
  assert.equal((await f.client("producer").workContext("task:with.punctuation-1")).work.id, "task:with.punctuation-1");
  const roomId = "room:with.punctuation-1";
  f.store.initialize(initialRoom(roomId));
  const key = f.store.issueAccessKey(roomId, "owner");
  const otherRoom = new RoomAgentClient({ origin: f.origin, roomId, token: key });
  await otherRoom.command({ id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "selected:one", title: "Selected", definitionOfDone: "Read the configured Room", accountableMemberId: "owner", mode: "read" } });
  assert.equal((await otherRoom.workContext("selected:one")).roomId, roomId);
  assert.equal((await otherRoom.snapshot()).roomId, roomId);
  const session = f.store.createSession(f.keys.owner);
  assert.equal((await fetch(base + "?workItemId=test-handoff", { headers: { Cookie: `room_session=${session.token}`, "X-Session-Binding": "f".repeat(64) } })).status, 409);
  f.store.revoke(f.keys.producer);
  await assert.rejects(f.client("producer").workContext("test-handoff"), error => error.status === 401);
});

test("selected client does exactly one cancellable GET and rejects mismatched context before returning it", async t => {
  const f = await fixture(t), calls = [], token = "a".repeat(43), result = f.view();
  let response = result;
  const client = new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: "commons", token, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => response };
  } });
  const controller = new AbortController();
  await client.workContext("test-handoff", { signal: controller.signal });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "GET");
  assert.equal(new URL(calls[0].url).pathname, "/api/rooms/commons/work-context");
  assert.equal(calls[0].options.credentials, "omit"); assert.equal(calls[0].options.redirect, "error");
  controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  for (const changed of [{ roomId: "elsewhere" }, { work: { ...result.work, id: "other" } }, { viewerId: "other" },
    { next: { ...result.next, workRevision: 999 } }, { context: { source: { status: "included", message: { body: "unexpected" } } } }]) {
    response = { ...result, ...changed };
    await assert.rejects(client.workContext("test-handoff"), error => error.code === "invalid_response");
  }
  const included = f.view("producer", { includeSource: true });
  response = included;
  await client.workContext("test-handoff", { includeSource: true });
  for (const source of [null, { status: "not_requested", message: null }, { status: "unavailable", message: included.context.source.message },
    { status: "included", message: { ...included.context.source.message, id: "different" } }, { status: "included", message: null }]) {
    response = { ...included, context: { ...included.context, source } };
    await assert.rejects(client.workContext("test-handoff", { includeSource: true }), error => error.code === "invalid_response");
  }
  const prior = calls.length;
  for (const options of [{ includeSource: "yes" }, { viewerId: "owner" }, null, []]) await assert.rejects(client.workContext("test-handoff", options));
  await assert.rejects(client.workContext("../other"));
  assert.equal(calls.length, prior, "invalid inputs never reach the network");
  assert.equal(JSON.stringify(client).includes(token), false);
  assert.equal(calls.some(call => call.url.includes(token) || call.url.includes("example.invalid")), false);
});

test("work CLI prints one selected context and rejects extra arguments without disclosing keys", async t => {
  const f = await fixture(t);
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", ...args], { env: { ...process.env, ROOM_AGENT_ORIGIN: f.origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_TOKEN: f.keys.producer } });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
  for (const flags of [[], ["--include-source"], ["--include-offers"], ["--include-source", "--include-offers"], ["--include-offers", "--include-source"]]) {
    const args = ["work", "test-handoff", ...flags];
    const result = await run(args); assert.equal(result.code, 0, result.stderr);
    const context = JSON.parse(result.stdout); assert.equal(context.work.id, "test-handoff");
    assert.equal(context.context.source.status, flags.includes("--include-source") ? "included" : "not_requested");
    assert.equal(context.offerContextVersion, flags.includes("--include-offers") ? 1 : undefined);
    assert.equal(result.stdout.includes(f.keys.producer), false);
  }
  for (const args of [["work"], ["packet"], ["packet", "../other"], ["work", "test-handoff", "--includeSource"], ["work", "test-handoff", "--include-source", "extra"], ["work", "../other"],
    ["work", "test-handoff", "--include-offers", "--include-offers"], ["work", "test-handoff", "--include-source", "--include-source"]]) {
    const result = await run(args); assert.equal(result.code, 1); assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "usage_error"); assert.equal(result.stderr.includes(f.keys.producer), false);
  }
  const compact = await run(["work", "test-handoff", "--brief"]);
  assert.equal(compact.code, 0, compact.stderr);
  assert.match(compact.stdout, /Current progress/);
  assert.match(compact.stdout, /Accept the assignment/);
  assert.equal(compact.stdout.includes("Please prepare an agenda"), false);
  assert.equal(compact.stdout.includes(f.keys.producer), false);
  const compactSource = await run(["work", "test-handoff", "--brief", "--include-source"]);
  assert.equal(compactSource.code, 0, compactSource.stderr);
  assert.match(compactSource.stdout, /Please prepare an agenda/);
  const guide = readFileSync(new URL("../docs/WORK-CONTEXT.md", import.meta.url), "utf8");
  const code = guide.match(/<!-- work-context-example -->\n```js\n([\s\S]*?)\n```/)[1];
  const read = new (Object.getPrototypeOf(async function () {}).constructor)("client", "workId", code + "\nreturn { context, work, source }; ");
  const example = await read(f.client("producer"), "test-handoff");
  assert.equal(example.work.id, "test-handoff"); assert.equal(example.source.id, "test-request");
});

test("access summary lists only what the member can read; quoted mentions and imported messages add nothing; omissions match the report", async t => {
  const f = await fixture(t);
  // A quoted @mention of the accountable agent replying to the source, and an inbox-style excerpt import (server/inbox.mjs command id shape).
  f.send("owner", T.MESSAGE_POSTED, { messageId: "quoted-mention", replyToId: "test-request", body: "@Test producer please take test-handoff: QUOTED-MENTION-SENTINEL" });
  f.store.command(f.keys.owner, "commons", { id: "inbox-" + "a".repeat(24), type: T.MESSAGE_POSTED, data: { messageId: "excerpt-import", body: "IMPORTED-EXCERPT-SENTINEL" } });
  const context = f.view(), summary = context.accessSummary;
  assert.equal(summary.version, 1); assert.equal(summary.membership, "room");
  assert.deepEqual(summary.conversation, { scope: "linked_source_message", sourceMessageIds: ["test-request"], sourceAvailability: "available", deliveredByDefault: false,
    excluded: ["thread", "replies", "mentions", "imported_messages", "other_messages"] });
  assert.deepEqual(summary.omitted, context.context.omitted, "the preview repeats the exact omissions the read reports");
  assert.deepEqual(summary.omitted, [...WORK_CONTEXT_OMISSIONS]);
  assert.deepEqual(summary.evidence, { records: [], retrieved: false });
  assert.deepEqual(summary.budget, { maxRuntimeMs: "unknown", maxAttempts: "unknown", maxConcurrent: "unknown", maxSpendCents: "unknown", maxRounds: "unknown", maxToolCalls: "unknown", spendCents: "unknown", attemptCount: 0, sessionStatus: "queued" });
  assert.equal(summary.externalExecution, false); assert.equal(summary.credentials, "none");
  const text = JSON.stringify(summary);
  for (const leak of ["SENTINEL", "quoted-mention", "excerpt-import", "UNRELATED"]) assert.equal(text.includes(leak), false, leak);
  // Every listed record is one the requesting member can already read through the room projection.
  const snapshot = f.store.snapshot(f.keys.producer, "commons");
  for (const id of summary.conversation.sourceMessageIds) assert.ok(snapshot.state.messages.some(message => message.id === id));
  assert.deepEqual([...summary.participantIds].sort(), context.context.participants.map(person => person.id).sort());
  for (const id of summary.participantIds) assert.ok(Object.hasOwn(snapshot.state.members, id));
  // Membership is room-wide: a permissionless guest sees the same scope, and the summary is neither wider nor a per-member grant.
  const { participantIds: guestParticipants, ...guestSummary } = f.view("guest").accessSummary;
  const { participantIds, ...producerSummary } = summary;
  assert.deepEqual(guestSummary, producerSummary); assert.ok(guestParticipants.includes("guest")); assert.ok(participantIds.includes("producer"));
  // Budget and evidence follow the current records exactly, never assumed.
  const revision = () => f.store.snapshot(f.keys.owner, "commons").state.workItems["test-handoff"].revision;
  f.send("producer", T.WORK_ACCEPTED, { workItemId: "test-handoff", expectedRevision: revision() });
  f.store.mutateWorkSession(f.keys.producer, "commons", { requestId: crypto.randomUUID(), workItemId: "test-handoff", expectedRevision: revision(), action: "set_status", status: "processing", budget: { maxSpendCents: 500, maxAttempts: 2 } });
  const budget = f.view().accessSummary.budget;
  assert.deepEqual(budget, { maxRuntimeMs: "unknown", maxAttempts: 2, maxConcurrent: "unknown", maxSpendCents: 500, maxRounds: "unknown", maxToolCalls: "unknown", spendCents: "unknown", attemptCount: 1, sessionStatus: "processing" });
  f.send("producer", T.WORK_STARTED, { workItemId: "test-handoff", expectedRevision: revision() });
  f.send("producer", T.WORK_COMPLETED, { workItemId: "test-handoff", expectedRevision: revision(), summary: "Synthetic evidence", evidenceUrl: "https://example.invalid/synthetic", evidenceVersion: "v1", producerId: "producer", nextAction: "Review exact version", signedEvidence: f.signEvidence() });
  const completed = f.view();
  assert.deepEqual(completed.accessSummary.evidence, { records: [{ record: "receipt", evidenceVersion: "v1", evidenceUrl: "https://example.invalid/synthetic" }], retrieved: false });
  assert.equal(completed.accessSummary.evidence.records[0].evidenceVersion, completed.work.receipt.evidenceVersion);
  // A deleted source keeps only its tombstone id; a missing or unlinked source lists no message at all.
  f.send("owner", T.MESSAGE_DELETED, { messageId: "test-request", expectedMessageRevision: 0 });
  assert.deepEqual(f.view().accessSummary.conversation.sourceMessageIds, ["test-request"]);
  assert.equal(f.view().accessSummary.conversation.sourceAvailability, "deleted");
  const state = structuredClone(snapshot.state), item = state.workItems["test-handoff"];
  const conversation = () => selectedWorkContext({ state, workItemId: item.id, viewerId: "producer", sequence: snapshot.sequence, now: 2000 }).accessSummary.conversation;
  item.sourceMessageId = "missing-id";
  assert.deepEqual([conversation().scope, conversation().sourceMessageIds, conversation().sourceAvailability], ["linked_source_message", [], "unavailable"]);
  item.sourceMessageId = null;
  assert.deepEqual([conversation().scope, conversation().sourceMessageIds, conversation().sourceAvailability], ["none", [], "not_linked"]);
  // The browser client accepts exactly this shape and rejects a widened or mismatched preview before rendering it.
  assert.equal(verifyAccessSummary(completed, { roomId: "commons", workItemId: "test-handoff" }), completed.accessSummary);
  const tampered = change => ({ ...completed, accessSummary: { ...completed.accessSummary, ...change } });
  for (const bad of [
    { omitted: completed.accessSummary.omitted.slice(1) },
    { conversation: { ...completed.accessSummary.conversation, sourceMessageIds: ["test-request", "quoted-mention"] } },
    { conversation: { ...completed.accessSummary.conversation, deliveredByDefault: true } },
    { evidence: { records: [{ record: "receipt", evidenceVersion: "v2", evidenceUrl: null }], retrieved: false } },
    { evidence: { ...completed.accessSummary.evidence, retrieved: true } },
    { budget: { ...completed.accessSummary.budget, maxSpendCents: "unlimited" } },
    { credentials: "room_key" }, { externalExecution: true }, { membership: "task" }
  ]) assert.throws(() => verifyAccessSummary(tampered(bad), { roomId: "commons", workItemId: "test-handoff" }), error => error.code === "invalid_response");
  assert.throws(() => verifyAccessSummary(completed, { roomId: "commons", workItemId: "another" }), error => error.code === "invalid_response");
  assert.throws(() => verifyAccessSummary({ ...completed, accessSummary: undefined }, { roomId: "commons", workItemId: "test-handoff" }), error => error.code === "invalid_response");
  assert.throws(() => verifyAccessSummary({ ...completed, evaluatedAt: "later" }, { roomId: "commons", workItemId: "test-handoff" }), error => error.code === "invalid_response");
});


test("restart brief follows the persisted handoff without acknowledging, assigning or completing work", async t => {
  const f = await fixture(t);
  f.send("producer", T.WORK_ACCEPTED, { workItemId: "test-handoff", expectedRevision: 0 });
  f.send("producer", T.WORK_HANDOFF_RECORDED, { workItemId: "test-handoff", expectedRevision: 1,
    doneSummary: "Implemented the first parser", nextAction: "Check escaped separators", limitReason: "Session ending" });
  const before = f.store.snapshot(f.keys.owner, "commons");
  const context = await f.client("producer").workContext("test-handoff");
  assert.equal(context.resume.reportedProgress, "Implemented the first parser");
  assert.equal(context.resume.handoff.nextAction, "Check escaped separators");
  assert.equal(context.resume.next.action, "triaged_handoff");
  assert.equal(context.resume.next.memberId, "owner");
  assert.equal(context.resume.authority, "context_only");
  assert.equal(context.resume.result, null);
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), before);
  const tampered = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.keys.producer,
    fetchImpl: async () => new Response(JSON.stringify({ ...context, resume: { ...context.resume, next: { action: "complete" } } }), { status: 200 }) });
  await assert.rejects(tampered.workContext("test-handoff"), error => error.code === "invalid_response");
});

// The selected HTTP/SDK boundary must retain the browser's worker state while
// excluding attempt logs. Session unit tests cannot catch a lossy read projection.
test("selected resume preserves worker continuity without exposing attempt history", async t => {
  const f = await fixture(t), client = f.client("producer");
  let now = Date.now(); f.store.now = () => now;
  const item = () => f.store.snapshot(f.keys.owner, "commons").state.workItems["test-handoff"];
  const mutate = (data, actor = "producer") => f.store.mutateWorkSession(f.keys[actor], "commons", {
    requestId: crypto.randomUUID(), workItemId: "test-handoff", expectedRevision: item().revision, ...data
  });
  const read = async expected => {
    const before = f.store.snapshot(f.keys.producer, "commons");
    const result = await client.workContext("test-handoff");
    assert.equal(result.resume.continuity?.state ?? null, expected);
    assert.deepEqual(result.resume.continuity, workContinuity(before.state.workItems["test-handoff"], now));
    assert.deepEqual(result.context.omitted, [...WORK_CONTEXT_OMISSIONS]);
    assert.equal(result.context.source.status, "not_requested");
    for (const key of ["attempts", "receiptHistory", "verificationHistory", "decisionHistory", "worker_member_id"])
      assert.equal(Object.hasOwn(result.work, key), false, key);
    for (const omitted of ["ATTEMPT-ENVIRONMENT-SENTINEL", "ATTEMPT-OUTPUT-SENTINEL", "UNRELATED-MESSAGE-SENTINEL", f.keys.producer])
      assert.equal(JSON.stringify(result).includes(omitted), false, omitted);
    assert.deepEqual(f.store.snapshot(f.keys.producer, "commons"), before, "reading neither starts nor acknowledges work");
    return result;
  };
  f.send("owner", T.MESSAGE_POSTED, { messageId: "continuity-unrelated", body: "UNRELATED-MESSAGE-SENTINEL" });
  await read(null); // Never-started work is not an unresponsive worker.
  mutate({ action: "set_status", status: "processing", environment: "ATTEMPT-ENVIRONMENT-SENTINEL" });
  const running = await read("running");
  assert.equal(running.resume.continuity.attempt, 1);
  now += SESSION_HEARTBEAT_STALE_MS + 1;
  const stale = await read("unknown");
  assert.match(workContextMarkdown(stale), /Process state is unknown/);
  mutate({ action: "request_stop" }, "owner");
  const stopping = await read("stopping");
  assert.equal(stopping.work.status, "processing");
  assert.match(workContextMarkdown(stopping), /Stop requested/);
  assert.match(workContextMarkdown(stopping), /Confirm the worker stopped/);
  mutate({ action: "set_status", status: "failed", outputs: ["ATTEMPT-OUTPUT-SENTINEL"] });
  const failed = await read("interrupted");
  assert.match(workContextMarkdown(failed), /Run interrupted/);
  mutate({ action: "set_status", status: "processing" });
  const restarted = await read("running");
  assert.equal(restarted.resume.continuity.attempt, 2);
  assert.equal(restarted.work.stop_requested_at, null);
  mutate({ action: "set_status", status: "suspended" });
  const paused = await read("paused");
  assert.match(workContextMarkdown(paused), /Run paused/);
  mutate({ action: "set_status", status: "done" });
  const finished = await read("finished");
  assert.match(workContextMarkdown(finished), /Run finished/);
  assert.notEqual(finished.work.state, "completed", "session completion is not work-result approval");
  mutate({ action: "set_status", status: "processing", budget: { maxRounds: 1 } });
  assert.throws(() => mutate({ action: "set_status", status: "active", rounds: 2 }), error => error.code === "round_limit_exceeded");
  const roundPaused = await read("paused");
  assert.equal(roundPaused.work.suspended_by, "round_limit");
  assert.match(workContextMarkdown(roundPaused), /next mention or post resumes this run/);
});
