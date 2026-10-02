import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Reads go through server/redact-read.mjs. One edited message and one deleted
// message: earlier wording is absent on every listed read, and the edited
// message's current body is still returned.

const PRIOR = "prior-edit-quill-7f3a";
const CURRENT = "current-body-quill-7f3b";
const DELETED_PRIOR = "prior-delete-quill-7f3c";
const DELETED_REVISED = "revised-delete-quill-7f3d";
const HIDDEN = [PRIOR, DELETED_PRIOR, DELETED_REVISED];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "read-redaction-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Read redaction");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName: "Reader", permissions: []
  });
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  cmd(T.MESSAGE_POSTED, { messageId: "kept", body: PRIOR });
  cmd(T.MESSAGE_EDITED, { messageId: "kept", body: CURRENT, expectedMessageRevision: 0 });
  cmd(T.MESSAGE_POSTED, { messageId: "gone", body: DELETED_PRIOR });
  cmd(T.MESSAGE_EDITED, { messageId: "gone", body: DELETED_REVISED, expectedMessageRevision: 0 });
  cmd(T.MESSAGE_DELETED, { messageId: "gone", expectedMessageRevision: 1, reason: "Remove it" });
  const server = createRoomServer({ store, streamInterval: 60_000 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, token = ownerKey) => fetch(origin + path, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` }
  });
  return { request, origin, ownerKey, secret: identity.secret };
}

function absent(label, text) {
  for (const hidden of HIDDEN) assert.equal(text.includes(hidden), false, `${label} still contains earlier wording`);
}

async function mcp(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

test("edited and deleted message text is absent from projection, events, MCP, and both exports", async t => {
  const { request, origin, secret } = await serve(t);

  const snapshotRes = await request("/api/rooms/commons");
  assert.equal(snapshotRes.status, 200);
  const snapshotText = await snapshotRes.text();
  const snapshot = JSON.parse(snapshotText);
  absent("projection", snapshotText);
  const kept = snapshot.state.messages.find(message => message.id === "kept");
  const gone = snapshot.state.messages.find(message => message.id === "gone");
  assert.equal(kept.body, CURRENT);
  assert.equal(JSON.stringify(kept.editHistory ?? []).includes(PRIOR), false);
  assert.equal(gone.body, null);
  assert.ok(gone.deletedAt);

  const eventsRes = await request("/api/rooms/commons/events?after=0&limit=100");
  assert.equal(eventsRes.status, 200);
  const eventsText = await eventsRes.text();
  const events = JSON.parse(eventsText);
  absent("events", eventsText);
  const bodies = messageId => events.events
    .filter(entry => entry.event?.data?.messageId === messageId && Object.hasOwn(entry.event.data, "body"))
    .map(entry => entry.event.data.body);
  assert.deepEqual(bodies("kept"), [CURRENT, CURRENT]);
  assert.deepEqual(bodies("gone"), [null, null]);

  const briefRes = await request("/api/rooms/commons/return-brief");
  assert.equal(briefRes.status, 200);
  absent("return brief", await briefRes.text());

  const streamRes = await request("/api/rooms/commons/stream?after=0");
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  const started = Date.now();
  while (!streamed.includes(CURRENT) && Date.now() - started < 2000) {
    const chunk = await reader.read();
    if (chunk.done) break;
    streamed += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  absent("stream", streamed);
  assert.equal(streamed.includes(CURRENT), true);

  const listed = await mcp(origin, "room_list_events", { roomId: "commons", after: 0, limit: 100 }, secret);
  assert.equal(listed.status, 200);
  const listedText = JSON.stringify(listed.body);
  absent("MCP room_list_events", listedText);
  assert.equal(listedText.includes(CURRENT), true);
  const read = await mcp(origin, "room_read_messages", { roomId: "commons", after: 0, limit: 100 }, secret);
  assert.equal(read.status, 200);
  const readText = JSON.stringify(read.body);
  absent("MCP room_read_messages", readText);
  assert.equal(read.value.messages.find(message => message.messageId === "kept").body, CURRENT);

  const jsonlRes = await request("/api/rooms/commons/export");
  assert.equal(jsonlRes.status, 200);
  const jsonl = await jsonlRes.text();
  absent("export jsonl", jsonl);
  const exported = jsonl.trim().split("\n").map(line => JSON.parse(line).event);
  assert.equal(exported.find(event => event.type === T.MESSAGE_POSTED && event.data.messageId === "kept").data.body, CURRENT);
  assert.equal(exported.find(event => event.type === T.MESSAGE_POSTED && event.data.messageId === "gone").data.body, null);

  const htmlRes = await request("/api/rooms/commons/export?format=html");
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  absent("export html", html);
  assert.match(html, new RegExp(CURRENT));
  assert.match(html, /Message deleted/);
});
