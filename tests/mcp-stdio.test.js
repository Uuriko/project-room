import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { serveRoomMcp, MCP_VERSION } from "../client/mcp-stdio.mjs";
import { RoomClientError } from "../client/room-agent.mjs";

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

test("stdio version negotiation, discovery fallback, tools and notification silence", async t => {
  const h = harness(t, { checkConnection: async () => ({ status: "credential_accepted" }) });
  assert.equal((await h.rpc("server/discover")).error.code, -32601);
  assert.equal((await h.rpc("tools/list")).error.code, -32000);
  await h.ready();
  const tools = (await h.rpc("tools/list")).result.tools;
  assert.equal(tools.length, 4); assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
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
