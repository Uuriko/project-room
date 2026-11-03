import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PublicFace, roomPublicFaceSchema, PUBLIC_CODE_PREFIX } from "../server/public-face.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";
import { publicUnpublishSchema, unpublishPublic } from "../server/legal-store.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(states) {
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

test("operator unpublish hides the face, feed and HTML despite a live public code", () => {
  const store = makeStore({ r1: baseState() });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.ok(face.faceByCode(publicCode).messages.some(m => m.body === "hello room"));
  assert.ok(face.feedByCode(publicCode).messages.some(m => m.body === "hello room"));
  unpublishPublic(store.db, { kind: "room", id: "r1", byAccount: "operator", now: Date.now() });
  assert.equal(errOf(() => face.faceByCode(publicCode)).code, "face_not_found");
  assert.equal(errOf(() => face.feedByCode(publicCode)).code, "face_not_found");
  assert.equal(errOf(() => face.faceHtml(publicCode)).code, "face_not_found");
});

test("archived room's face and feed 404 even with a live public code", () => {
  const state = baseState();
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.ok(face.faceByCode(publicCode).messages.length > 0);
  state.room.archivedAt = "2026-10-13T00:00:00.000Z";
  assert.equal(errOf(() => face.faceByCode(publicCode)).code, "face_not_found");
  assert.equal(errOf(() => face.feedByCode(publicCode)).code, "face_not_found");
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

// ---- body token scrub (parity with the operator export) -------------------
// Synthetic fixtures only — fake token shapes, never real credentials.
const sha256Hex = value => createHash("sha256").update(value).digest("hex");
const FAKE_TOKENS = [
  "pri_" + "SynthPriToken0123456789abcdef",
  "rak_" + "SynthRakToken0123456789abcdef",
  "ga1." + "SynthGa1Token0123456789abcdefXYZ"
];

test("sanitize scrubs room token shapes in bodies; the sha256 stands in, text around it intact", () => {
  const state = baseState();
  state.messages = FAKE_TOKENS.map((token, i) => ({
    id: `t${i}`, authorId: "alice", body: `room token ${token} end`, createdAt: 30 + i
  }));
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const snap = face.sanitize(store.room("r1").state);
  assert.equal(snap.messages.length, FAKE_TOKENS.length);
  snap.messages.forEach((m, i) => {
    assert.ok(!m.body.includes(FAKE_TOKENS[i]), "raw token must not be served");
    assert.equal(m.body, `room token ${sha256Hex(FAKE_TOKENS[i])} end`);
  });
});

test("faceByCode, feedByCode and faceHtml all serve scrubbed bodies", () => {
  const state = baseState();
  state.messages = [
    { id: "t1", authorId: "alice", body: `leak ${FAKE_TOKENS[0]} here`, createdAt: 30 },
    { id: "t2", authorId: "bob", body: "clean neighbour", createdAt: 31 }
  ];
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const expected = `leak ${sha256Hex(FAKE_TOKENS[0])} here`;
  const byCode = face.faceByCode(publicCode);
  assert.equal(byCode.messages[0].body, expected);
  assert.equal(byCode.messages[1].body, "clean neighbour");
  const feed = face.feedByCode(publicCode, { limit: 10 });
  assert.equal(feed.messages[0].body, expected);
  assert.equal(feed.messages[1].body, "clean neighbour");
  const html = face.faceHtml(publicCode);
  assert.ok(!html.includes(FAKE_TOKENS[0]), "raw token must not reach the HTML face");
  assert.ok(html.includes(sha256Hex(FAKE_TOKENS[0])));
});

test("legitimate bodies pass the scrub byte-identical, including under-floor shapes", () => {
  const bodies = [
    "plain standup notes: shipped the fix, tests green",
    "unicode — café and “quotes” & <angle> brackets",
    "pri_ short (under the 8-char floor) is just text",
    "rak_abc is not a token either",
    "a code sample: const x = ga1; // no dot, no token"
  ];
  const state = baseState();
  state.messages = bodies.map((body, i) => ({ id: `c${i}`, authorId: "alice", body, createdAt: 40 + i }));
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const snap = face.sanitize(store.room("r1").state);
  assert.deepEqual(snap.messages.map(m => m.body), bodies);
  const { publicCode } = face.enable("r1", "owner");
  const feed = face.feedByCode(publicCode, { limit: 10 });
  assert.deepEqual(feed.messages.map(m => m.body), bodies);
});

test("a token straddling the body cap is hashed whole, never served in part", () => {
  const token = FAKE_TOKENS[0];
  const state = baseState();
  state.messages = [{ id: "s1", authorId: "alice", body: "a".repeat(1990) + " " + token + " end", createdAt: 50 }];
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const snap = face.sanitize(store.room("r1").state);
  assert.ok(!snap.messages[0].body.includes(token));
  assert.ok(!snap.messages[0].body.includes(token.slice(0, 20)), "no partial token at the cap boundary");
  assert.ok(snap.messages[0].body.length <= 2004);
});

test("body scrub pattern stays in parity with the operator export scrubber", () => {
  const tokenSourceOf = path => {
    const match = readFileSync(new URL(path, import.meta.url), "utf8")
      .match(/const TOKEN_SOURCE = "([^"]+)"/);
    assert.ok(match, `TOKEN_SOURCE literal found in ${path}`);
    return match[1];
  };
  assert.equal(
    tokenSourceOf("../server/public-face.mjs"),
    tokenSourceOf("../server/room-export.mjs"),
    "public-face and room-export TOKEN_SOURCE literals must not drift"
  );
});
