import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { buildRoomContext, contextVersion } from "../server/room-context.mjs";
import { WORK_ACTION_CONTRACT_REVISION, workActionContractRevision, workTools } from "../client/work-actions.mjs";
import { resumeAgentSession } from "../client/agent-session-checkpoint.mjs";
const exec = promisify(execFile);
async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const connection = { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const directory = join(f.directory, "connection"); saveAgentConnection(directory, connection);
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const options = { connection, directory }, client = new RoomAgentClient(connection);
  return { ...f, options, connection, directory, client, file: join(directory, "agent-session/setup.json"),
    read: extra => resumeAgentSession(client, { ...options, ...extra }),
    cli: args => exec(process.execPath, ["scripts/agent-inbox.mjs", "resume", ...args], {
      env: { ...process.env, ROOM_AGENT_CONFIG: directory, ROOM_AGENT_ORIGIN: undefined, ROOM_AGENT_ROOM: undefined, ROOM_AGENT_MEMBER: undefined, ROOM_AGENT_TOKEN: undefined } }) };
}
test("CLI resumes from durable metadata and notices charter-only changes", async t => {
  const f = await fixture(t);
  const first = JSON.parse((await f.cli(["test-handoff"])).stdout);
  assert.equal(first.status, "initialized"); assert.equal(first.authorityGranted, false);
  assert.equal(first.capabilitiesChanged, true);
  assert.equal(first.checkpoint.workActionContractRevision, WORK_ACTION_CONTRACT_REVISION);
  const second = JSON.parse((await f.cli([])).stdout);
  assert.equal(second.status, "resumed"); assert.equal(second.contextChanged, false);
  assert.equal(second.instructionsChanged, false); assert.equal(second.context, undefined);
  assert.equal(second.capabilitiesChanged, false);
  assert.equal(second.checkpoint.workActionContractRevision, WORK_ACTION_CONTRACT_REVISION);
  assert.equal(second.nextReads.some(read => read.path.endsWith("/charter")), false);
  assert.equal(second.checkpoint.selectedWorkId, "test-handoff");
  const updated = f.store.command(f.keys.owner, "commons", { id: "new-instructions", type: "room.charter_updated", data: {
    expectedRevision: 0, purpose: "INSTRUCTION-TEXT-SENTINEL", outputs: null, boundaries: null, escalation: null } });
  const third = await f.read();
  assert.equal(third.contextChanged, true); assert.equal(third.instructionsChanged, true);
  assert.equal(third.checkpoint.instructions.revision, 1);
  assert.equal(third.checkpoint.instructions.eventId, updated.event.id);
  const saved = readFileSync(f.file, "utf8");
  assert.equal(saved.includes(f.connection.token), false);
  assert.equal(saved.includes("INSTRUCTION-TEXT-SENTINEL"), false);
  assert.equal(saved.includes("definitionOfDone"), false);
  assert.equal((await f.client.charter()).charter.purpose, "INSTRUCTION-TEXT-SENTINEL");
});
test("history and scope mismatch preserve checkpoint and unrelated operation journals", async t => {
  const f = await fixture(t); const first = await f.read();
  const operation = join(f.directory, "pending-operation.json"); writeFileSync(operation, "PENDING-SENTINEL", { mode: 0o600 });
  const original = readFileSync(f.file, "utf8");
  await assert.rejects(resumeAgentSession(f.client, { ...f.options, connection: { ...f.connection, memberId: "owner" } }), { code: "session_scope_changed" });
  assert.equal(readFileSync(f.file, "utf8"), original);
  for (const checkpoint of [{ ...first.checkpoint.history, createdEventId: "other-room" },
    { ...first.checkpoint.history, eventId: "other-history" },
    { ...first.checkpoint.history, sequence: first.checkpoint.history.sequence + 100 }]) {
    await assert.rejects(f.client.roomContext({ sinceVersion: first.checkpoint.contextVersion, checkpoint }), { status: 409, code: "context_history_changed" });
  }
  const altered = JSON.parse(original); altered.history.eventId = "other-history";
  writeFileSync(f.file, JSON.stringify(altered));
  await assert.rejects(f.read(), { code: "context_history_changed" });
  assert.equal(readFileSync(f.file, "utf8"), JSON.stringify(altered));
  assert.equal(readFileSync(operation, "utf8"), "PENDING-SENTINEL");
});
test("warm refresh authenticates again and never advances checkpoint after failed read", async t => {
  const f = await fixture(t); await f.read(); const original = readFileSync(f.file, "utf8");
  const denied = new RoomAgentClient({ ...f.connection, token: "x".repeat(43) });
  await assert.rejects(resumeAgentSession(denied, f.options));
  assert.equal(readFileSync(f.file, "utf8"), original);
  await assert.rejects(f.client.roomContext({ checkpoint: { sequence: 1 } }), { status: 422 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.read({ signal: controller.signal }));
  assert.equal(readFileSync(f.file, "utf8"), original);
});
test("unchanged refresh uses one context read and keeps fresh observation separate from acknowledgement", async t => {
  const f = await fixture(t); const first = await f.read(); let calls = 0;
  f.store.command(f.keys.owner, "commons", { id: "unrelated-message", type: "message.posted", data: { messageId: "unrelated-message", body: "Unrelated text" } });
  const client = new RoomAgentClient({ ...f.connection, fetchImpl: async (...args) => { calls++; return fetch(...args); } });
  const second = await resumeAgentSession(client, f.options);
  assert.equal(calls, 1); assert.equal(second.contextChanged, false);
  assert.ok(second.checkpoint.history.sequence > first.checkpoint.history.sequence);
  assert.equal(f.store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", "producer"), undefined);
});

test("mismatched authenticated context and invalid local cache fail without replacement", async t => {
  const f = await fixture(t); await f.read(); const original = readFileSync(f.file, "utf8");
  const malicious = new RoomAgentClient({ ...f.connection, fetchImpl: async (...args) => {
    const response = await fetch(...args), data = await response.json();
    return Response.json({ ...data, viewerId: "owner" });
  } });
  await assert.rejects(resumeAgentSession(malicious, f.options), { code: "identity_mismatch" });
  assert.equal(readFileSync(f.file, "utf8"), original);
  const invalid = JSON.parse(original); invalid.instructions.revision = -1;
  writeFileSync(f.file, JSON.stringify(invalid));
  await assert.rejects(f.read(), { code: "session_checkpoint_invalid" });
  assert.equal(readFileSync(f.file, "utf8"), JSON.stringify(invalid));
});


test("cold and warm session transport counts and bytes are measured on real HTTP", async t => {
  const f = await fixture(t); let calls = 0, bytes = 0;
  const client = new RoomAgentClient({ ...f.connection, fetchImpl: async (...args) => {
    calls++;
    const response = await fetch(...args);
    bytes += Buffer.byteLength(await response.clone().text());
    return response;
  } });
  const cold = await resumeAgentSession(client, f.options);
  const coldCalls = calls, coldBytes = bytes;
  calls = 0; bytes = 0;
  const warm = await resumeAgentSession(client, f.options);
  assert.equal(coldCalls, 1); assert.equal(calls, 1);
  assert.equal(cold.contextChanged, true); assert.equal(warm.contextChanged, false);
  assert.ok(bytes < coldBytes);
  t.diagnostic(`Session HTTP bodies: cold ${coldCalls} calls / ${coldBytes} bytes; warm ${calls} calls / ${bytes} bytes. No model, instructions body or selected-work read included.`);
});

test("older context service without authenticated history cannot advance resume", async t => {
  const f = await fixture(t); await f.read(); const original = readFileSync(f.file, "utf8");
  const legacy = new RoomAgentClient({ ...f.connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!new URL(url).pathname.endsWith("/context")) return response;
    const data = await response.json();
    delete data.history; delete data.viewerKind; delete data.viewerActive;
    return Response.json(data);
  } });
  await assert.rejects(resumeAgentSession(legacy, f.options), { code: "session_context_invalid" });
  assert.equal(readFileSync(f.file, "utf8"), original);
});


test("deployment contract changes invalidate warm context with no room event or authority change", async t => {
  const f = await fixture(t), current = await f.read();
  const olderDefinitions = structuredClone(workTools);
  olderDefinitions.find(tool => tool.name === "room_claim").inputSchema.properties.paths.maxItems = 32;
  const olderRevision = workActionContractRevision(olderDefinitions);
  const room = f.store.room("commons"), sequence = room.sequence;
  const projection = buildRoomContext({ state: room.state, sequence, viewerId: "producer", caughtUp: 0, now: f.store.now() });
  const { contractVersion: _contractVersion, context_version: _contextVersion, evaluatedThrough: _evaluatedThrough,
    evaluatedAt: _evaluatedAt, cursors: _cursors, ...stable } = projection;
  assert.equal(contextVersion(stable), projection.context_version);
  const olderVersion = contextVersion({ ...stable, workActionContractRevision: olderRevision });
  assert.notEqual(olderVersion, projection.context_version, "work definitions participate in the warm context hash");
  // Persist a prior-deployment checkpoint, keeping the same authentic room
  // incarnation/history and member binding. The current server remains real.
  writeFileSync(f.file, JSON.stringify({ ...current.checkpoint, contextVersion: olderVersion, workActionContractRevision: olderRevision }));
  const upgraded = await f.read();
  assert.equal(upgraded.capabilitiesChanged, true);
  assert.equal(upgraded.contextChanged, true);
  assert.equal(upgraded.instructionsChanged, false);
  assert.equal(upgraded.authorityGranted, false);
  assert.equal(upgraded.checkpoint.workActionContractRevision, WORK_ACTION_CONTRACT_REVISION);
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.equal((await f.read()).capabilitiesChanged, false);
});

test("checkpoint upgrade obtains contract revision once and older services cannot erase it", async t => {
  const f = await fixture(t), first = await f.read();
  const oldCheckpoint = { ...first.checkpoint }; delete oldCheckpoint.workActionContractRevision;
  writeFileSync(f.file, JSON.stringify(oldCheckpoint));
  const upgraded = await f.read();
  assert.equal(upgraded.capabilitiesChanged, true);
  assert.equal(upgraded.contextChanged, true);
  const original = readFileSync(f.file, "utf8");
  const legacy = new RoomAgentClient({ ...f.connection, fetchImpl: async (...args) => {
    const response = await fetch(...args), value = await response.json();
    delete value.workActionContractRevision; return Response.json(value);
  } });
  await assert.rejects(resumeAgentSession(legacy, f.options), { code: "session_context_invalid" });
  assert.equal(readFileSync(f.file, "utf8"), original);
});
