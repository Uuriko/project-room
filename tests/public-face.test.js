import test from "node:test";
import assert from "node:assert/strict";
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

test("long public messages have an expandable, escaped preview without scripts", () => {
  const state = baseState();
  state.messages.push({ id: "long", authorId: "alice", body: "A".repeat(450) + "<script>bad()</script>" + "Z".repeat(2100), createdAt: 20 });
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const html = face.faceHtml(publicCode);
  assert.match(html, /<details><summary>/);
  assert.match(html, /Show more/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.doesNotMatch(html, /Z{2000}/);
});

test("public activity previews stay compact and retain the complete message", () => {
  const state = baseState();
  const body = 'Update\n\n' + '😀'.repeat(170) + '\nFinal detail';
  state.messages.push({ id: 'compact', authorId: 'alice', body, createdAt: 20 });
  const face = new PublicFace(makeStore({ r1: state }));
  const { publicCode } = face.enable('r1', 'owner');
  const html = face.faceHtml(publicCode);
  const preview = html.match(/<span class="preview">(.*?)<\/span>/s)?.[1];
  assert.ok(preview);
  assert.doesNotMatch(preview, /\n/);
  assert.ok(Array.from(preview).length <= 162);
  assert.ok(html.includes(body));
  assert.match(html, /Show more/);
});

test("a whitespace-heavy public message is collapsed without dropping its content", () => {
  const state = baseState();
  const body = 'Start' + ' '.repeat(1000) + 'End';
  state.messages.push({ id: 'spaces', authorId: 'alice', body, createdAt: 20 });
  const face = new PublicFace(makeStore({ r1: state }));
  const { publicCode } = face.enable('r1', 'owner');
  const html = face.faceHtml(publicCode);
  assert.match(html, /<span class="preview">Start End <\/span>/);
  assert.ok(html.includes(body));
});

test("public message emphasis is readable without interpreting code or HTML", () => {
  const state = baseState();
  state.messages.push({ id: "format", authorId: "alice", body: '**Status:** ready `<b>**literal**</b>` **<img src=x onerror=alert(1)>**', createdAt: 20 });
  const face = new PublicFace(makeStore({ r1: state }));
  const { publicCode } = face.enable("r1", "owner");
  const html = face.faceHtml(publicCode);
  assert.match(html, /<strong>Status:<\/strong> ready/);
  assert.match(html, /`&lt;b&gt;\*\*literal\*\*&lt;\/b&gt;`/);
  assert.match(html, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
  assert.doesNotMatch(html, /<img src=x/);
});

test("mention tokens show public handles, never member ids", () => {
  const state = baseState();
  state.members.gone = member("gone", "Gone", false);
  state.messages.push(
    { id: "m5", authorId: "owner", body: "<@alice> and <@bob>, see <@gone> and <@ai_unknownX9>", createdAt: 14 },
    { id: "m6", authorId: "owner", body: "<@alice>" + "x".repeat(2100), createdAt: 15 });
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  const shown = face.faceByCode(publicCode).messages.find(m => m.body.startsWith("@Alice and"));
  assert.equal(shown.body, "@Alice and @Bob, see @member and @member");
  const feed = face.feedByCode(publicCode).messages;
  assert.ok(feed.every(m => !/<@|ai_unknownX9|\bgone\b/.test(m.body)));
  assert.ok(feed.find(m => m.id === "m6").body.startsWith("@Alice"));
  const html = face.faceHtml(publicCode);
  assert.ok(html.includes("@Alice and @Bob"));
  assert.ok(!html.includes("&lt;@") && !html.includes("ai_unknownX9"));
});

test("mention handles stay escaped and unavailable members stay anonymous", () => {
  const state = baseState();
  state.members.eve = member("eve", "<b>Eve</b>");
  state.members.left = member("left", "Former Member", false);
  // Eve's name is already published as the author of this public page.
  state.messages.push({ id: "eve-public", authorId: "eve", body: "Public update", createdAt: 15 });
  state.messages.push({ id: "m7", authorId: "owner", body: "<@eve> and <@left>", createdAt: 16 });
  const store = makeStore({ r1: state });
  const face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(face.feedByCode(publicCode).messages.find(m => m.id === "m7").body, "@<b>Eve</b> and @member");
  const html = face.faceHtml(publicCode);
  assert.ok(html.includes("@&lt;b&gt;Eve&lt;/b&gt; and @member"));
  assert.ok(!html.includes("<b>Eve</b>") && !html.includes("Former Member") && !html.includes("&lt;@left&gt;"));
});

test("mention resolution never associates an active private member's raw ID with its name", () => {
  const state = baseState();
  state.members.privateOnly = member("privateOnly", "Private Participant");
  state.messages.push(
    { id: "private-post", authorId: "privateOnly", toMemberId: "owner", body: "Private history", createdAt: 14 },
    { id: "public-mention", authorId: "owner", body: "<@alice> / <@privateOnly> / <@not-known>", createdAt: 15 });
  const store = makeStore({ r1: state }), face = new PublicFace(store);
  const { publicCode } = face.enable("r1", "owner");
  assert.equal(face.faceByCode(publicCode).messages.at(-1).body, "@Alice / @member / @member");
  const feed = face.feedByCode(publicCode);
  assert.equal(feed.messages.at(-1).body, "@Alice / @member / @member");
  assert.doesNotMatch(JSON.stringify(feed), /privateOnly|Private Participant|Private history/);
  // A cursor may not turn authors from another page into a member-name lookup.
  assert.equal(face.feedByCode(publicCode, { after: "m4", limit: 1 }).messages[0].body, "@member / @member / @member");
});


test("normalized JSON and watch resolve only admitted public authors without hydrating private members", async t => {
  const { RoomStore } = await import("../server/store.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const { seedPublicLobby } = await import("./helpers/public-lobby-source.mjs");
  const store = new RoomStore(":memory:");
  const saved = seedPublicLobby(store, { privateCount: 3 });
  store.command(saved.owner, saved.roomId, { id: "mention-publication", type: "message.posted", data: {
    messageId: "mention-publication", body: "<@alice> / <@bob> / <@unknown>", channelId: "general"
  } });
  const { publicCode } = store.publicFace.enable(saved.roomId, "owner");
  store.command(saved.owner, saved.roomId, { id: "publish-mentions-lobby", type: "room.public_page_set", data: { enabled: true } });
  store.room = () => { throw new Error("Whole-room member hydration forbidden"); };
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const page = await (await fetch(origin + "/api/public/rooms/" + publicCode)).json();
  assert.equal(page.messages.at(-1).body, "@alice / @member / @member");
  const feed = await (await fetch(origin + "/api/public/rooms/" + publicCode + "/feed?after=public-16")).json();
  assert.equal(feed.messages.at(-1).body, "@alice / @member / @member");
  const watch = await (await fetch(origin + "/watch")).text();
  assert.match(watch, /@alice \/ @member \/ @member/);
  assert.doesNotMatch(watch, /&lt;@|@bob|OTHER CHANNEL|PRIVATE HISTORY/);
  assert.match(watch, /Only the General channel/);
});
