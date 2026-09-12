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

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-export-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const importNdjson = (token, body, contentType = "application/x-ndjson") =>
    fetch(origin + "/api/rooms/commons/import", {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body
    });
  return { request, importNdjson, ownerKey, agentKey, store };
}

test("room export streams the full event log as JSONL", async t => {
  const { request, ownerKey, agentKey, store } = await serve(t);
  const res = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
  const ndjson = await res.text();
  const lines = ndjson.trim().split("\n");
  const events = lines.map(l => JSON.parse(l));
  // Sequences are dense and ordered.
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.ok(events.every(e => e.event && e.event.type && e.event.actorId && e.event.at));
  // Matches what the events route reports.
  const { next } = store.eventsAfter(ownerKey, "commons", 0, 100);
  assert.equal(events.at(-1).sequence, next);
  // A non-member gets nothing.
  assert.equal((await request("/api/rooms/commons/export")).status, 401);
  // Members can export too (same visibility as the events route).
  assert.equal((await request("/api/rooms/commons/export", { token: agentKey })).status, 200);
  return ndjson;
});

test("room import round-trips an export (round-2 #107)", async t => {
  const { request, importNdjson, ownerKey, agentKey } = await serve(t);
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const lineCount = ndjson.trim().split("\n").length;

  // Wrong content type rejected.
  assert.equal((await importNdjson(ownerKey, "{}", "application/json")).status, 415);
  // Corrupt line rejected before anything is written.
  assert.equal((await importNdjson(ownerKey, ndjson + "not json\n")).status, 422);
  // Non-owner rejected.
  assert.equal((await importNdjson(agentKey, ndjson)).status, 403);

  // Owner round-trip: restore of the same history.
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { imported: lineCount, sequence: lineCount });
  const after = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.sequence, before.sequence);
});

test("room import resets cursors and refreshes the projection checkpoint", async t => {
  const { request, importNdjson, ownerKey, agentKey, store } = await serve(t);
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const seq = before.sequence;
  // Agent reads and marks caught-up: cursor + a stale checkpoint exist.
  store.markCaughtUp(agentKey, "commons", seq);
  store.db.exec("CREATE TABLE IF NOT EXISTS projection_checkpoints (room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, projection TEXT NOT NULL)");
  store.db.prepare("INSERT OR REPLACE INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)").run("commons", seq, JSON.stringify({ stale: true }));
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cursors WHERE room_id='commons'").get().n, 1);

  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 200);

  // Cursors reset; checkpoint replaced with the imported state.
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cursors WHERE room_id='commons'").get().n, 0);
  const checkpoint = store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id='commons'").get();
  assert.equal(checkpoint.sequence, seq);
  assert.deepEqual(JSON.parse(checkpoint.projection).members, before.state.members);
  // rebuildProjection still works off the fresh checkpoint.
  assert.equal(store.rebuildProjection("commons").sequence, seq);
});

test("room import rejects duplicate event ids cleanly", async t => {
  const { request, importNdjson, ownerKey, store } = await serve(t);
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const lines = ndjson.trim().split("\n");
  // Duplicate the first event but renumber sequences so they stay dense —
  // this isolates the duplicate-id check from the sequence check.
  const dup = lines.concat(JSON.stringify({ ...JSON.parse(lines[0]), sequence: lines.length + 1 }));
  const before = store.room("commons").sequence;
  const res = await importNdjson(ownerKey, dup.join("\n") + "\n");
  assert.equal(res.status, 422);
  assert.match(await res.text(), /duplicate event ids/);
  // Failed import writes nothing: room untouched.
  assert.equal(store.room("commons").sequence, before);
});

test("room import round-trips a large (1500-event) export", async t => {
  const { request, importNdjson, ownerKey, store } = await serve(t);
  for (let i = 0; i < 1500; i++) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: `bulk-${i}`, body: `bulk message ${i}` } });
  }
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const lineCount = ndjson.trim().split("\n").length;
  assert.ok(lineCount > 1500, `expected >1500 lines, got ${lineCount}`);
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { imported: lineCount, sequence: lineCount });
  const after = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.sequence, before.sequence);
});

test("database failures during import surface as clean invalid_import, not raw errors", async t => {
  const { importNdjson, ownerKey } = await serve(t);
  const brokenSequence = JSON.stringify({ sequence: 99, event: { id: "x", roomId: "commons", type: "MESSAGE_POSTED", actorId: "a", at: 1 } });
  let res = await importNdjson(ownerKey, brokenSequence);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_import");
  const malformed = JSON.stringify({ sequence: 1, event: { id: "y", roomId: "commons" } });
  res = await importNdjson(ownerKey, malformed);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_import");
  // Duplicate ids across lines: clean invalid_import, no partial writes.
  const dup = [1, 2].map(i => JSON.stringify({ sequence: i, event: { id: "same", roomId: "commons", type: "MESSAGE_POSTED", actorId: "a", at: 1 } })).join("\n");
  res = await importNdjson(ownerKey, dup);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_import");
});
