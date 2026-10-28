// Phase 1b: the null message envelope (workItemId, replyToId, toMemberId) is one
// marker key at rest and comes back byte for byte. Same flag as Phase 1a.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";
import { readConversation } from "../server/conversation-sync.mjs";
import { hydrateRecordText, hydrateProjection, storedProjection, projectionBreakdown, NULL_ENVELOPE_KEY } from "../server/projection-at-rest.mjs";

function open(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-envelope-"));
  const file = join(directory, "room.sqlite");
  let store = new RoomStore(file, options);
  store.initialize(initialRoom());
  store.roomFlood = { consume() {} };
  const owner = () => store.issueAccessKey("commons", "owner");
  const command = (type, data) => store.command(owner(), "commons", { id: randomUUID(), type, data });
  const post = (messageId, body, extra = {}) => command(T.MESSAGE_POSTED, { messageId, body, ...extra });
  const raw = () => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const reopen = (next = options) => { store.close(); store = new RoomStore(file, next); store.roomFlood = { consume() {} }; return store; };
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, owner, post, command, raw, reopen };
}
const long = tag => `${tag}:` + "y".repeat(400);

test("off by default: nothing is slimmed", t => {
  const room = open(t, { bodiesAtRest: false });
  room.post("a", "hello");
  assert.doesNotMatch(room.raw(), new RegExp(NULL_ENVELOPE_KEY));
  assert.match(room.raw(), /"toMemberId":null/);
});

test("on: the three null keys become one marker, and every reader gets the exact message back", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("a", "hello");
  room.post("b", long("big"));
  const stored = JSON.parse(room.raw()).messages;
  for (const message of stored) {
    assert.equal(message[NULL_ENVELOPE_KEY], 1);
    for (const key of ["workItemId", "replyToId", "toMemberId"]) assert.equal(key in message, false);
  }
  assert.deepEqual(Object.keys(stored[0]), ["id", "authorId", "body", "channelId", NULL_ENVELOPE_KEY, "createdAt"], "marker sits where the run was");
  const live = JSON.stringify(room.store.room("commons").state.messages);
  assert.match(live, /"workItemId":null,"replyToId":null,"toMemberId":null,"createdAt"/);
  room.reopen();
  assert.equal(JSON.stringify(room.store.room("commons").state.messages), live, "restart");
  assert.equal(JSON.stringify(room.store.rebuildProjection("commons").state.messages), live, "replay");
  auditRecovery(room.store);
  for (let page = 0; page < 20; page++) if (room.store.backfillMessages({ limit: 400 }).done) break;
  assert.equal(room.store.checkMessagesParity().checked, 1);
});

test("on: the stored row is smaller per message than with the flag off", t => {
  const on = open(t, { bodiesAtRest: true }), off = open(t, { bodiesAtRest: false });
  for (let i = 0; i < 40; i++) { on.post(`m${i}`, "hello"); off.post(`m${i}`, "hello"); }
  const saved = Buffer.byteLength(off.raw()) - Buffer.byteLength(on.raw());
  assert.ok(saved >= 40 * 40, `saved ${saved} bytes over 40 messages`);
});

test("messages that do not carry the canonical null run are left exactly as they are", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("root", "hello");
  room.post("reply", "re", { replyToId: "root" });
  room.post("dm", "psst", { toMemberId: "owner" });
  const stored = JSON.parse(room.raw()).messages;
  const by = id => stored.find(m => m.id === id);
  assert.equal(by("root")[NULL_ENVELOPE_KEY], 1);
  assert.equal(NULL_ENVELOPE_KEY in by("reply"), false);
  assert.equal(by("reply").replyToId, "root");
  assert.equal(NULL_ENVELOPE_KEY in by("dm"), false);
  assert.equal(by("dm").toMemberId, "owner");
  const live = room.store.room("commons").state.messages;
  assert.equal(live.find(m => m.id === "root").toMemberId, null);
});

test("a message that already uses the marker key, or has the run out of order, is never rewritten", () => {
  const db = { prepare: () => ({ all: () => [], run() {}, get() {} }) };
  const marked = { id: "x", authorId: "o", body: "b", channelId: "general", workItemId: null, replyToId: null, toMemberId: null, [NULL_ENVELOPE_KEY]: "mine", createdAt: "t" };
  const reordered = { id: "y", authorId: "o", body: "b", channelId: "general", toMemberId: null, replyToId: null, workItemId: null, createdAt: "t" };
  const state = { messages: [marked, reordered] };
  assert.equal(storedProjection(db, "r", state, { enabled: true }), JSON.stringify(state));
});

test("rehydrateAllProjections restores full envelopes for a rollback, even when no body is large", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("a", "hello");
  assert.match(room.raw(), /"_nul":1/);
  room.reopen({ bodiesAtRest: false });
  assert.equal(room.store.rehydrateAllProjections(), 1);
  assert.doesNotMatch(room.raw(), /_nul/);
  assert.match(room.raw(), /"workItemId":null,"replyToId":null,"toMemberId":null/);
  auditRecovery(room.store);
});

test("turning the flag off writes full envelopes back on the next write", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("a", "hello");
  room.reopen({ bodiesAtRest: false });
  room.post("b", "next");
  assert.doesNotMatch(room.raw(), /_nul/);
});

test("the unindexed conversation read returns full envelopes, and a DM still stays private", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("pub", "hello");
  room.post("secret", "psst", { toMemberId: "owner" });
  const page = readConversation(room.store, room.owner(), "commons", { limit: 10 });
  const pub = page.messages.find(m => m.id === "pub");
  assert.equal(pub.toMemberId, null); assert.equal(pub.workItemId, null); assert.equal(pub.replyToId, null);
  assert.equal(NULL_ENVELOPE_KEY in pub, false);
  assert.equal(page.messages.find(m => m.id === "secret").toMemberId, "owner");
});

test("hydrateRecordText and hydrateProjection restore the marker with or without a body ref", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("a", long("one"));
  const record = JSON.stringify(JSON.parse(room.raw()).messages[0]);
  const full = JSON.stringify(room.store.room("commons").state.messages[0]);
  assert.equal(hydrateRecordText(room.store.db, "commons", record), full);
  const plain = `{"id":"p","authorId":"o","body":"b","channelId":"general","${NULL_ENVELOPE_KEY}":1,"createdAt":"t"}`;
  assert.equal(hydrateRecordText(room.store.db, "commons", plain),
    '{"id":"p","authorId":"o","body":"b","channelId":"general","workItemId":null,"replyToId":null,"toMemberId":null,"createdAt":"t"}');
  const state = { messages: [JSON.parse(plain)] };
  assert.deepEqual(hydrateProjection(room.store.db, "commons", state).missing, []);
  assert.equal(JSON.stringify(state.messages[0]), hydrateRecordText(room.store.db, "commons", plain));
});

test("projectionBreakdown reports stored bytes by top-level key and by message key", t => {
  const room = open(t, { bodiesAtRest: true });
  room.post("a", "hello"); room.post("b", long("big")); room.post("c", "re", { replyToId: "a" });
  const report = projectionBreakdown(room.store.db, "commons");
  assert.equal(report.totalBytes, Buffer.byteLength(room.raw()));
  assert.equal(report.topLevel[0].key, "messages");
  assert.equal(report.messageCount, 3);
  const key = name => report.messageKeys.find(row => row.key === name);
  assert.equal(key("id").messages, 3);
  assert.equal(key(NULL_ENVELOPE_KEY).messages, 2);
  assert.equal(key("replyToId").messages, 1);
  assert.equal(key("bodyRef").messages, 1);
  assert.ok(report.averageMessageBytes > 50);
  assert.equal(projectionBreakdown(room.store.db, "missing"), null);
});
