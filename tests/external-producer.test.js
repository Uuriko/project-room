import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { reportedProducer, verifyWorkResult } from "../src/work-packet.js";
import { textVersion } from "../server/text-results.mjs";
import { buildWorkCommand } from "../client/work-actions.mjs";
import { workStatus, nextWorkStep } from "../src/workflow.js";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";

test("outside credit is strict, mutually exclusive, and never a member identity", () => {
  assert.deepEqual(reportedProducer({ externalProducer: "Writer with AI assistance" }), {
    producerId: null, producerAttribution: "external-reported", externalProducer: "Writer with AI assistance"
  });
  for (const externalProducer of [null, "", " ", 1, {}, "x".repeat(161), "\ud800"]) assert.throws(() => reportedProducer({ externalProducer }));
  assert.throws(() => reportedProducer({ producerId: "owner", externalProducer: "Another person" }));
  assert.throws(() => buildWorkCommand("room_record_completion", { requestId: "one", workItemId: "work", expectedRevision: 1,
    summary: "Result", evidenceUrl: "https://example.invalid/result", evidenceVersion: "v1", nextAction: "Review", producerId: "owner", externalProducer: "Outside" }), /Invalid work action/);
});

test("outside credit survives native result reads, replay, review and exact retry without approval", async t => {
  const f = createAcceptanceFixture(); t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  const workItemId = "test-handoff", body = "Exact outside artifact.";
  send("producer", "work.accepted", { workItemId, expectedRevision: 0 });
  const post = send("guest", "message.posted", { messageId: "outside-text", body, workItemId });
  const before = f.store.room("commons").state;
  const command = buildWorkCommand("room_submit_text_result", { requestId: "outside-result", workItemId, expectedRevision: 1,
    summary: "Reported outside work", nextAction: "Review evidence; identity remains unverified", producerId: null, externalProducer: "Outside AI / person",
    evidenceMessageId: "outside-text", evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: null });
  const receipt = f.store.command(f.keys.producer, "commons", command);
  const after = f.store.room("commons").state, item = after.workItems[workItemId];
  assert.deepEqual(after.members, before.members); assert.equal(item.receipt.producerId, null);
  assert.equal(item.receipt.externalProducer, "Outside AI / person"); assert.equal(workStatus(item).label, "Outside credit");
  assert.equal(nextWorkStep(item).action, "establish_provenance");
  const value = f.store.workResult(f.keys.producer, "commons", workItemId, { completionEventId: receipt.event.id });
  await verifyWorkResult(value, { roomId: "commons", workItemId, completionEventId: receipt.event.id });
  const forged = structuredClone(value); forged.result.receipt.producerId = "guest";
  await assert.rejects(verifyWorkResult(forged, { roomId: "commons", workItemId, completionEventId: receipt.event.id }));
  send("reviewer", "verification.recorded", { workItemId, expectedRevision: 2, result: "pass", completionEventId: receipt.event.id,
    evidenceVersion: textVersion(body), summary: "The text meets the brief; identity unverified." });
  assert.equal(f.store.room("commons").state.workItems[workItemId].verification.independenceConfirmed, false);
  assert.throws(() => send("owner", "owner.decision_recorded", { workItemId, expectedRevision: 3, decision: "approved",
    completionEventId: receipt.event.id, evidenceVersion: textVersion(body), reason: "Attempted approval" }), /independent/);
  assert.equal(f.store.command(f.keys.producer, "commons", command).event.id, receipt.event.id);
  assert.equal(f.store.command(f.keys.producer, "commons", command).duplicate, true);
  const final = f.store.room("commons").state;
  assert.equal(final.workItems[workItemId].decision, null);
  assert.deepEqual(f.store.rebuildProjection("commons").state, final);
  assert.equal(auditRecovery(f.store).schemaVersion, 27);
});

const previousCommit = "33c817a911ebb9fb0310592cac77d8e61380541d";
test("real MCP process preserves outside credit and exact completion retries across restart", { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }); let mcp;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await mcp?.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const directory = join(f.directory, "outside-credit-client");
  saveAgentConnection(directory, { version: 1, origin: "http://127.0.0.1:" + server.address().port, roomId: "commons", memberId: "producer", token: f.keys.producer });
  f.store.command(f.keys.producer, "commons", { id: "accept", type: "work.accepted", data: { workItemId: "test-handoff", expectedRevision: 0 } });
  const body = "An exact externally credited draft.";
  const post = f.store.command(f.keys.guest, "commons", { id: "post", type: "message.posted", data: { messageId: "outside", workItemId: "test-handoff", body } });
  const args = { requestId: "outside-mcp", workItemId: "test-handoff", expectedRevision: 1, summary: "Outside draft", nextAction: "Review",
    producerId: null, externalProducer: "Outside author + AI", evidenceMessageId: "outside", evidenceMessageEventId: post.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: null };
  const before = f.store.snapshot(f.keys.producer, "commons");
  mcp = await openMcpTestClient(directory);
  assert.equal((await mcp.request("tools/list")).result.tools.find(tool => tool.name === "room_submit_text_result").inputSchema.properties.externalProducer.maxLength, 160);
  const rejected = await mcp.call("room_submit_text_result", { ...args, producerId: "guest" });
  assert.equal(rejected.error.code, -32602);
  const saved = (await mcp.call("room_submit_text_result", args)).result.structuredContent;
  assert.equal(saved.status, "recorded");
  assert.equal((await mcp.close()).diagnostics, ""); mcp = await openMcpTestClient(directory);
  const retry = (await mcp.call("room_submit_text_result", args)).result.structuredContent;
  assert.equal(retry.status, "recorded"); assert.equal(retry.duplicate, true);
  assert.equal(retry.eventId, saved.eventId); assert.deepEqual(retry.result, saved.result);
  const result = (await mcp.call("room_read_result", { workItemId: args.workItemId, completionEventId: saved.eventId })).result.structuredContent;
  assert.equal(result.result.receipt.externalProducer, args.externalProducer);
  assert.equal(result.result.receipt.producerAttribution, "external-reported");
  const after = f.store.snapshot(f.keys.producer, "commons");
  assert.equal(after.sequence, before.sequence + 1); assert.equal(after.cursor, before.cursor);
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.state.workItems["test-handoff"].receipt.externalProducer, args.externalProducer);
  assert.equal(after.state.workItems["test-handoff"].verification, null);
});

async function previousFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-v25-credit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, "runtime"); createRuntimePackage({ repository: process.cwd(), commit: previousCommit, destination: runtime });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(runtime, "server/store.mjs")));
  const filename = join(directory, "room.sqlite"), old = new OldStore(filename); t.after(() => old.close());
  old.initialize(initialRoom()); const key = old.issueAccessKey("commons", "owner");
  return { old, key, filename, OldStore };
}
test("real v25 database upgrades unchanged and retires its already-open writer", async t => {
  const f = await previousFixture(t), before = f.old.room("commons");
  const cached = f.old.db.prepare("UPDATE rooms SET sequence=sequence WHERE id=?"); cached.run("commons");
  const current = new RoomStore(f.filename); t.after(() => current.close());
  assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 27);
  assert.deepEqual(current.room("commons"), before);
  assert.throws(() => cached.run("commons"), /project_room_writer_v27|unsupported database writer/);
  assert.throws(() => new f.OldStore(f.filename), /schema is newer/);
});
test("v25 ignored outside-credit data cannot be reinterpreted during upgrade", async t => {
  const f = await previousFixture(t), send = (type, data) => f.old.command(f.key, "commons", { id: crypto.randomUUID(), type, data });
  send("work.proposed", { workItemId: "legacy", title: "Legacy", definitionOfDone: "Text", accountableMemberId: "owner", mode: "read" });
  send("work.accepted", { workItemId: "legacy", expectedRevision: 0 });
  const completion = send("work.completed", { workItemId: "legacy", expectedRevision: 1, summary: "Legacy result", evidenceUrl: "https://example.invalid/result",
    evidenceVersion: "v1", nextAction: "Review" });
  // Simulate imported/altered old history; the v25 public command rejects this field.
  const historical = JSON.parse(f.old.db.prepare("SELECT body FROM events WHERE id=?").get(completion.event.id).body);
  historical.data.externalProducer = "Previously ignored scalar";
  f.old.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(historical), completion.event.id);
  const before = f.old.room("commons");
  assert.throws(() => new RoomStore(f.filename), /Pre-v26 outside credit history/);
  assert.equal(f.old.db.prepare("PRAGMA user_version").get().user_version, 25);
  assert.deepEqual(f.old.room("commons"), before);
});
