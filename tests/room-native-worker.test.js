import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { issueSpendGrant } from "../server/spend-grants.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { uploadArtifact, downloadArtifact, sha256 } from "../client/room-artifact-transfer.mjs";
import { runNativeRequest, taskPrefix, parseTask, readWorkerGrant, executeAdapter, workerStatus } from "../client/room-native-worker.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  issueSpendGrant(f.store.db, "commons", "producer", { grantedBy: "owner", capCents: "1000", perTxCapCents: "100", nowMs: Date.now() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  for (const [from, to] of [["owner", "producer"], ["producer", "owner"]]) {
    f.store.dmConsents.request("commons", from, to, "fixture"); f.store.dmConsents.decide("commons", to, from, "approve");
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connection = { origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const sender = { ...connection, memberId: "owner", token: f.keys.owner };
  const bytes = Buffer.from('[1,2,3]');
  f.store.command(f.keys.owner, "commons", { id: "input", type: "message.posted", data: { messageId: "input", toMemberId: "producer", body: "Task input" } });
  const reference = await uploadArtifact({ connection: sender, bytes, operationId: "input", messageId: "input" });
  const expected = { adapter: "json-summary-v1", sha256: sha256(bytes), byteLength: bytes.length, type: "array", entries: 3 };
  const task = { version: 1, adapter: "json-summary-v1", input: reference, inputSha256: sha256(bytes), expectedResultSha256: sha256(JSON.stringify(expected)) };
  f.store.command(f.keys.owner, "commons", { id: "job", type: "message.posted", data: { messageId: "job", toMemberId: "producer", requestKind: "reply", body: taskPrefix + JSON.stringify(task) } });
  const grant = { version: 1, origin, roomId: "commons", memberId: "producer", requesters: ["owner"], adapters: ["json-summary-v1"],
    maxInputBytes: 1048576, timeoutMs: 1000, maxConcurrentJobs: 1, expiresAt: Date.now() + 60000, paused: false };
  const grantPath = join(f.directory, "grant.json"); writeFileSync(grantPath, JSON.stringify(grant), { mode: 0o600 });
  return { ...f, connection, sender, bytes, task, expected, grant, grantPath, directory: join(f.directory, "worker"), requestMessageId: "job" };
}
test("real Room HTTP carries private input, local execution, verified output and replay without Tailscale", async t => {
  const f = await fixture(t);
  const first = await runNativeRequest(f); assert.equal(first.hostExecuted, true);
  assert.equal(workerStatus(f.directory).state, "delivered");
  const context = await new RoomAgentClient(f.connection).replyContext("job");
  assert.equal(context.request.status, "answered");
  const result = JSON.parse(context.page.items.find(item => item.message?.body?.startsWith('{"version":1,"adapter"')).message.body);
  assert.equal(result.accepted, true);
  const output = await downloadArtifact({ connection: f.sender, reference: result.output, directory: join(f.directory, "output-cache") });
  assert.deepEqual(JSON.parse(output.bytes), f.expected);
  writeFileSync(f.grantPath, JSON.stringify({ ...f.grant, paused: true }));
  const replay = await runNativeRequest(f); assert.equal(replay.hostExecuted, false); assert.equal(replay.receipt.duplicate, true);
});
test("lost reply acknowledgement recovers the durable answer after worker restart without executing again", async t => {
  const f = await fixture(t); let lost = false;
  const connection = { ...f.connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!lost && options.method === "POST" && url.endsWith("/commands") && options.body.includes('"responseOutcome"')) { lost = true; throw new TypeError("lost reply acknowledgement"); }
    return response;
  } };
  await assert.rejects(runNativeRequest({ ...f, connection }), /lost reply/);
  const replay = await runNativeRequest(f); assert.equal(replay.hostExecuted, false); assert.equal(replay.receipt.duplicate, true);
});
test("paused, expired and unauthorized local grants reject before execution", async t => {
  const f = await fixture(t);
  for (const patch of [{ paused: true }, { expiresAt: 0 }, { requesters: ["other"] }, { adapters: [] }]) {
    writeFileSync(f.grantPath, JSON.stringify({ ...f.grant, ...patch }));
    await assert.rejects(runNativeRequest(f), /grant/);
  }
  assert.equal((await new RoomAgentClient(f.connection).replyContext("job")).request.status, "open");
});
test("output-upload failure recovers a saved local result without repeating execution", async t => {
  const f = await fixture(t); let failed = false;
  const connection = { ...f.connection, fetchImpl: async (url, options) => {
    if (!failed && options.method === "POST" && url.endsWith("/files")) { failed = true; throw new TypeError("output upload disconnected"); }
    return fetch(url, options);
  } };
  await assert.rejects(runNativeRequest({ ...f, connection }), /output upload disconnected/);
  writeFileSync(f.grantPath, JSON.stringify({ ...f.grant, paused: true }));
  const result = await runNativeRequest(f);
  assert.equal(result.hostExecuted, false); assert.equal(result.status, "delivered");
});
test("local test adapter is pinned, bounded and receives data without Room credentials", async t => {
  const directory = mkdtempSync(join(tmpdir(), "native-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "adapter.mjs");
  writeFileSync(path, 'import test from "node:test"; import assert from "node:assert/strict"; test("input",()=>{assert.ok(process.env.ROOM_TASK_INPUT); assert.equal(process.env.ROOM_AGENT_TOKEN,undefined);});');
  const bytes = Buffer.from("data"), task = { adapter: "node-test-v1", inputSha256: sha256(bytes) };
  const grant = { maxInputBytes: 100, timeoutMs: 1000, nodeTest: { path, sha256: sha256(readFileSync(path)) } };
  assert.equal((await executeAdapter({ task, bytes, grant, directory })).passed, true);
  writeFileSync(path, "setInterval(()=>{},1000)");
  await assert.rejects(executeAdapter({ task, bytes, grant, directory }), /pin mismatch/);
  grant.nodeTest.sha256 = sha256(readFileSync(path)); grant.timeoutMs = 100;
  assert.equal((await executeAdapter({ task, bytes, grant, directory })).interrupted, true);
});
test("task contracts reject commands and status expires honestly", () => {
  assert.throws(() => parseTask(taskPrefix + JSON.stringify({ version: 1, command: "rm" })));
  assert.throws(() => readWorkerGrant("/missing", {}));
  assert.equal(workerStatus("/missing").fresh, false);
});
