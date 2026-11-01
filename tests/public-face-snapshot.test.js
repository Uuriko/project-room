// RR-D6: PublicFace snapshot generation. The sanitized face/feed payloads
// are derived once per room sequence and memoised; the visibility gates
// (enabled code, operator unpublish, archived, owner disable) are still
// re-checked on every request. Failing-first: at pre-change main every
// call re-derives from live state, so the "unchanged sequence serves the
// snapshot" assertions fail there.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PublicFace, roomPublicFaceSchema } from "../server/public-face.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";
import { publicUnpublishSchema, unpublishPublic } from "../server/legal-store.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(records) {
  const db = new DatabaseSync(":memory:");
  db.exec(roomPublicFaceSchema);
  db.exec(roomDirectorySchema);
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const rec = records[id];
      return rec ? { sequence: rec.sequence, state: rec.state } : null;
    }
  };
}

const baseState = () => ({
  room: { id: "r1", title: "Build week", purpose: "Ship the thing", ownerId: "owner", createdAt: 1000 },
  members: {
    owner: member("owner", "Olivia Owner"),
    alice: member("alice", "Alice"),
    bob: member("bob", "Bob")
  },
  messages: [
    { id: "m1", authorId: "alice", body: "hello room", createdAt: 10 },
    { id: "m2", authorId: "alice", toMemberId: "bob", body: "secret dm", createdAt: 11 },
    { id: "m3", authorId: "bob", body: null, createdAt: 12 },
    { id: "m4", authorId: "bob", body: "public update", createdAt: 13 }
  ]
});

const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("face is derived once per sequence; a sequence bump re-derives", () => {
  const rec = { sequence: 7, state: baseState() };
  const store = makeStore({ r1: rec });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const first = face.faceByCode(publicCode);
  assert.equal(first.room.title, "Build week");
  assert.deepEqual(first.messages.map(m => m.body), ["hello room", "public update"]);
  // Mutate the live state WITHOUT bumping the sequence (stands in for
  // "the room did not change"): a per-request derivation would serve the
  // mutation; the snapshot must serve what was derived at sequence 7.
  rec.state.room.title = "Mutated title";
  rec.state.messages.push({ id: "m5", authorId: "alice", body: "sneaked in", createdAt: 14 });
  const second = face.faceByCode(publicCode);
  assert.equal(second.room.title, "Build week");
  assert.deepEqual(second.messages.map(m => m.body), ["hello room", "public update"]);
  assert.ok(second.fetchedAt >= first.fetchedAt); // fetchedAt is re-stamped, never memoised stale
  // Any real change bumps the sequence: the next read re-derives.
  rec.sequence = 8;
  const third = face.faceByCode(publicCode);
  assert.equal(third.room.title, "Mutated title");
  assert.deepEqual(third.messages.map(m => m.body), ["hello room", "public update", "sneaked in"]);
});

test("feed pages from the snapshot with identical cursor semantics", () => {
  const rec = { sequence: 3, state: baseState() };
  const store = makeStore({ r1: rec });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const page1 = face.feedByCode(publicCode, { limit: 1 });
  assert.deepEqual(page1.messages.map(m => m.id), ["m1"]);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.next, "m1");
  const page2 = face.feedByCode(publicCode, { after: page1.next, limit: 50 });
  assert.deepEqual(page2.messages.map(m => m.id), ["m4"]);
  assert.equal(page2.hasMore, false);
  // A DM id and an unknown id are both invalid cursors, snapshot or not.
  assert.equal(errOf(() => face.feedByCode(publicCode, { after: "m2" })).code, "invalid_feed_cursor");
  assert.equal(errOf(() => face.feedByCode(publicCode, { after: "nope" })).code, "invalid_feed_cursor");
  assert.equal(errOf(() => face.feedByCode(publicCode, { after: 42 })).code, "invalid_feed_cursor");
});

test("visibility gates bite on the very next request after a snapshot is warm", () => {
  const rec = { sequence: 5, state: baseState() };
  const store = makeStore({ r1: rec });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(face.faceByCode(publicCode).room.title, "Build week"); // warm the snapshot
  // Operator unpublish: no sequence bump, no content change — still 404.
  unpublishPublic(store.db, { kind: "room", id: "r1", byAccount: "operator", now: Date.now() });
  assert.equal(errOf(() => face.faceByCode(publicCode)).code, "face_not_found");
  assert.equal(errOf(() => face.feedByCode(publicCode)).code, "face_not_found");
});

test("owner disable and archive hide a warm snapshot immediately", () => {
  const rec = { sequence: 5, state: baseState() };
  const store = makeStore({ r1: rec });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(face.faceByCode(publicCode).room.title, "Build week");
  face.disable("r1", "owner");
  assert.equal(errOf(() => face.faceByCode(publicCode)).code, "face_not_found");
  const again = face.enable("r1", "owner");
  assert.equal(face.faceByCode(again.publicCode).room.title, "Build week");
  rec.state.room.archivedAt = "2026-10-28T00:00:00.000Z";
  assert.equal(errOf(() => face.faceByCode(again.publicCode)).code, "face_not_found");
});

test("a projection-byte rewrite at the SAME sequence re-derives (RR-C3 §3.2 leg)", () => {
  // Repair/archive/history-replacement writes can rewrite the projection
  // without advancing the sequence. With a readable rooms row the memo is
  // keyed by the projection bytes, so the rewrite alone invalidates it.
  const rec = { sequence: 7, state: baseState() };
  const store = makeStore({ r1: rec });
  store.db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL, archived_at TEXT)");
  store.db.prepare("INSERT INTO rooms (id, sequence, projection) VALUES ('r1', 7, ?)").run(JSON.stringify(rec.state));
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(face.faceByCode(publicCode).room.title, "Build week");
  rec.state.room.title = "Repaired title";
  // Same sequence, new bytes — the repair-path shape.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='r1'").run(JSON.stringify(rec.state));
  assert.equal(rec.sequence, 7);
  assert.equal(face.faceByCode(publicCode).room.title, "Repaired title");
});

test("a store without sequences derives on every call (pre-change behaviour)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(roomPublicFaceSchema);
  db.exec(roomDirectorySchema);
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  const state = baseState();
  const store = {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) { return state && id === "r1" ? { state } : null; }
  };
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(face.faceByCode(publicCode).room.title, "Build week");
  state.room.title = "Live title";
  assert.equal(face.faceByCode(publicCode).room.title, "Live title");
});
