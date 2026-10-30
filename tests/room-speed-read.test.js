// Default room reads stay inside one window. A 2,000-message room must not
// ship the whole history, and the agent bootstrap is that same window.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { buildRoomBootstrap } from "../server/room-bootstrap.mjs";
import { fitWindowedSnapshot, SNAPSHOT_WINDOW_BYTES } from "../server/snapshot-window.mjs";
import { ROOM_WINDOW_ROUTES } from "../server/routes/room-window.mjs";

const WINDOW_BYTES = 30 * 1024;
const HARD_CEILING = 64 * 1024;

async function listening(t) {
  const f = createAcceptanceFixture();
  const rooms = new AgentRooms(f.store);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...f, rooms, origin };
}

test("a 2000-message room opens as a window under 30 KB, and bootstrap matches it", async t => {
  const f = await listening(t);
  f.store.roomFlood = { consume() {} };
  const owner = f.store.identities.create("Window reader");
  const created = f.rooms.create(owner.secret, {
    roomId: "speed-room", title: "Speed", purpose: "Window the read", kind: "personal", displayName: "Window reader"
  });
  const key = f.store.issueAccessKey(created.roomId, created.ownerMemberId);
  const body = `${"note ".repeat(80)}end`;
  for (let i = 0; i < 2000; i++) {
    f.store.command(key, created.roomId, { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: `${i} ${body}` } });
  }
  const headers = { Authorization: `Bearer ${key}` };
  const opened = await fetch(`${f.origin}/api/rooms/${created.roomId}`, { headers });
  assert.equal(opened.status, 200);
  const openedText = await opened.text();
  const openedBytes = Buffer.byteLength(openedText);
  assert.ok(openedBytes <= WINDOW_BYTES, `default read is ${openedBytes} bytes`);
  assert.ok(openedBytes <= HARD_CEILING, `default read exceeded 64 KB (${openedBytes})`);
  const snapshot = JSON.parse(openedText);
  assert.ok(snapshot.state.messages.length >= 1);
  assert.ok(snapshot.state.messages.length < 2000);
  assert.equal(snapshot.messagesWindow.mode, "recent");
  assert.equal(snapshot.messagesPage.hasMore, true);
  assert.equal(typeof snapshot.messagesPage.before, "number");
  assert.equal(snapshot.state.messages.some(message => message.body.includes("private")), false);

  const recent = await (await fetch(`${f.origin}/api/rooms/${created.roomId}?messages=recent`, { headers })).json();
  assert.deepEqual(recent.state.messages.map(message => message.id), snapshot.state.messages.map(message => message.id));

  const retired = await fetch(`${f.origin}/api/rooms/${created.roomId}?full=1`, { headers });
  assert.equal(retired.status, 422);
  assert.equal((await retired.json()).error.code, "invalid_snapshot_view");

  const page = await (await fetch(`${f.origin}/api/rooms/${created.roomId}/messages?before=${snapshot.messagesPage.before}&limit=100`, { headers })).json();
  assert.equal(page.messagesVersion, 1);
  assert.ok(page.messages.length >= 1);
  assert.equal(page.messages.some(message => snapshot.state.messages.some(shown => shown.id === message.id)), false);

  const boot = await (await fetch(`${f.origin}/api/rooms/${created.roomId}/bootstrap`, { headers })).json();
  assert.equal(boot.bootstrapVersion, 1);
  assert.deepEqual(boot.snapshot.state.messages.map(message => message.id), snapshot.state.messages.map(message => message.id));
  assert.equal(boot.presence.available, true);
  assert.equal(boot.readHorizon.available, true);
  assert.equal(boot.saved.available, true);
  assert.equal(boot.updates.available, true);
  assert.ok(Buffer.byteLength(JSON.stringify(boot.snapshot)) <= HARD_CEILING);

  const mcp = await fetch(`${f.origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_read_bootstrap", arguments: { roomId: created.roomId } } })
  });
  const rpc = await mcp.json();
  const value = rpc.result?.structuredContent;
  assert.equal(value?.bootstrapVersion, 1, JSON.stringify(rpc.error ?? rpc.result ?? rpc).slice(0, 400));
  assert.deepEqual(value.snapshot.state.messages.map(message => message.id), snapshot.state.messages.map(message => message.id));
  assert.ok(Buffer.byteLength(JSON.stringify(value.snapshot)) <= HARD_CEILING);
});

test("the shared window fitter and bootstrap builder are the modules the read uses", () => {
  assert.equal(typeof buildRoomBootstrap, "function");
  assert.deepEqual(ROOM_WINDOW_ROUTES.map(row => `${row.method} ${row.path}`), [
    "GET /api/rooms/{roomId}/conversations",
    "GET /api/rooms/{roomId}/bootstrap",
    "GET /api/rooms/{roomId}/messages"
  ]);
  const messages = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, body: "x".repeat(800) }));
  const eventLog = messages.map(message => ({ type: "message.posted", data: { body: message.body, messageId: message.id } }));
  const fitted = fitWindowedSnapshot({
    messagesWindow: { mode: "recent", limit: messages.length, omitted: 0, older: "conversation" },
    state: { messages, eventLog }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= SNAPSHOT_WINDOW_BYTES);
  assert.ok(fitted.state.messages.length >= 1);
  assert.ok(fitted.state.messages.length < messages.length);
});

// A reply and its channel copy share a posting sequence. A page boundary
// between them must preserve both records, including after compaction.
for (const limit of [1,100]) test(`message pages continue through shared sequences before and after archive (limit ${limit})`, async t => {
  const f = await listening(t);
  f.store.roomFlood = { consume() {} };
  for (const [id, extra] of [["cursor-root", {}], ["cursor-reply", { replyToId: "cursor-root", alsoSendToChannel: true }]]) {
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: id, body: limit === 100 ? id + "x".repeat(12000) : id, ...extra } });
  }
  const headers = { Authorization: `Bearer ${f.keys.owner}` };
  const get = async query => {
    const response = await fetch(`${f.origin}/api/rooms/commons/messages?${query}`, { headers });
    assert.equal(response.status, 200); return response.json();
  };
  const walk = async () => {
    const ids = []; let query = `limit=${limit}`;
    for (let i=0; i<20; i++) {
      const page = await get(query);
      ids.unshift(...page.messages.map(message => message.id));
      if (!page.messagesPage.hasMore) return ids;
      const { before, beforeId } = page.messagesPage;
      assert.ok(Number.isSafeInteger(before)); assert.equal(typeof beforeId, "string");
      query = new URLSearchParams({ limit: String(limit), before: String(before), beforeId }).toString();
    }
    assert.fail("cursor did not converge");
  };
  const before = await walk();
  assert.deepEqual(before.slice(-3), ["cursor-root", "cursor-reply", "cursor-reply:channel"]);
  while (!f.store.backfillMessages({limit:1000}).done) { /* certify archive */ }
  assert.equal(f.store.checkMessagesParity().ok,true);
  assert.equal(f.store.archiveMessages("commons",{keepNewest:1,dryRun:false}).ok,true);
  assert.deepEqual(await walk(),before);
  const malformed = await fetch(`${f.origin}/api/rooms/commons/messages?beforeId=cursor-reply`,{headers});
  assert.equal(malformed.status,422);
});
