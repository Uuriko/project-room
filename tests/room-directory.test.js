import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomDirectory, roomDirectorySchema, DIRECTORY_PAGE_LIMIT } from "../server/room-directory.mjs";
import { roomPublicFaceSchema } from "../server/public-face.mjs";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(roomDirectorySchema);
  db.exec(roomPublicFaceSchema);
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
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

test("feed setting is owner-only, independent of directory listing, and survives re-listing", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  assert.deepEqual(dir.opportunityStatus("r1", "owner"), { roomId: "r1", enabled: true });
  assert.equal(errOf(() => dir.opportunityStatus("r1", "alice")).code, "owner_only");
  assert.equal(errOf(() => dir.setOpportunities("r1", "alice", false)).code, "owner_only");
  assert.equal(errOf(() => dir.setOpportunities("r1", "owner", "false")).code, "invalid_opportunities");
  // Opting out before listing must not opt the room into the directory.
  assert.deepEqual(dir.setOpportunities("r1", "owner", false), { roomId: "r1", enabled: false });
  assert.deepEqual(dir.list().rooms, []);
  dir.set("r1", "owner", true);
  assert.equal(dir.list().rooms.length, 1);
  assert.equal(dir.opportunityStatus("r1", "owner").enabled, false);
  dir.set("r1", "owner", false);
  dir.set("r1", "owner", true);
  assert.equal(dir.opportunityStatus("r1", "owner").enabled, false);
  dir.setOpportunities("r1", "owner", true);
  assert.equal(dir.opportunityStatus("r1", "owner").enabled, true);
  assert.equal(errOf(() => dir.setOpportunities("missing", "owner", false)).code, "room_not_found");
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

test("public receipts visibility defaults to public and is owner-only", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  // Default: current behavior — receipts are public until the owner says otherwise.
  assert.equal(dir.publicReceiptsVisible("r1"), true);
  assert.equal(dir.publicReceiptsVisible("missing-room"), true);
  assert.equal(dir.status("r1", "owner").publicReceipts, true);
  assert.equal(errOf(() => dir.receiptsVisibility("r1", "alice")).code, "owner_only");
  assert.equal(errOf(() => dir.setReceiptsVisibility("r1", "alice", false)).code, "owner_only");
  assert.equal(errOf(() => dir.setReceiptsVisibility("r1", "owner", "false")).code, "invalid_public_receipts");
  assert.deepEqual(dir.setReceiptsVisibility("r1", "owner", false), { roomId: "r1", publicReceipts: false });
  assert.equal(dir.publicReceiptsVisible("r1"), false);
  assert.deepEqual(dir.receiptsVisibility("r1", "owner"), { roomId: "r1", publicReceipts: false });
  assert.equal(dir.status("r1", "owner").publicReceipts, false);
  // The directory listing bit is independent.
  assert.equal(dir.status("r1", "owner").discoverable, false);
  assert.deepEqual(dir.setReceiptsVisibility("r1", "owner", true), { roomId: "r1", publicReceipts: true });
  assert.equal(dir.publicReceiptsVisible("r1"), true);
  assert.equal(errOf(() => dir.receiptsVisibility("nope", "owner")).code, "room_not_found");
});

// ---- F-C5-1: hidden listings must not consume the LIMIT window ------------
// A projection-backed store: rooms carries the projection column the real
// store has, holding the same JSON the canned states describe (the real
// store's room() reads its state back out of that projection).
function makeProjectionStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(roomDirectorySchema);
  db.exec(roomPublicFaceSchema);
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, archived_at TEXT, projection TEXT)");
  const insertRoom = db.prepare("INSERT INTO rooms (id, archived_at, projection) VALUES (?, ?, ?)");
  for (const [id, entry] of Object.entries(states)) {
    insertRoom.run(id, entry.archived ? "2026-09-20" : null, JSON.stringify(entry.state));
  }
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

const unpublishRoom = (store, roomId) =>
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', ?, 1, 'operator')").run(roomId);

test("F-C5-1: list filters unpublished and empty-title rooms before LIMIT, so windows never reveal suppressed counts", () => {
  const store = makeProjectionStore({
    r01: stateFor("r01", { title: "Alpha" }),
    r02: stateFor("r02", { title: "Hidden room" }), // operator-unpublished
    r03: stateFor("r03", { title: "   " }), // space-only title
    r04: stateFor("r04", { title: "" }), // empty title AND operator-unpublished
    r05: stateFor("r05", { title: "\t " }), // title JS trim removes but bare SQLite TRIM does not
    r06: stateFor("r06", { title: 123 }), // non-string title: cleanText rejects it
    r07: stateFor("r07", { title: "Echo" }),
    r08: stateFor("r08", { title: "Foxtrot" }),
    r09: stateFor("r09", { title: "Ghost" }), // projection corrupted below (#4126 shape)
  });
  const dir = new RoomDirectory(store);
  for (const id of ["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08", "r09"]) dir.set(id, "owner", true);
  unpublishRoom(store, "r02");
  unpublishRoom(store, "r04");
  // A quarantined corrupt projection must be skipped, never throw the list.
  store.db.prepare("UPDATE rooms SET projection = 'not json' WHERE id = 'r09'").run();
  // At base this first page was [r01] with nextCursor r02: the suppressed
  // r02 consumed the window and the short page + cursor leaked that a
  // listing had been suppressed inside it.
  const first = dir.list({ limit: 2 });
  assert.deepEqual(first.rooms.map(r => r.roomId), ["r01", "r07"]);
  assert.equal(first.nextCursor, "r07");
  const second = dir.list({ after: first.nextCursor, limit: 2 });
  assert.deepEqual(second.rooms.map(r => r.roomId), ["r08"]);
  assert.equal(second.nextCursor, null);
  // A full walk visits exactly the three visible rooms, once each.
  const walked = [];
  let cursor = null;
  do {
    const page = dir.list({ after: cursor, limit: 2 });
    walked.push(...page.rooms.map(r => r.roomId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(walked, ["r01", "r07", "r08"]);
  assert.ok(!JSON.stringify(walked).includes("Hidden"), "no suppressed listing leaks");
});

test("F-C5-1: minimal store without a rooms.projection column still lists via the JS authority", () => {
  // makeStore's rooms table has no projection column: the SQL title leg
  // must stay off (PRAGMA probe) and _publicEntry's JS checks remain the
  // authority — unpublished and blank-title rooms stay hidden, visible
  // rooms still list, and nothing throws on the missing column.
  const store = makeStore({
    m1: stateFor("m1", { title: "Visible one" }),
    m2: stateFor("m2", { title: "Hidden room" }),
    m3: stateFor("m3", { title: "" }),
    m4: stateFor("m4", { title: "Visible two" }),
  });
  const dir = new RoomDirectory(store);
  for (const id of ["m1", "m2", "m3", "m4"]) dir.set(id, "owner", true);
  unpublishRoom(store, "m2");
  const { rooms, nextCursor } = dir.list();
  assert.deepEqual(rooms.map(r => r.roomId), ["m1", "m4"]);
  assert.equal(nextCursor, null);
});

test("public receipts column migrates onto pre-existing directory tables", () => {
  const store = makeStore({ r1: stateFor("r1") });
  store.db.exec("ALTER TABLE room_directory_settings DROP COLUMN public_receipts");
  const dir = new RoomDirectory(store);
  // Reads on the old schema still work and default to public (current behavior).
  assert.equal(dir.publicReceiptsVisible("r1"), true);
  assert.equal(dir.status("r1", "owner").publicReceipts, true);
  // The first write re-adds the column; the value sticks.
  assert.deepEqual(dir.setReceiptsVisibility("r1", "owner", false), { roomId: "r1", publicReceipts: false });
  assert.equal(dir.publicReceiptsVisible("r1"), false);
  const columns = new Set(store.db.prepare("PRAGMA table_info(room_directory_settings)").all().map(c => c.name));
  assert.ok(columns.has("public_receipts"));
});
