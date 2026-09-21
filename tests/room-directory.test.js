import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomDirectory, roomDirectorySchema, DIRECTORY_PAGE_LIMIT } from "../server/room-directory.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(roomDirectorySchema);
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, archived_at TEXT)");
  const insertRoom = db.prepare("INSERT INTO rooms (id, archived_at) VALUES (?, ?)");
  for (const [id, { archived = false }] of Object.entries(states)) insertRoom.run(id, archived ? "2026-09-20" : null);
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const entry = states[id];
      return entry ? { state: entry.state } : null;
    }
  };
}

const stateFor = (id, { ownerId = "owner", title = "Build week", purpose = "Ship the thing", kind = "personal" } = {}) => ({
  state: {
    room: { id, title, purpose, kind, ownerId, createdAt: 1000 },
    members: {
      [ownerId]: member(ownerId, "Olivia Owner"),
      alice: { ...member("alice", "Alice"), email: "alice@example.com", identityId: "idt_1" },
      ghost: member("ghost", "Ghost", false),
    },
  }
});

const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("owner toggles discoverability; non-owner is refused", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  assert.equal(errOf(() => dir.set("r1", "alice", true)).code, "owner_only");
  assert.equal(errOf(() => dir.status("r1", "alice")).code, "owner_only");
  assert.equal(errOf(() => dir.set("r1", "owner", "yes")).code, "invalid_directory");
  const on = dir.set("r1", "owner", true);
  assert.equal(on.discoverable, true);
  assert.ok(typeof on.listedAt === "number");
  const again = dir.set("r1", "owner", true);
  assert.equal(again.listedAt, on.listedAt); // idempotent, keeps original listedAt
  const status = dir.status("r1", "owner");
  assert.equal(status.discoverable, true);
  const off = dir.set("r1", "owner", false);
  assert.equal(off.discoverable, false);
  assert.equal(off.listedAt, null);
});

test("unknown room 404s on owner routes", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  assert.equal(errOf(() => dir.status("nope", "owner")).code, "room_not_found");
  assert.equal(errOf(() => dir.set("nope", "owner", true)).code, "room_not_found");
});

test("public listing shows only discoverable, non-archived rooms, sanitized", () => {
  const store = makeStore({
    r1: stateFor("r1"),
    r2: { ...stateFor("r2", { title: "Secret lab" }), archived: true },
    r3: stateFor("r3", { title: "Quiet room" }),
  });
  const dir = new RoomDirectory(store);
  dir.set("r1", "owner", true);
  dir.set("r2", "owner", true); // archived: must stay hidden
  // r3 never opted in
  const { rooms, nextCursor } = dir.list();
  assert.equal(nextCursor, null);
  assert.equal(rooms.length, 1);
  const [entry] = rooms;
  assert.deepEqual(Object.keys(entry).sort(), ["kind", "listedAt", "memberCount", "purpose", "roomId", "title"]);
  assert.equal(entry.roomId, "r1");
  assert.equal(entry.title, "Build week");
  assert.equal(entry.purpose, "Ship the thing");
  assert.equal(entry.kind, "personal");
  assert.equal(entry.memberCount, 2); // owner + alice; inactive ghost excluded
  assert.ok(typeof entry.listedAt === "number");
  const serialized = JSON.stringify(rooms);
  assert.ok(!serialized.includes("alice@example.com"), "no emails leak");
  assert.ok(!serialized.includes("idt_1"), "no identity ids leak");
  assert.ok(!serialized.includes("Olivia Owner"), "no member handles leak");
});

test("listing skips rooms whose state is unusable instead of 500ing", () => {
  const store = makeStore({ r1: { state: { room: { title: "", ownerId: "owner" }, members: {} } } });
  const dir = new RoomDirectory(store);
  dir.set("r1", "owner", true);
  const { rooms } = dir.list();
  assert.equal(rooms.length, 0); // blank title -> skipped
});

test("pagination cursors and limit clamping", () => {
  const states = {};
  for (let i = 1; i <= 5; i++) states[`r${i}`] = stateFor(`r${i}`, { title: `Room ${i}` });
  const store = makeStore(states);
  const dir = new RoomDirectory(store);
  for (const id of Object.keys(states)) dir.set(id, "owner", true);
  const first = dir.list({ limit: 2 });
  assert.equal(first.rooms.length, 2);
  assert.equal(first.rooms[0].roomId, "r1");
  assert.equal(first.rooms[1].roomId, "r2");
  assert.equal(first.nextCursor, "r2");
  const second = dir.list({ after: first.nextCursor, limit: 2 });
  assert.deepEqual(second.rooms.map(r => r.roomId), ["r3", "r4"]);
  assert.equal(second.nextCursor, "r4");
  const last = dir.list({ after: second.nextCursor, limit: 2 });
  assert.deepEqual(last.rooms.map(r => r.roomId), ["r5"]);
  assert.equal(last.nextCursor, null);
  // absent limit -> default page; oversized limit clamps; blank/invalid limit -> default
  assert.equal(dir.list().rooms.length, 5);
  assert.equal(dir.list({ limit: 1000 }).rooms.length, 5);
  assert.equal(dir.list({ limit: "" }).rooms.length, 5);
  assert.equal(dir.list({ limit: "nope" }).rooms.length, 5);
  assert.equal(errOf(() => dir.list({ after: "x".repeat(400) })).code, "invalid_cursor");
  assert.ok(DIRECTORY_PAGE_LIMIT >= 100);
});

// ---- HTTP surface: owner toggle + public listing through the real server ----

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-room-directory-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const call = (method, path, { token, data } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }),
  }).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));
  return { store, call, ownerToken: store.issueAccessKey("commons", "owner") };
}

test("HTTP: owner toggles directory; public listing serves it; unauthenticated toggle refused", async t => {
  const { call, ownerToken } = await httpFixture(t);
  // Empty directory first.
  const empty = await call("GET", "/api/public/rooms/directory");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.rooms, []);
  // Owner opts in.
  const on = await call("POST", "/api/rooms/commons/directory", { token: ownerToken, data: { discoverable: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.discoverable, true);
  assert.equal(on.body.roomId, "commons");
  // Owner status reflects it.
  const status = await call("GET", "/api/rooms/commons/directory", { token: ownerToken });
  assert.equal(status.status, 200);
  assert.equal(status.body.discoverable, true);
  // Public listing now carries the room, sanitized.
  const listed = await call("GET", "/api/public/rooms/directory");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.rooms.length, 1);
  const entry = listed.body.rooms[0];
  assert.equal(entry.roomId, "commons");
  assert.equal(entry.title, "Project Room Commons");
  assert.ok(!("members" in entry) && !("ownerId" in entry), "no member/owner data leaks");
  // Bad shapes rejected; unauthenticated refused; wrong method refused.
  const bad = await call("POST", "/api/rooms/commons/directory", { token: ownerToken, data: { discoverable: "yes" } });
  assert.equal(bad.status, 422);
  const anon = await call("POST", "/api/rooms/commons/directory", { data: { discoverable: true } });
  assert.ok([401, 403].includes(anon.status), `expected 401/403, got ${anon.status}`);
  const wrongMethod = await call("POST", "/api/public/rooms/directory", { data: {} });
  assert.equal(wrongMethod.status, 405);
  // Owner opts out; listing empties again.
  const off = await call("POST", "/api/rooms/commons/directory", { token: ownerToken, data: { discoverable: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.discoverable, false);
  const relisted = await call("GET", "/api/public/rooms/directory");
  assert.deepEqual(relisted.body.rooms, []);
});
