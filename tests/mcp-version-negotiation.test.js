import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveRoomMcp, MCP_VERSION, MCP_PREVIOUS_VERSION, MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";

function harness(t, client = {}, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), replies = [], pending = new Map();
  const server = serveRoomMcp({ client, roomId: "commons", memberId: "agent", input, output, ...options });
  let text = "", next = 0;
  output.on("data", chunk => { text += chunk; let end; while ((end = text.indexOf("\n")) >= 0) {
    const reply = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); replies.push(reply); pending.get(reply.id)?.(reply); pending.delete(reply.id);
  } });
  const send = message => input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const rpc = (method, params = {}, id = ++next) => new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
  t.after(() => { server.stop(); input.destroy(); output.destroy(); });
  return { send, rpc, replies };
}

async function initializeEra(h, version) {
  const result = await h.rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "era-test", version: "1" } });
  h.send({ method: "notifications/initialized" });
  return result.result.protocolVersion;
}

const draftArgs = { requestId: "era-draft", workItemId: "work", packetId: "packet", basisRevision: 0, body: "Era draft body" };

test("a client offering the previous era negotiates that era and keeps identical business retry identity", async t => {
  const commands = [];
  const client = { command: async command => { commands.push(command);
    return { sequence: 4, duplicate: commands.length > 1, event: { id: "event", type: "message.posted", roomId: "commons", actorId: "agent", data: { ...command.data } } }; } };
  const h = harness(t, client);
  assert.equal(await initializeEra(h, MCP_PREVIOUS_VERSION), MCP_PREVIOUS_VERSION);
  const list = (await h.rpc("tools/list")).result;
  assert.ok(Array.isArray(list.tools) && list.tools.length > 0);
  const first = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...draftArgs } });
  const retry = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...draftArgs } });
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(commands[0].id, "era-draft");
  assert.equal(first.result.structuredContent.status, retry.result.structuredContent.status);
  assert.equal(retry.result.structuredContent.duplicate, true);
});

test("a client offering the current era negotiates it and sees the identical business surface and retry identity", async t => {
  const commands = [];
  const client = { command: async command => { commands.push(command);
    return { sequence: 4, duplicate: commands.length > 1, event: { id: "event", type: "message.posted", roomId: "commons", actorId: "agent", data: { ...command.data } } }; } };
  const h = harness(t, client);
  assert.equal(await initializeEra(h, MCP_VERSION), MCP_VERSION);
  const list = (await h.rpc("tools/list")).result;
  const first = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...draftArgs } });
  const retry = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...draftArgs } });
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(first.result.structuredContent.status, retry.result.structuredContent.status);
});

test("both eras expose the identical tool surface", async t => {
  const previous = harness(t), current = harness(t);
  await initializeEra(previous, MCP_PREVIOUS_VERSION);
  await initializeEra(current, MCP_VERSION);
  const previousTools = (await previous.rpc("tools/list")).result.tools.map(tool => tool.name);
  const currentTools = (await current.rpc("tools/list")).result.tools.map(tool => tool.name);
  assert.deepEqual(previousTools, currentTools);
});

test("an unsupported offered version negotiates the newest supported version, and the discover error names both eras", async t => {
  const h = harness(t);
  assert.equal(await initializeEra(h, "2099-01-01"), MCP_VERSION);
  const reply = await h.rpc("server/discover");
  assert.equal(reply.error.code, -32601);
  for (const version of MCP_SUPPORTED_VERSIONS) assert.ok(reply.error.message.includes(version));
});

test("an older unsupported era also negotiates the newest supported version without inventing that era", async t => {
  const h = harness(t);
  assert.equal(await initializeEra(h, "2024-11-05"), MCP_VERSION);
});
