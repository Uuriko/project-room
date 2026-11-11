// Optimistic send, a durable outbox, and an edge HTML body that is not a JSON error.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";

const accountId = memberId => `account-${memberId}`;
const sessionBinding = memberId => `session-${memberId}`;
const snapshot = (sequence, viewerId = "human") => ({
  sequence, roomId: "commons", state: { messages: [] }, cursor: 0,
  viewerId, viewerAccountId: accountId(viewerId), viewerAuthEpoch: 0, viewerSessionBinding: sessionBinding(viewerId)
});
const identity = (id = "human") => ({
  account: { id: accountId(id), authEpoch: 0 }, member: { id }, roomId: "commons",
  csrf: "session-confirmation", sessionBinding: sessionBinding(id)
});
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function memoryStorage() {
  const mem = new Map();
  return {
    getItem: key => mem.has(key) ? mem.get(key) : null,
    setItem: (key, value) => mem.set(key, String(value)),
    removeItem: key => mem.delete(key)
  };
}

test("an optimistic send paints before the network, and an HTML 524 stays unconfirmed in the outbox", async t => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  t.after(() => { globalThis.localStorage = previous; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const painted = [];
  const settled = [];
  let calls = 0;
  const client = new RoomClient({
    onOptimistic: command => painted.push(command.data.body),
    onSendSettled: result => settled.push(result),
    fetcher: async (url, options) => {
      if (options?.method === "POST") {
        calls++;
        assert.deepEqual(painted, ["hello room"]);
        await gate;
        return {
          ok: false, status: 524,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<html><title>timeout</title></html>",
          json: async () => { throw new SyntaxError("Unexpected token <"); }
        };
      }
      return response(snapshot(4));
    }
  });
  client.session = identity();
  const command = { id: "cmd-1", type: "message.posted", data: { messageId: "msg-1", body: "hello room" } };
  const pending = client.send(command);
  assert.equal(calls, 1);
  release();
  await assert.rejects(pending, /could not be confirmed/);
  assert.equal(settled[0].maybeSaved, true);
  assert.equal(settled[0].ok, false);
  assert.equal(client.outbox().length, 1);
  assert.equal(client.outbox()[0].command.data.body, "hello room");
  const reloaded = new RoomClient({ fetcher: async () => response(snapshot(4)) });
  reloaded.session = identity();
  assert.equal(reloaded.outbox()[0].id, "cmd-1");
});

test("a definite JSON refusal drops the outbox", async t => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  t.after(() => { globalThis.localStorage = previous; });
  const client = new RoomClient({
    fetcher: async (url, options) => options?.method === "POST"
      ? response({ error: { code: "invalid_message", message: "Choose a shorter message" } }, 422)
      : response(snapshot(4))
  });
  client.session = identity();
  await assert.rejects(client.send({ id: "cmd-2", type: "message.posted", data: { messageId: "msg-2", body: "nope" } }), /shorter message/);
  assert.deepEqual(client.outbox(), []);
});

test("duplicate GETs in flight share one request, and a fresh refresh does not", async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new RoomClient({ fetcher: async () => { calls++; await gate; return response({ items: [1] }); } });
  client.session = identity();
  const first = client.request("/api/rooms/commons/saved");
  const second = client.request("/api/rooms/commons/saved");
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
