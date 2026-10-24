import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomDirectory, roomDirectorySchema, DIRECTORY_PAGE_LIMIT } from "../server/room-directory.mjs";
import { roomPublicFaceSchema } from "../server/public-face.mjs";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";
import { publicRoomView } from "../server/public-rooms.mjs";
import { roomProofView } from "../server/proof-page.mjs";

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

// Listing follows the serving predicate (P-10): a room is listed only
// while its public page row exists with public receipts on — the row
// syncRoomPublication upserts when the owner publishes the page. Tests
// that expect a room in the listing publish its page row here.
function publishPage(store, roomId, { receiptsEnabled = 1 } = {}) {
  store.db.prepare(`INSERT INTO public_rooms
    (slug, title, purpose, humans, agents, names_json, tasks_json, members_json,
     receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?, ?, '', 1, 0, '[]', '[]', '[]', ?, 'request', NULL, 'owner', NULL, '2026-10-01T00:00:00.000Z')`)
    .run(roomId, `Room ${roomId}`, receiptsEnabled);
}

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
  publishPage(store, "r1");
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
  publishPage(store, "r1");
  publishPage(store, "r2");
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
  for (const id of Object.keys(states)) { publishPage(store, id); dir.set(id, "owner", true); }
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
import { syncRoomPublication } from "../server/public-read-model.mjs";

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
  const { store, call, ownerToken } = await httpFixture(t);
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
  // Discovery opt-in alone does not list the room (P-10): the listing
  // follows the serving predicate, and no public page exists yet, so a
  // listing here would promise a /r/commons that 404s.
  const unpublished = await call("GET", "/api/public/rooms/directory");
  assert.equal(unpublished.status, 200);
  assert.deepEqual(unpublished.body.rooms, []);
  // The owner publishes the room page with public receipts on; the read
  // model's sync is what writes the row the listing (and the page) read.
  const state = store.room("commons").state;
  syncRoomPublication(store, {
    roomId: "commons",
    state: { ...state, room: { ...state.room, publicPage: { enabled: true, revision: 1 }, publicReceipts: { enabled: true, revision: 1 } } },
    previous: null,
  });
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

// ---- Directory <-> room-page conformance (P-10) -------------------------
// The directory and the public room pages (/r/<id>, /r/<id>/proof) are
// two consumers of one fact — "this room is public" — and they drifted
// apart once already: the directory listed rooms whose owners had opted
// into discovery but never published a page, so every listed room 404ed
// at its canonical URL (verified live in production, X-RAY UX-FRICTION
// register #1). The invariant pinned here, walked end to end over the
// real consumers: every room the directory lists resolves at the room
// page AND at the proof page; a room failing any part of the serving
// predicate is not listed.

function listAllIds(dir) {
  const ids = [];
  let after = null;
  for (let hops = 0; hops < 20; hops += 1) {
    const page = dir.list({ after, limit: 1 });
    ids.push(...page.rooms.map(room => room.roomId));
    if (!page.nextCursor) return ids;
    after = page.nextCursor;
  }
  throw new Error("directory pagination did not terminate");
}

test("conformance: every directory-listed room resolves at its room page and its proof page", () => {
  const store = makeStore({
    "aa-full": stateFor("aa-full"),
    "bb-nopage": stateFor("bb-nopage"),
    "cc-noreceipts": stateFor("cc-noreceipts"),
    "dd-unpublished": stateFor("dd-unpublished"),
    "ee-archived": { ...stateFor("ee-archived"), archived: true },
    "ff-unlisted": stateFor("ff-unlisted"),
  });
  const dir = new RoomDirectory(store);
  // Every room opts into the directory, the way the production rooms did.
  for (const id of ["aa-full", "bb-nopage", "cc-noreceipts", "dd-unpublished", "ee-archived"]) {
    dir.set(id, "owner", true);
  }
  // Page publication is the separate opt-in that drifted from listing:
  publishPage(store, "aa-full"); // page on, receipts on — the full public surface
  // bb-nopage: discoverable only — the production P-10 shape. No page row.
  publishPage(store, "cc-noreceipts", { receiptsEnabled: 0 }); // page on, receipts off: proof 404s
  publishPage(store, "dd-unpublished"); // page on, receipts on, but operator-unpublished below
  publishPage(store, "ee-archived"); // page on, receipts on, but archived
  publishPage(store, "ff-unlisted"); // page on, receipts on, but never opted into the directory
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'dd-unpublished', 1, 'op')").run();

  const listed = listAllIds(dir);
  assert.deepEqual(listed, ["aa-full"],
    "the directory lists exactly the rooms whose page and proof both serve");

  // The conformance walk itself: follow every listed room to both pages
  // through the real serving functions the /r/ routes call.
  for (const roomId of listed) {
    assert.ok(publicRoomView(store, roomId), `/r/${roomId} must serve for a listed room`);
    const proof = roomProofView(store, roomId);
    assert.ok(proof && !proof.error, `/r/${roomId}/proof must serve for a listed room`);
  }
});

test("conformance: a listed room drops out of the directory when its page stops serving", () => {
  const store = makeStore({ "aa-full": stateFor("aa-full") });
  const dir = new RoomDirectory(store);
  dir.set("aa-full", "owner", true);
  publishPage(store, "aa-full");
  assert.deepEqual(listAllIds(dir), ["aa-full"]);

  // Owner turns public receipts off: the read model rewrites the row
  // with receipts_enabled = 0 (and deletes it entirely when the page
  // itself goes off). Either way the listing follows the serving truth.
  store.db.prepare("UPDATE public_rooms SET receipts_enabled = 0 WHERE slug = 'aa-full'").run();
  assert.deepEqual(listAllIds(dir), []);
  store.db.prepare("DELETE FROM public_rooms WHERE slug = 'aa-full'").run();
  assert.deepEqual(listAllIds(dir), []);
});
