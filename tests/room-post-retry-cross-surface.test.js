// REL-15: a retried room post with the same command id never double-posts,
// whichever surface (REST or MCP) sent the first try and the retry.
// The receipt is keyed by (room, actor, command id) with a content fingerprint.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-post-retry-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const owner = store.identities.create("Retry owner");
  const created = new AgentRooms(store).create(owner.secret, {
    roomId: "retry-den", title: "Retry den", purpose: "Cross-surface retries", kind: "personal", displayName: "Retry owner"
  });
  const roomId = created.roomId;
  // One identity on both surfaces, so REST and MCP act as the same member.
  const key = owner.secret;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rest = async (id, messageId, body) => {
    const response = await fetch(`${origin}/api/rooms/${roomId}/commands`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, type: "message.posted", data: { messageId, body } })
    });
    return { status: response.status, json: await response.json() };
  };
  const mcp = async (id, messageId, body) => {
    const response = await fetch(`${origin}/room/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call",
        params: { name: "room_post_message", arguments: { roomId, id, messageId, body } } })
    });
    const json = await response.json();
    return { status: response.status, json, value: json.result?.structuredContent };
  };
  const posts = messageId => store.db.prepare(
    "SELECT count(*) AS n FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')=?"
  ).get(roomId, messageId).n;
  const receipts = id => store.db.prepare("SELECT count(*) AS n FROM commands WHERE room_id=? AND id=?").get(roomId, id).n;
  return { rest, mcp, posts, receipts };
}

test("REST first, MCP retry: one post, the retry is a duplicate at the same sequence", async t => {
  const { rest, mcp, posts, receipts } = await serve(t);
  const first = await rest("retry-a", "msg-a", "hello once");
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);
  const retry = await mcp("retry-a", "msg-a", "hello once");
  assert.equal(retry.value.status, "duplicate");
  assert.equal(retry.value.duplicate, true);
  assert.equal(retry.value.sequence, first.json.sequence);
  assert.equal(posts("msg-a"), 1);
  assert.equal(receipts("retry-a"), 1);
});

test("MCP first, REST retry: one post, REST answers 200 duplicate", async t => {
  const { rest, mcp, posts, receipts } = await serve(t);
  const first = await mcp("retry-b", "msg-b", "hello once");
  assert.equal(first.value.status, "posted");
  const retry = await rest("retry-b", "msg-b", "hello once");
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.sequence, first.value.sequence);
  assert.equal(posts("msg-b"), 1);
  assert.equal(receipts("retry-b"), 1);
});

test("same id with different content is refused on both surfaces and posts nothing new", async t => {
  const { rest, mcp, posts } = await serve(t);
  await rest("retry-c", "msg-c", "original");
  const restConflict = await rest("retry-c", "msg-c", "edited");
  assert.equal(restConflict.status, 409);
  assert.equal(restConflict.json.error?.code ?? restConflict.json.code, "idempotency_conflict");
  const mcpConflict = await mcp("retry-c", "msg-c", "edited");
  assert.ok(mcpConflict.json.error || mcpConflict.json.result?.isError, "MCP refuses the changed retry");
  assert.match(JSON.stringify(mcpConflict.json), /idempotency_conflict|already used for different content/);
  assert.equal(posts("msg-c"), 1);
});

test("parallel retries across REST and MCP land exactly one post", async t => {
  const { rest, mcp, posts, receipts } = await serve(t);
  const tries = await Promise.all([
    rest("retry-d", "msg-d", "burst"), mcp("retry-d", "msg-d", "burst"),
    rest("retry-d", "msg-d", "burst"), mcp("retry-d", "msg-d", "burst")
  ]);
  const sequences = new Set(tries.map(r => r.json.sequence ?? r.value?.sequence));
  assert.equal(sequences.size, 1, "every try names the same sequence");
  const fresh = tries.filter(r => (r.json.duplicate ?? r.value?.duplicate) === false).length;
  assert.equal(fresh, 1, "exactly one try posted; the rest are duplicates");
  assert.equal(posts("msg-d"), 1);
  assert.equal(receipts("retry-d"), 1);
});
