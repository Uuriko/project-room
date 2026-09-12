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

test("online import is unavailable even for an owner's unchanged export", async t => {
  const { request, importNdjson, ownerKey, agentKey } = await serve(t);
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const lineCount = ndjson.trim().split("\n").length;

  assert.equal((await importNdjson(ownerKey, "{}", "application/json")).status, 409);
  assert.equal((await importNdjson(ownerKey, ndjson + "not json\n")).status, 409);
  assert.equal((await importNdjson(agentKey, ndjson)).status, 409);

  // Even an unchanged history is not a complete authority backup.
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 409);
  assert.equal((await ok.json()).error.code, "recovery_requires_maintenance");
  const after = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.sequence, before.sequence);
});

test("rejected online import preserves cursors and projection checkpoints", async t => {
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
  assert.equal(ok.status, 409);

  // Neither cursors nor checkpoints are changed by the refused request.
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cursors WHERE room_id='commons'").get().n, 1);
  const checkpoint = store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id='commons'").get();
  assert.equal(checkpoint.sequence, seq);
  assert.deepEqual(JSON.parse(checkpoint.projection), { stale: true });
});

test("online import refuses duplicate-event payload without parsing or writing", async t => {
  const { request, importNdjson, ownerKey, store } = await serve(t);
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const lines = ndjson.trim().split("\n");
  // Duplicate the first event but renumber sequences so they stay dense —
  // this isolates the duplicate-id check from the sequence check.
  const dup = lines.concat(JSON.stringify({ ...JSON.parse(lines[0]), sequence: lines.length + 1 }));
  const before = store.room("commons").sequence;
  const res = await importNdjson(ownerKey, dup.join("\n") + "\n");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "recovery_requires_maintenance");
  // Failed import writes nothing: room untouched.
  assert.equal(store.room("commons").sequence, before);
});

test("large export remains available while online replacement is refused", async t => {
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
  assert.equal(ok.status, 409);
  assert.equal((await ok.json()).error.code, "recovery_requires_maintenance");
  const after = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.sequence, before.sequence);
});

test("malformed imports receive a stable maintenance requirement", async t => {
  const { importNdjson, ownerKey } = await serve(t);
  const brokenSequence = JSON.stringify({ sequence: 99, event: { id: "x", roomId: "commons", type: "MESSAGE_POSTED", actorId: "a", at: 1 } });
  let res = await importNdjson(ownerKey, brokenSequence);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "recovery_requires_maintenance");
  const malformed = JSON.stringify({ sequence: 1, event: { id: "y", roomId: "commons" } });
  res = await importNdjson(ownerKey, malformed);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "recovery_requires_maintenance");
  // Duplicate ids across lines: clean invalid_import, no partial writes.
  const dup = [1, 2].map(i => JSON.stringify({ sequence: i, event: { id: "same", roomId: "commons", type: "MESSAGE_POSTED", actorId: "a", at: 1 } })).join("\n");
  res = await importNdjson(ownerKey, dup);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "recovery_requires_maintenance");
});

test("old online export cannot resurrect revoked access or invoke the legacy importer", async t => {
  const { request, importNdjson, ownerKey, agentKey, store } = await serve(t);
  const oldExport = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "agent", expectedMemberRevision: store.room("commons").state.members.agent.revision,
      permissions: ["accept_work"], active: false } });
  const before = JSON.stringify(store.room("commons"));
  let invoked = false;
  store.importEvents = () => { invoked = true; throw new Error("Legacy importer must be unreachable from HTTP"); };
  const response = await importNdjson(ownerKey, oldExport);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "recovery_requires_maintenance");
  assert.equal(invoked, false);
  assert.equal(JSON.stringify(store.room("commons")), before);
  assert.throws(() => store.authenticate(agentKey, "commons"));
  assert.equal((await request("/api/rooms/commons/import", { method: "POST", data: {} })).status, 401);
});
