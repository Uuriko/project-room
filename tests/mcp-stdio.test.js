import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { serveRoomMcp, MCP_VERSION } from "../client/mcp-stdio.mjs";
import { RoomClientError } from "../client/room-agent.mjs";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WatchJournal } from "../client/watch-journal.mjs";

function harness(t, client = {}, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), replies = [], pending = new Map();
  const server = serveRoomMcp({ client, roomId: "commons", memberId: "agent", input, output, ...options });
  let text = "", next = 0;
  output.on("data", chunk => { text += chunk; let end; while ((end = text.indexOf("\n")) >= 0) {
    const reply = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); replies.push(reply); pending.get(reply.id)?.(reply); pending.delete(reply.id);
  } });
  const send = message => input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const rpc = (method, params = {}, id = ++next) => new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
  const ready = async () => {
    const result = await rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(result.result.protocolVersion, MCP_VERSION); send({ method: "notifications/initialized" });
  };
  t.after(() => { server.stop(); input.destroy(); output.destroy(); });
  return { input, output, server, replies, send, rpc, ready, pending };
}
const args = { requestId: "draft-one", workItemId: "work", packetId: "packet", basisRevision: 0, body: "A draft ☀️" };
const receipt = command => ({ sequence: 4, duplicate: false, event: { id: "event", type: "message.posted", roomId: "commons", actorId: "agent", data: { ...command.data } } });

test("attention deadline before first authentication creates no state or late response", async t => {
  const f = createAcceptanceFixture(), directory = join(f.directory, "attention");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const h = harness(t, { snapshot: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
    { timeoutMs: 20, attention: { directory, origin: "http://127.0.0.1:1234" } });
  await h.ready();
  const reply = (await h.rpc("tools/call", { name: "room_read_attention", arguments: {} })).result;
  assert.equal(reply.isError, true); assert.equal(reply.structuredContent.code, "request_timeout");
  assert.equal(existsSync(directory), false);
  const count = h.replies.length; await tick(); assert.equal(h.replies.length, count);
});

test("lost MCP acknowledgement response retains an exact idempotent local outcome across adapter restart", async t => {
  const f = createAcceptanceFixture(), directory = join(f.directory, "attention");
  const client = { snapshot: async () => f.store.snapshot(f.keys.producer, "commons"), changes: async (after, limit) => f.store.eventsAfter(f.keys.producer, "commons", after, limit) };
  const options = { memberId: "producer", attention: { directory, origin: "http://127.0.0.1:1234" } };
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const h = harness(t, client, options); await h.ready();
  const notice = (await h.rpc("tools/call", { name: "room_read_attention", arguments: {} })).result.structuredContent.items[0];
  h.output.pause();
  h.send({ id: "lost-ack", method: "tools/call", params: { name: "room_acknowledge_attention", arguments: { noticeId: notice.id } } });
  let pending = 1;
  for (let i = 0; i < 30 && pending; i++) {
    await tick(); const observer = new WatchJournal(directory, { acquire: false }); pending = observer.status().pending; observer.close();
  }
  assert.equal(pending, 0); assert.ok(!h.replies.some(r => r.id === "lost-ack"));
  h.server.stop(); h.input.destroy(); h.output.destroy();
  const resumed = harness(t, client, options); await resumed.ready();
  const ack = (await resumed.rpc("tools/call", { name: "room_acknowledge_attention", arguments: { noticeId: notice.id } })).result.structuredContent;
  assert.equal(ack.status, "already_acknowledged");
  assert.equal((await resumed.rpc("tools/call", { name: "room_read_attention", arguments: {} })).result.structuredContent.pending, 0);
});

test("stdio version negotiation, discovery fallback, tools and notification silence", async t => {
  const h = harness(t, { checkConnection: async () => ({ status: "credential_accepted" }) });
  assert.equal((await h.rpc("server/discover")).error.code, -32601);
  assert.equal((await h.rpc("tools/list")).error.code, -32000);
  await h.ready();
  const tools = (await h.rpc("tools/list")).result.tools;
  assert.equal(tools.length, 17); assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal((await h.rpc("tools/call", { name: "room_check_access", arguments: {} }, "typed-id")).result.structuredContent.status, "credential_accepted");
  const count = h.replies.length; h.send({ method: "unknown-notification" }); await tick(); assert.equal(h.replies.length, count);
  assert.equal((await h.rpc("tools/call", { name: "room_read_work", arguments: { workItemId: "work", token: "not-allowed" } })).error.code, -32602);
  h.input.write("not-json\n"); await tick(); assert.equal(h.replies.at(-1).error.code, -32700);
  h.send({ id: null, method: "ping" }); await tick(); assert.equal(h.replies.at(-1).error.code, -32600);
});

test("fragmented UTF-8 draft keeps business identity across transport retries and validates exact receipts", async t => {
  const commands = [];
  const h = harness(t, { command: async command => { commands.push(command); return receipt(command); } }); await h.ready();
  const message = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "fragment", method: "tools/call", params: { name: "room_post_draft", arguments: args } }) + "\n");
  const got = new Promise(resolve => h.pending.set("fragment", resolve));
  for (const byte of message) h.input.write(Buffer.from([byte]));
  assert.equal((await got).result.structuredContent.status, "draft_posted");
  assert.equal((await h.rpc("tools/call", { name: "room_post_draft", arguments: args })).result.structuredContent.status, "draft_posted");
  assert.deepEqual(commands[0], commands[1]); assert.equal(commands[0].data.body, args.body); assert.ok(commands[0].data.messageId);
  for (const mutate of [r => r.sequence = 0, r => delete r.event.id, r => r.event.roomId = "wrong", r => r.event.actorId = "wrong", r => r.event.data.extra = "unexpected", r => r.event.data.allowOlderBasis = true]) {
    const bad = harness(t, { command: async command => { const result = receipt(command); mutate(result); return result; } }); await bad.ready();
    const rejected = (await bad.rpc("tools/call", { name: "room_post_draft", arguments: args })).result;
    assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.status, "unconfirmed");
  }
});

test("cancelled reads emit no late result; deadlines emit a fixed error; EOF stops pending work", async t => {
  let entered, aborted = false;
  const started = new Promise(resolve => entered = resolve);
  const h = harness(t, { workContext: async (_, { signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); })); } });
  await h.ready(); const count = h.replies.length;
  h.send({ id: "cancel-me", method: "tools/call", params: { name: "room_read_work", arguments: { workItemId: "work" } } });
  await started; h.send({ method: "notifications/cancelled", params: { requestId: "cancel-me" } }); await tick(); await tick();
  assert.equal(aborted, true); assert.equal(h.replies.length, count);
  const timeout = harness(t, { checkConnection: () => new Promise(() => {}) }, { timeoutMs: 10 }); await timeout.ready();
  const result = (await timeout.rpc("tools/call", { name: "room_check_access" })).result;
  assert.equal(result.isError, true); assert.equal(result.structuredContent.code, "request_timeout");
  h.input.end(); await h.server.done;
});

test("draft refusals are distinct from unknown saves and private diagnostics are never echoed", async t => {
  for (const [status, code, expected] of [[409, "idempotency_conflict", "idempotency_conflict"], [409, "command_rejected", "review_required"], [503, "private-error", "service_unavailable"]]) {
    const h = harness(t, { command: async () => { throw new RoomClientError(status, code, "PRIVATE SECRET"); } }); await h.ready();
    const result = (await h.rpc("tools/call", { name: "room_post_draft", arguments: args })).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.code, expected); assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
  }
});

test("oversized input and ambiguous in-flight IDs close the bounded transport", async t => {
  const h = harness(t); h.input.write("x".repeat(65537)); await h.server.done;
  const duplicate = harness(t, { checkConnection: () => new Promise(() => {}) }); await duplicate.ready();
  const message = { id: "same", method: "tools/call", params: { name: "room_check_access" } };
  duplicate.send(message); duplicate.send(message); await duplicate.server.done;
});

test("discussion refusals explain safe next steps without echoing service diagnostics", async t => {
  for (const code of ["invalid_discussion", "discussion_ahead", "discussion_history_changed", "discussion_entry_too_large"]) {
    const h = harness(t, { workDiscussion: async () => { throw new RoomClientError(409, code, "PRIVATE SECRET"); } }); await h.ready();
    const result = (await h.rpc("tools/call", { name: "room_read_work_discussion", arguments: { workItemId: "work" } })).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.type, "discussion_refused");
    assert.equal(result.structuredContent.code, code); assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
    assert.ok(result.structuredContent.message.length > 40);
  }
});

test("schema-valid oversized work input is a local refusal, not an unknown save", async t => {
  let calls = 0; const h = harness(t, { command: async () => { calls++; } }); await h.ready();
  const result = (await h.rpc("tools/call", { name: "room_record_completion", arguments: {
    requestId: "large", workItemId: "work", expectedRevision: 2, summary: "☀".repeat(4096), evidenceUrl: "https://example.invalid/artifact",
    evidenceVersion: "v1", nextAction: "Review", checksClaimed: Array(20).fill("a".repeat(512))
  } })).result;
  assert.equal(calls, 0); assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "work_action_too_large"); assert.equal(result.structuredContent.outcome, "this_attempt_not_sent");
});

test("cancelled lifecycle output cannot imply rollback; exact retry retains the committed operation", async t => {
  const args = { requestId: "accept", workItemId: "work", expectedRevision: 0 };
  let started, release, saved;
  const entered = new Promise(resolve => { started = resolve; }), delayed = new Promise(resolve => { release = resolve; });
  const client = { command: async command => {
    if (saved) return { ...saved, duplicate: true };
    saved = { sequence: 5, duplicate: false, event: { id: "accepted-event", type: command.type, data: command.data,
      roomId: "commons", actorId: "agent", at: new Date().toISOString(), causationId: null,
      idempotencyKey: createHash("sha256").update(`agent:${command.id}`).digest("hex") } };
    started(); await delayed; return saved;
  } };
  const h = harness(t, client); await h.ready(); const count = h.replies.length;
  h.send({ id: "cancel-work", method: "tools/call", params: { name: "room_accept_work", arguments: args } });
  await entered; h.send({ method: "notifications/cancelled", params: { requestId: "cancel-work" } }); release(); await tick(); await tick();
  assert.equal(h.replies.length, count); assert.ok(saved);
  const next = harness(t, client); await next.ready();
  const retried = (await next.rpc("tools/call", { name: "room_accept_work", arguments: args })).result.structuredContent;
  assert.equal(retried.status, "recorded"); assert.equal(retried.duplicate, true); assert.equal(retried.eventId, saved.event.id);
});
