// Credential-spent requests report their remaining budget on success, in the
// same X-RateLimit-* names and units the 429 already uses (Linear parity:
// callers can pace themselves before they are refused).
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t, options = {}) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: "join-bot", type: "member.added", data: { memberId: "bot", displayName: "Bot", kind: "agent", permissions: [] } });
  const bot = store.issueAccessKey("commons", "bot");
  const server = createRoomServer({ store, credentialReadBurst: 4, credentialWriteBurst: 3, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(origin + path, { headers: { authorization: `Bearer ${bot}` } });
  let n = 0;
  const post = body => fetch(`${origin}/api/rooms/commons/commands`, { method: "POST",
    headers: { authorization: `Bearer ${bot}`, "content-type": "application/json", origin },
    body: JSON.stringify({ id: `c-${n++}`, type: "message.posted", data: { messageId: `m-${n}`, body } }) });
  const ada = store.identities.create("Ada");
  new AgentRooms(store).create(ada.secret, { roomId: "ada-den", title: "Ada den", purpose: "Budget headers", kind: "personal", displayName: "Ada" });
  const mcp = (name, args) => fetch(`${origin}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${ada.secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name, arguments: { roomId: "ada-den", ...args } } }) });
  const getOwner = path => fetch(origin + path, { headers: { authorization: `Bearer ${owner}` } });
  const beginMcp = () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "held-body", method: "tools/call",
      params: { name: "room_check_access", arguments: { roomId: "ada-den" } } });
    let pending;
    const response = new Promise((resolve, reject) => {
      pending = request(origin + "/mcp", { method: "POST", headers: {
        authorization: `Bearer ${ada.secret}`, "content-type": "application/json",
        accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(payload),
      } }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      pending.on("error", reject);
      pending.write(payload.slice(0, -1));
    });
    return { response, finish: () => pending.end(payload.slice(-1)) };
  };
  return { origin, server, get, getOwner, post, mcp, beginMcp };
}
const budget = response => ["limit", "remaining", "reset", "bucket"].map(k => response.headers.get(`x-ratelimit-${k}`));

test("authenticated REST reads report the read budget on every success, then refuse with the same headers", async t => {
  const { get } = await serve(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const response = await get("/api/rooms/commons/events?after=0");
    assert.equal(response.status, 200, await response.text());
    const [limit, remaining, reset, bucket] = budget(response);
    assert.equal(limit, "4"); assert.equal(bucket, "read");
    assert.ok(Number(reset) * 1000 >= Date.now() - 1000, "reset is a future epoch second");
    seen.push(Number(remaining));
  }
  assert.deepEqual(seen, [3, 2, 1, 0], "the injected clock prevents host load from refilling the bucket");
  const refused = await get("/api/rooms/commons/events?after=0");
  assert.equal(refused.status, 429);
  assert.deepEqual(budget(refused).filter((_, i) => i !== 2), ["4", "0", "read"]);
});

test("overlapping requests keep credential and read/write response budgets isolated", async t => {
  const { get, getOwner, post } = await serve(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const path = "/api/rooms/commons/events?after=0";
  for (let n = 0; n < 3; n++) assert.equal((await get(path)).status, 200);
  const [botRead, ownerRead, botWrite] = await Promise.all([get(path), getOwner(path), post("overlap")]);
  assert.equal(botRead.status, 200);
  assert.equal(ownerRead.status, 200);
  assert.equal(botWrite.status, 201);
  assert.deepEqual(budget(botRead).filter((_, i) => i !== 2), ["4", "0", "read"]);
  assert.deepEqual(budget(ownerRead).filter((_, i) => i !== 2), ["4", "3", "read"]);
  assert.deepEqual(budget(botWrite).filter((_, i) => i !== 2), ["3", "2", "write"]);
  const refused = await get(path);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("x-ratelimit-remaining"), "0");
  assert.equal((await getOwner(path)).headers.get("x-ratelimit-remaining"), "2");
});

test("MCP response budget survives a body await while another request completes", { timeout: 5000 }, async t => {
  const { server, post, beginMcp } = await serve(t);
  const arrived = new Promise(resolve => server.once("request", resolve));
  const held = beginMcp();
  await arrived; // The real handler is now waiting for the final body byte.
  const other = await post("complete a different credential's request first");
  assert.equal(other.status, 201, await other.text());
  assert.equal(other.headers.get("x-ratelimit-bucket"), "write");
  held.finish();
  const response = await held.response;
  assert.equal(response.status, 200, response.body);
  assert.equal(response.headers["x-ratelimit-bucket"], "read");
  assert.equal(response.headers["x-ratelimit-limit"], "4");
  assert.equal(response.headers["x-ratelimit-remaining"], "3");
});

test("writes report the write bucket separately from reads", async t => {
  const { get, post } = await serve(t);
  const write = await post("hello");
  assert.equal(write.status, 201, await write.text());
  assert.equal(write.headers.get("x-ratelimit-bucket"), "write");
  assert.equal(write.headers.get("x-ratelimit-limit"), "3");
  assert.equal(write.headers.get("x-ratelimit-remaining"), "2");
  const read = await get("/api/rooms/commons/events?after=0");
  assert.equal(read.headers.get("x-ratelimit-bucket"), "read");
  assert.equal(read.headers.get("x-ratelimit-remaining"), "3", "a write did not spend the read budget");
});

test("success and refusal reset headers agree on when another request is allowed", async t => {
  const { post } = await serve(t);
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.timers.enable({ apis: ["Date"], now });
  let last;
  for (let n = 0; n < 3; n++) {
    last = await post(`reset check ${n}`);
    assert.equal(last.status, 201);
  }
  const refused = await post("same exhausted budget");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "1");
  assert.equal(last.headers.get("x-ratelimit-reset"), String(now / 1000 + 1),
    "an empty success budget must not tell callers to wait for a full refill");
  assert.equal(last.headers.get("x-ratelimit-reset"), refused.headers.get("x-ratelimit-reset"));
});

test("hosted MCP tool calls that spend the credential budget carry the same headers", async t => {
  const { mcp } = await serve(t);
  const response = await mcp("room_check_access", {});
  assert.equal(response.status, 200, await response.clone().text());
  const [limit, remaining, , bucket] = budget(response);
  assert.equal(limit, "4"); assert.equal(bucket, "read"); assert.equal(remaining, "3");
});

test("unauthenticated requests are unchanged: no credential budget headers", async t => {
  const { origin } = await serve(t);
  const response = await fetch(origin + "/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ratelimit-bucket"), null);
});
