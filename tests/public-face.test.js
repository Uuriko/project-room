import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PublicFace, roomPublicFaceSchema, PUBLIC_CODE_PREFIX } from "../server/public-face.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(roomPublicFaceSchema);
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const state = states[id];
      return state ? { state } : null;
    }
  };
}

const baseState = () => ({
  room: { id: "r1", title: "Build week", purpose: "Ship the thing", ownerId: "owner", createdAt: 1000 },
  members: {
    owner: member("owner", "Olivia Owner"),
    alice: { ...member("alice", "Alice"), email: "alice@example.com", identityId: "idt_1" },
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

test("enable mints a pub1. code; only the owner may toggle", () => {
  const store = makeStore({ r1: baseState() });
  const face = new PublicFace(store);
  assert.equal(errOf(() => face.enable("r1", "alice")).code, "owner_only");
  const enabled = face.enable("r1", "owner");
  assert.equal(enabled.enabled, true);
  assert.ok(enabled.publicCode.startsWith(PUBLIC_CODE_PREFIX));
  const again = face.enable("r1", "owner");
  assert.equal(again.publicCode, enabled.publicCode); // idempotent
  const status = face.status("r1", "owner");
  assert.equal(status.enabled, true);
  assert.equal(status.publicCode, enabled.publicCode);
  assert.equal(errOf(() => face.status("r1", "alice")).code, "owner_only");
});

test("rotate replaces the code; old code 404s", () => {
  const store = makeStore({ r1: baseState() });
  const face = new PublicFace(store);
  assert.equal(errOf(() => face.rotate("r1", "owner")).code, "face_not_enabled");
  const first = face.enable("r1", "owner");
  const rotated = face.rotate("r1", "owner");
  assert.notEqual(rotated.publicCode, first.publicCode);
  assert.equal(errOf(() => face.faceByCode(first.publicCode)).code, "face_not_found");
  assert.ok(face.faceByCode(rotated.publicCode).room.title.length > 0);
});

test("disable nulls the code; face 404s afterwards", () => {
  const store = makeStore({ r1: baseState() });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(errOf(() => face.disable("r1", "alice")).code, "owner_only");
  const off = face.disable("r1", "owner");
  assert.equal(off.enabled, false);
  assert.equal(off.publicCode, null);
  assert.equal(errOf(() => face.faceByCode(publicCode)).code, "face_not_found");
});

test("sanitize: DMs excluded, handles only, no ids/emails, bodies capped", () => {
  const store = makeStore({ r1: baseState() });
  const face = new PublicFace(store);
  const snap = face.sanitize(store.room("r1").state);
  assert.equal(snap.room.title, "Build week");
  assert.deepEqual(snap.members, ["Alice", "Bob", "Olivia Owner"]);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("secret dm"), "DM body must not leak");
  assert.ok(!text.includes("alice@example.com"), "email must not leak");
  assert.ok(!text.includes("idt_1"), "identity id must not leak");
  assert.ok(!text.includes("toMemberId"), "DM marker must not leak");
  assert.equal(snap.messages.length, 2); // m1 + m4 (m2 DM, m3 deleted)
  assert.equal(snap.messages[0].from, "Alice");
  assert.ok(!("id" in snap.messages[0]), "message ids stay server-side in the snapshot");
});

test("long bodies truncate with a marker", () => {
  const state = baseState();
  state.messages.push({ id: "m9", authorId: "alice", body: "x".repeat(5000), createdAt: 20 });
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const snap = face.sanitize(store.room("r1").state);
  const long = snap.messages.find(m => m.body.length > 1000);
  assert.ok(long.body.endsWith(" …"));
  assert.ok(long.body.length <= 2004);
});

test("feedByCode paginates with cursor; DMs never appear", () => {
  const store = makeStore({ r1: baseState() });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const page1 = face.feedByCode(publicCode, { limit: 1 });
  assert.equal(page1.messages.length, 1);
  assert.equal(page1.messages[0].id, "m1");
  assert.equal(page1.hasMore, true);
  const page2 = face.feedByCode(publicCode, { after: page1.next, limit: 10 });
  assert.equal(page2.messages.length, 1);
  assert.equal(page2.messages[0].id, "m4");
  assert.equal(page2.hasMore, false);
  assert.equal(errOf(() => face.feedByCode(publicCode, { after: 42 })).code, "invalid_feed_cursor");
  assert.equal(errOf(() => face.feedByCode("pub1.nope")).code, "face_not_found");
  assert.equal(errOf(() => face.feedByCode("nope")).code, "face_not_found");
});

test("faceHtml escapes content and carries noindex", () => {
  const state = baseState();
  state.messages.push({ id: "m9", authorId: "alice", body: "<script>alert(1)</script>", createdAt: 20 });
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const html = face.faceHtml(publicCode);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("noindex"));
});
