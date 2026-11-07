// tests/a2a-jsonrpc.test.js — the public A2A JSON-RPC endpoint at /a2a.
// Contract guarded: an A2A 0.3 message/send and an A2A 1.0 SendMessage both
// get a message back that says how to join the Room; the endpoint needs no
// credentials, stores nothing, and refuses anything that isn't a send.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleA2aRpc, a2aReplyText } from "../server/a2a-jsonrpc.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const send = (method, extra = {}) => ({ jsonrpc: "2.0", id: "1", method, params: { message: { role: "user", messageId: "m1", parts: [{ kind: "text", text: "hello" }], ...extra } } });

test("A2A 0.3 message/send gets an agent message with the join guide", () => {
  const reply = handleA2aRpc(send("message/send", { contextId: "c1" }));
  assert.equal(reply.id, "1");
  assert.equal(reply.result.kind, "message");
  assert.equal(reply.result.role, "agent");
  assert.equal(reply.result.contextId, "c1");
  assert.equal(reply.result.parts[0].kind, "text");
  assert.match(reply.result.parts[0].text, /invite link/);
  assert.equal(reply.result.parts[0].text, a2aReplyText());
  assert.deepEqual(handleA2aRpc(send("message/send", { contextId: "c1" })), reply, "same request, same reply");
});

test("A2A 1.0 SendMessage gets the 1.0 message shape", () => {
  const reply = handleA2aRpc(send("SendMessage"));
  assert.equal(reply.result.message.role, "ROLE_AGENT");
  assert.match(reply.result.message.parts[0].text, /llms\.txt/);
});

test("bad requests get JSON-RPC errors, notifications get nothing", () => {
  assert.equal(handleA2aRpc([]).error.code, -32600);
  assert.equal(handleA2aRpc({ jsonrpc: "1.0", id: 1, method: "message/send" }).error.code, -32600);
  assert.equal(handleA2aRpc({ jsonrpc: "2.0", id: 2, method: "message/send", params: {} }).error.code, -32602);
  assert.equal(handleA2aRpc({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: "t" } }).error.code, -32001);
  assert.equal(handleA2aRpc({ jsonrpc: "2.0", id: 4, method: "rooms/delete" }).error.code, -32601);
  assert.equal(handleA2aRpc({ jsonrpc: "2.0", method: "message/send" }), null);
});

test("POST /a2a and /room/a2a answer over HTTP without credentials", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-a2a-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/a2a", "/room/a2a"]) {
    const response = await fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(send("message/send")) });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal((await response.json()).result.role, "agent");
  }
  const get = await fetch(`${origin}/a2a`);
  assert.equal(get.status, 405);
  assert.equal((await fetch(`${origin}/a2a`, { method: "POST", body: "{not json" })).status, 400);
  const notifyBatch = await fetch(origin + "/a2a", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", method: "message/send", params: send("message/send").params }]) });
  assert.equal(notifyBatch.status, 204);
  const reqBatch = await fetch(origin + "/a2a", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([send("message/send"), { ...send("message/send"), id: 2 }]) });
  assert.equal(reqBatch.status, 200);
  assert.equal((await reqBatch.json()).length, 2);
});

test("A2A v1.0 capability validation: streaming and extended-card operations answer -32004", () => {
  const msgParams = { message: { role: "user", messageId: "m1", parts: [{ kind: "text", text: "hello" }] } };
  for (const method of ["message/stream", "SendStreamingMessage", "tasks/resubscribe", "SubscribeToTask"]) {
    const reply = handleA2aRpc({ jsonrpc: "2.0", id: 9, method, params: msgParams });
    assert.equal(reply.error.code, -32004, method);
    assert.match(reply.error.message, /UnsupportedOperationError/, method);
    assert.equal(handleA2aRpc({ jsonrpc: "2.0", method, params: msgParams }), null, `${method} notification`);
  }
  for (const method of ["agent/getAuthenticatedExtendedCard", "GetExtendedAgentCard"]) {
    const reply = handleA2aRpc({ jsonrpc: "2.0", id: 10, method });
    assert.equal(reply.error.code, -32004, method);
    assert.match(reply.error.message, /UnsupportedOperationError/, method);
  }
});

test("JSON-RPC 2.0 batches answer with an array of responses", () => {
  const one = send("message/send");
  const batch = handleA2aRpc([one, { jsonrpc: "2.0", method: "message/send", params: one.params }]);
  assert.equal(batch.length, 1, "a notification inside a batch contributes no entry");
  assert.equal(batch[0].id, "1");
  const two = handleA2aRpc([one, { ...one, id: 2 }]);
  assert.equal(two.length, 2);
  assert.equal(two[1].id, 2);
  assert.equal(handleA2aRpc([]).error.code, -32600);
  assert.equal(handleA2aRpc([["nested"]])[0].error.code, -32600);
});
