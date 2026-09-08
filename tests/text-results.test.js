import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { spawn } from "node:child_process";

async function setup(t) {
  const f = createAcceptanceFixture(), workItemId = "test-handoff", server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, config = { origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const send = (type, data, actor = "producer", id = randomUUID()) => f.store.command(f.keys[actor], "commons", { id, type, data });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const mutate = (type, data = {}, actor) => send(type, { workItemId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const post = (body, extra = {}, actor) => send(T.MESSAGE_POSTED, { messageId: randomUUID(), workItemId, body, ...extra }, actor);
  const input = posted => ({ workItemId, expectedRevision: item().revision, evidenceKind: "room_text", evidenceMessageId: posted.event.data.messageId,
    evidenceMessageEventId: posted.event.id, evidenceVersion: textVersion(posted.event.data.body), previousCompletionEventId: item().receipt?.eventId ?? null,
    producerId: "producer", summary: "An exact room result", nextAction: "Review the stored text" });
  return { ...f, origin, config, client: new RoomAgentClient(config), workItemId, send, item, mutate, post, input };
}

test("native text preserves exact stored UTF-8 and old post/proposal provenance across restart", async t => {
  const f = await setup(t), body = "\uFEFF  Café e\u0301 🪷\r\n\tsecond line  \n";
  const posted = f.post(body, { packetId: "original-packet", basisRevision: 1 }, "guest");
  f.mutate(T.WORK_STARTED);
  for (let i = 0; i < 105; i++) f.send(T.MESSAGE_POSTED, { body: "Unrelated activity" }, "owner");
  assert.equal(f.store.snapshot(f.keys.owner, "commons").state.eventLog.some(event => event.id === posted.event.id), false);
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "guest", permissions: [], expectedMemberRevision: 0, active: false }, "owner");
  const before = auditRecovery(f.store).dataSha256;
  const preview = await f.client.workResult(f.workItemId, { draftMessageId: posted.event.data.messageId });
  assert.equal(preview.result.kind, "draft"); assert.equal(preview.result.text.body, body);
  assert.deepEqual(preview.result.text.proposal, { packetId: "original-packet", basisRevision: 1, submittedAtRevision: 1, attribution: "manual-unverified" });
  assert.equal(auditRecovery(f.store).dataSha256, before);
  const command = { id: "native-original", type: T.WORK_COMPLETED, data: { ...f.input(posted), producerId: null } };
  const saved = f.store.command(f.keys.producer, "commons", command);
  assert.equal(f.item().receipt.nativeText.postedById, "guest"); assert.equal(f.item().receipt.reportedById, "producer"); assert.equal(f.item().receipt.producerId, null);
  const read = await f.client.workResult(f.workItemId);
  assert.equal(read.result.text.body, body); assert.equal(read.result.text.byteLength, Buffer.byteLength(body)); assert.equal(read.result.receipt.eventId, saved.event.id);
  const reopened = new RoomStore(join(f.directory, "room.sqlite"));
  try {
    assert.equal(reopened.workResult(f.keys.producer, "commons", f.workItemId).result.text.body, body);
    assert.equal(reopened.command(f.keys.producer, "commons", command).duplicate, true); assert.equal(auditRecovery(reopened).schemaVersion, 10);
  } finally { reopened.close(); }
  assert.equal((await f.client.snapshot()).cursor, 0);
});

test("native evidence rejects wrong IDs, work, hash, parent and mixed formats without changing data", async t => {
  const f = await setup(t), posted = f.post("Original text"), original = f.input(posted), before = auditRecovery(f.store).dataSha256;
  for (const change of [{ evidenceMessageId: "missing" }, { evidenceMessageEventId: "missing" }, { evidenceMessageEventId: "test-request" },
    { evidenceVersion: textVersion("changed") }, { previousCompletionEventId: "other" }, { evidenceKind: "unknown" }, { evidenceUrl: "https://example.invalid" },
    { producerId: "unknown-member" }]) assert.throws(() => f.mutate(T.WORK_COMPLETED, { ...original, ...change }), { code: "command_rejected" });
  for (const key of ["previousCompletionEventId", "producerId"]) { const data = { ...original }; delete data[key]; assert.throws(() => f.send(T.WORK_COMPLETED, data), { code: "command_rejected" }); }
  assert.equal(auditRecovery(f.store).dataSha256, before);
  const unlinked = f.send(T.MESSAGE_POSTED, { messageId: "unlinked", body: "Only a reply", replyToId: "test-request" });
  assert.throws(() => f.send(T.WORK_COMPLETED, f.input(unlinked)), { code: "command_rejected" });
  await assert.rejects(f.client.workResult(f.workItemId, { draftMessageId: "unlinked" }), { code: "result_unavailable" });
  const malformed = f.post("legacy \uD800");
  assert.throws(() => textVersion(malformed.event.data.body));
  assert.throws(() => f.mutate(T.WORK_COMPLETED, { ...original, evidenceMessageId: malformed.event.data.messageId, evidenceMessageEventId: malformed.event.id }), { code: "command_rejected" });
  assert.notEqual(textVersion("é"), textVersion("e\u0301")); assert.doesNotThrow(() => auditRecovery(f.store));
});

test("external and native lineage share exact version review; same body does not inherit approval", async t => {
  const f = await setup(t), external = f.mutate(T.WORK_COMPLETED, { summary: "Old external", evidenceUrl: "https://example.invalid", evidenceVersion: "external-v1", producerId: "producer", nextAction: "Check" });
  assert.equal((await f.client.workResult(f.workItemId)).result.kind, "external");
  f.mutate(T.WORK_BLOCKED, { reason: "Revise", nextAction: "Write native" }); f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Prepared" });
  const post = f.post("Same exact result"), original = f.input(post), first = f.send(T.WORK_COMPLETED, original, "producer", "first-native");
  assert.equal(f.item().receipt.nativeText.previousCompletionEventId, external.event.id);
  f.mutate(T.VERIFICATION_RECORDED, { result: "pass", completionEventId: first.event.id, evidenceVersion: original.evidenceVersion, summary: "Checked" }, "reviewer");
  f.mutate(T.WORK_BLOCKED, { reason: "Deliberate new version", nextAction: "Resubmit" }); f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Same text remains appropriate" });
  const second = f.send(T.WORK_COMPLETED, f.input(post));
  assert.notEqual(second.event.id, first.event.id); assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
  const retry = f.send(T.WORK_COMPLETED, original, "producer", "first-native"); assert.equal(retry.duplicate, true); assert.equal(retry.event.id, first.event.id);
  const past = await f.client.workResult(f.workItemId, { completionEventId: first.event.id }); assert.equal(past.result.receipt.eventId, first.event.id); assert.equal(past.current.completionEventId, second.event.id);
  await assert.rejects(f.client.workResult(f.workItemId, { completionEventId: "missing" }), { code: "result_not_found" });
  f.mutate(T.VERIFICATION_RECORDED, { result: "pass", completionEventId: first.event.id, evidenceVersion: original.evidenceVersion, summary: "Historical only" }, "reviewer");
  assert.equal(f.item().verification, null); assert.doesNotThrow(() => auditRecovery(f.store));
});

test("selected result API binds viewer, selectors and bytes and rejects revoked access", async t => {
  const f = await setup(t), posted = f.post("Selected body"), data = f.input(posted); f.send(T.WORK_COMPLETED, data);
  const before = auditRecovery(f.store).dataSha256;
  for (const query of ["workItemId=test-handoff&workItemId=test-handoff", "workItemId=test-handoff&completionEventId=", "workItemId=test-handoff&completionEventId=missing&draftMessageId=missing", "workItemId=test-handoff&extra=true"]) {
    const response = await fetch(`${f.origin}/api/rooms/commons/work-result?${query}`, { headers: { Authorization: `Bearer ${f.keys.producer}` } }); assert.equal(response.status, 422);
  }
  for (const change of [value => { value.viewerId = "reviewer"; }, value => { value.result.text.body += "changed"; }, value => { value.selection.completionEventId = "other"; }, value => { value.current.next.workRevision++; }]) {
    const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
      const response = await fetch(url, options); if (!url.includes("/work-result?")) return response;
      const value = await response.json(); change(value); return Response.json(value);
    } }); await assert.rejects(client.workResult(f.workItemId), error => ["identity_mismatch", "invalid_response"].includes(error.code));
  }
  assert.equal(auditRecovery(f.store).dataSha256, before);
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "producer", expectedMemberRevision: 0, permissions: ["accept_work", "complete_work"], active: false }, "owner");
  await assert.rejects(f.client.workResult(f.workItemId));
});

test("recovery audits native completion hidden before a projection checkpoint", async t => {
  const f = await setup(t), posted = f.post("Recovery artifact"), saved = f.send(T.WORK_COMPLETED, f.input(posted)), room = f.store.room("commons");
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", room.sequence, JSON.stringify(room.state));
  assert.doesNotThrow(() => auditRecovery(f.store));
  const corrupted = structuredClone(saved.event); corrupted.data.evidenceVersion = textVersion("Another body");
  f.store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(corrupted), saved.event.id);
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});

test("recovery rejects orphan native receipts hidden in a checkpoint", async t => {
  const f = await setup(t), posted = f.post("Recovery artifact"); f.send(T.WORK_COMPLETED, f.input(posted));
  const room = f.store.room("commons");
  room.state.workItems[f.workItemId].receiptHistory.push({ ...structuredClone(room.state.workItems[f.workItemId].receipt), eventId: "orphan-native" });
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(room.state));
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", room.sequence, JSON.stringify(room.state));
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});

test("CLI reads native draft and result with mutually exclusive selectors", async t => {
  const f = await setup(t), posted = f.post("CLI artifact"), saved = f.send(T.WORK_COMPLETED, f.input(posted));
  const call = args => new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", "result", f.workItemId, ...args], { env: { PATH: "/unavailable",
      ROOM_AGENT_ORIGIN: f.origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "producer", ROOM_AGENT_TOKEN: f.keys.producer }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err += data; }); child.on("exit", code => resolve({ code, out, err }));
  });
  for (const args of [[], ["--completion", saved.event.id], ["--draft", posted.event.data.messageId]]) {
    const reply = await call(args); assert.equal(reply.code, 0, reply.err); assert.equal(JSON.parse(reply.out).result.text.body, "CLI artifact");
  }
  const refused = await call(["--completion", saved.event.id, "--draft", posted.event.data.messageId]); assert.equal(refused.code, 1); assert.equal(refused.out, "");
});
