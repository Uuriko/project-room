import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { messageVisibleTo, syncMessageRows } from "../server/messages-store.mjs";
import { listOpenQuestions } from "../server/open-questions.mjs";
import { auditRecovery } from "../server/recovery.mjs";

// Message rows are written in the same transaction as the message event.
// Reads still use the projection. A direct message stays visible to the
// same two parties eventsAfter already admits.
const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-messages-table-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const [id, kind] of [["human", "human"], ["agent", "agent"], ["stranger", "human"]]) {
    store.command(owner, "commons", command(T.MEMBER_ADDED, {
      memberId: id, displayName: id, kind, permissions: ["accept_work", "complete_work", "verify"]
    }));
  }
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const human = store.issueAccessKey("commons", "human");
  const agent = store.issueAccessKey("commons", "agent");
  const stranger = store.issueAccessKey("commons", "stranger");
  store.dmConsents.request("commons", "human", "agent", "test fixture");
  store.dmConsents.decide("commons", "agent", "human", "approve");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = (token, type, data, id) => store.command(token, "commons", command(type, data, id));
  return { store, owner, human, agent, stranger, send };
}

function threadRoot(messages, message) {
  if (!message.replyToId) return null;
  const byId = new Map(messages.map(entry => [entry.id, entry]));
  let current = message;
  const seen = new Set();
  while (current?.replyToId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.replyToId);
    if (!parent) return current.replyToId;
    current = parent;
  }
  return current?.id && current.id !== message.id ? current.id : null;
}

function assertRowsMatchProjection(store, createdAt) {
  const state = store.room("commons").state;
  const pins = new Set((state.pins ?? []).map(pin => pin.messageId));
  const rows = store.db.prepare("SELECT * FROM messages WHERE room_id=?").all("commons");
  assert.equal(rows.length, state.messages.length);
  const byId = new Map(rows.map(row => [row.message_id, row]));
  for (const message of state.messages) {
    const row = byId.get(message.id);
    assert.ok(row, message.id);
    assert.equal(byId.size, rows.length);
    assert.equal(row.author_id, message.authorId);
    assert.equal(row.body, typeof message.body === "string" ? message.body : null);
    assert.equal(row.channel_id, message.channelId || null);
    assert.equal(row.reply_to_id, message.replyToId || null);
    assert.equal(row.to_member_id, message.toMemberId || null);
    assert.equal(row.work_item_id, message.workItemId || null);
    assert.equal(row.created_at, message.createdAt);
    assert.equal(row.edited_at, message.editedAt ?? null);
    assert.equal(row.deleted_at, message.deletedAt ?? null);
    assert.equal(row.thread_root_id, threadRoot(state.messages, message));
    assert.equal(row.pinned, pins.has(message.id) ? 1 : 0);
    const reactions = message.reactions && Object.keys(message.reactions).length ? JSON.stringify(message.reactions) : null;
    assert.equal(row.reactions_json, reactions);
    assert.equal(row.seq, createdAt.get(message.id));
    const { editHistory: _history, ...currentRecord } = message;
    assert.deepEqual(JSON.parse(row.record_json), currentRecord,
      'indexed storage preserves the complete current conversation record without prior edits');
  }
}

test("message commands write one row per message and keep the posting sequence", t => {
  const f = fixture(t);
  const createdAt = new Map();
  const posted = f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Topic" });
  createdAt.set("topic", posted.sequence);
  const reply = f.send(f.human, T.MESSAGE_POSTED, { messageId: "reply", body: "Reply", replyToId: "topic" });
  createdAt.set("reply", reply.sequence);
  f.send(f.human, T.MESSAGE_EDITED, { messageId: "topic", body: "Topic revised", expectedMessageRevision: 0 });
  f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "like", active: true });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "topic" });
  let state = f.store.room("commons").state;
  assert.equal(state.messages.find(message => message.id === "topic").body, "Topic revised");
  assert.equal(f.store.db.prepare("SELECT pinned FROM messages WHERE message_id='topic'").get().pinned, 1);
  f.send(f.human, T.MESSAGE_UNPINNED, { messageId: "topic" });
  f.send(f.human, T.MESSAGE_DELETED, { messageId: "topic", expectedMessageRevision: 1, reason: "removed" });
  state = f.store.room("commons").state;
  const topic = state.messages.find(message => message.id === "topic");
  assert.equal(topic.body, null);
  assert.equal(typeof topic.deletedAt, "string");
  assertRowsMatchProjection(f.store, createdAt);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM messages WHERE message_id='topic'").get().n, 1);

  const copied = f.send(f.human, T.MESSAGE_POSTED, {
    messageId: "aside", body: "Also in the channel", replyToId: "reply", alsoSendToChannel: true
  });
  createdAt.set("aside", copied.sequence);
  createdAt.set("aside:channel", copied.sequence);
  const ids = f.store.room("commons").state.messages.map(message => message.id);
  assert.ok(ids.includes("aside:channel"));
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM messages WHERE seq=?").get(copied.sequence).n, 2);
  assertRowsMatchProjection(f.store, createdAt);
});

test("a direct message row follows the same party rule as eventsAfter", t => {
  const f = fixture(t);
  const posted = f.send(f.human, T.MESSAGE_POSTED, { messageId: "dm", body: "only for the agent", toMemberId: "agent" });
  const row = f.store.db.prepare("SELECT * FROM messages WHERE message_id='dm'").get();
  assert.equal(row.author_id, "human");
  assert.equal(row.to_member_id, "agent");
  assert.equal(row.seq, posted.sequence);
  const page = token => f.store.eventsAfter(token, "commons", 0, 100).events;
  const seen = token => page(token).some(entry => entry.event.type === T.MESSAGE_POSTED && entry.event.data.body === "only for the agent");
  assert.equal(seen(f.stranger), false);
  assert.equal(seen(f.human), true);
  assert.equal(seen(f.agent), true);
  assert.equal(f.store.eventsAfter(f.stranger, "commons", 0, 100).next, f.store.room("commons").sequence);
  assert.equal(messageVisibleTo(row, "stranger"), false);
  assert.equal(messageVisibleTo(row, "human"), true);
  assert.equal(messageVisibleTo(row, "agent"), true);
  assert.equal(messageVisibleTo({ ...row, to_member_id: null }, "stranger"), true);
});

test("a rejected post and a rolled-back row write leave the messages table unchanged", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "kept", body: "kept" });
  const before = f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons'").all();
  assert.throws(() => f.send(f.human, T.MESSAGE_POSTED, { body: " " }), /body/);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons'").all(), before);
  const state = f.store.room("commons").state;
  assert.throws(() => f.store.transaction(() => {
    syncMessageRows(f.store.db, {
      roomId: "commons", sequence: 1,
      event: { type: T.MESSAGE_EDITED, data: { messageId: "kept" } },
      state: { ...state, messages: state.messages.map(message => message.id === "kept" ? { ...message, body: "uncommitted" } : message) }
    });
    throw new Error("rollback");
  }), /rollback/);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons'").all(), before);
  syncMessageRows(f.store.db, {
    roomId: "commons", sequence: f.store.room("commons").sequence,
    event: { type: T.MESSAGE_POSTED, data: { messageId: "kept" } }, state
  });
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM messages WHERE message_id='kept'").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT body FROM messages WHERE message_id='kept'").get().body, "kept");
});

test("a seeded command sequence keeps one row aligned with each projection message", t => {
  const f = fixture(t);
  let seed = 20261002;
  const next = () => { seed = seed * 1664525 + 1013904223 >>> 0; return seed / 4294967296; };
  const createdAt = new Map();
  const revision = new Map();
  const alive = [];
  const pick = list => list[Math.floor(next() * list.length)];
  for (let i = 0; i < 28; i++) {
    const roll = next();
    if (alive.length === 0 || roll < 0.4) {
      const messageId = `rnd-${i}`;
      const data = { messageId, body: `body ${i}` };
      if (alive.length && next() < 0.5) data.replyToId = pick(alive);
      const saved = f.send(f.human, T.MESSAGE_POSTED, data);
      createdAt.set(messageId, saved.sequence);
      revision.set(messageId, 0);
      alive.push(messageId);
    } else if (roll < 0.6) {
      const messageId = pick(alive);
      f.send(f.human, T.MESSAGE_EDITED, { messageId, body: `edited ${i}`, expectedMessageRevision: revision.get(messageId) });
      revision.set(messageId, revision.get(messageId) + 1);
    } else if (roll < 0.75) {
      f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: pick(alive), reaction: "like", active: next() < 0.5 });
    } else if (roll < 0.9) {
      const messageId = pick(alive);
      const pinned = f.store.room("commons").state.pins?.some(pin => pin.messageId === messageId);
      f.send(f.human, pinned ? T.MESSAGE_UNPINNED : T.MESSAGE_PINNED, { messageId });
    } else {
      const messageId = alive.splice(Math.floor(next() * alive.length), 1)[0];
      f.send(f.human, T.MESSAGE_DELETED, { messageId, expectedMessageRevision: revision.get(messageId), reason: "removed" });
    }
    assertRowsMatchProjection(f.store, createdAt);
  }
});

test("syncMessageRows resolves touched messages without indexing a large state", t => {
  const f = fixture(t);
  // Synthetic large projection: the row writer must resolve the event's
  // messages (and reply ancestors for thread roots) without building an
  // id map over the whole room per write.
  const messages = [];
  for (let i = 0; i < 4000; i++) {
    messages.push({ id: `bulk-${i}`, authorId: "human", body: `bulk ${i}`, channelId: "general",
      workItemId: null, replyToId: null, toMemberId: null, createdAt: "2026-10-07T00:00:00.000Z" });
  }
  messages.push({ id: "root-1", authorId: "human", body: "root", channelId: "general", workItemId: null,
    replyToId: null, toMemberId: null, createdAt: "2026-10-07T00:00:01.000Z" });
  messages.push({ id: "reply-1", authorId: "agent", body: "reply", channelId: "general", workItemId: null,
    replyToId: "root-1", toMemberId: null, createdAt: "2026-10-07T00:00:02.000Z" });
  const state = { messages, pins: [] };
  const posted = messageId => ({ type: T.MESSAGE_POSTED, id: `evt-${messageId}`, data: { messageId } });
  const rowOf = messageId => f.store.db.prepare(
    "SELECT message_id, thread_root_id, reply_to_id, body FROM messages WHERE room_id=? AND message_id=?")
    .get("commons", messageId);
  // Plain post: one row, no thread root.
  assert.equal(syncMessageRows(f.store.db, { roomId: "commons", sequence: 9001, event: posted("bulk-3999"), state }), 1);
  const plain = rowOf("bulk-3999");
  assert.equal(plain.body, "bulk 3999");
  assert.equal(plain.thread_root_id, null);
  // Reply: the thread root resolves through the ancestor chain.
  assert.equal(syncMessageRows(f.store.db, { roomId: "commons", sequence: 9002, event: posted("reply-1"), state }), 1);
  const reply = rowOf("reply-1");
  assert.equal(reply.reply_to_id, "root-1");
  assert.equal(reply.thread_root_id, "root-1");
  // Unknown message id writes nothing.
  assert.equal(syncMessageRows(f.store.db, { roomId: "commons", sequence: 9003, event: posted("nope"), state }), 0);
});

// Archive marker (design: certified-prefix tail). Messages with a posting seq
// at or below rooms.projection.messagesArchive.throughSeq live only in the
// messages table. Backfill pruning and parity must treat them as archived, not
// as stale rows or mismatches.
function archiveOldest(f, count) {
  const all = f.store.db.prepare("SELECT message_id, seq FROM messages WHERE room_id='commons' ORDER BY seq").all();
  const old = all.slice(0, count);
  const projection = JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  const drop = new Set(old.map(row => row.message_id));
  projection.messages = projection.messages.filter(message => !drop.has(message.id));
  projection.messagesArchive = { throughSeq: old[old.length - 1].seq, count: old.length };
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
  return old;
}

function seedAndCatchUp(f, n) {
  for (let i = 0; i < n; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `arc-${i}`, body: `body ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
}

test("backfill pruning keeps archived rows that are no longer in the projection", t => {
  const f = fixture(t);
  seedAndCatchUp(f, 6);
  const old = archiveOldest(f, 3);
  f.store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id='commons'").run();
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const ids = new Set(f.store.db.prepare("SELECT message_id FROM messages WHERE room_id='commons'").all().map(row => row.message_id));
  for (const row of old) assert.ok(ids.has(row.message_id), `${row.message_id} still archived in the table`);
});

test("parity certifies a room whose old messages are archived and rejects a missing archived row", t => {
  const f = fixture(t);
  seedAndCatchUp(f, 6);
  const old = archiveOldest(f, 3);
  assert.equal(f.store.checkMessagesParity().ok, true);
  f.store.db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id=?").run(old[0].message_id);
  assert.throws(() => { for (let i = 0; i < 5; i++) f.store.checkMessagesParity(); }, /messages parity failed/);
});

test("parity accepts a tail reply whose thread root was archived", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "root", body: "root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "mid", body: "mid", replyToId: "root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "leaf", body: "leaf", replyToId: "mid" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  archiveOldest(f, 2);
  assert.equal(f.store.checkMessagesParity().ok, true);
});

test("follow-up events of an archived direct message stay hidden from non-parties", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "dm-1", toMemberId: "agent", body: "private" });
  f.send(f.human, T.MESSAGE_EDITED, { messageId: "dm-1", body: "private edited", expectedMessageRevision: 0 });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "pub-1", body: "public" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const dmSeq = f.store.db.prepare("SELECT seq FROM messages WHERE message_id='dm-1'").get().seq;
  const count = f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons' AND seq<=?").get(dmSeq).n;
  archiveOldest(f, count);
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "dm-1"), false);
  const types = token => f.store.eventsAfter(token, "commons", dmSeq, 100).events.map(({ event: e }) => `${e.type}:${e.data?.messageId ?? ""}`);
  assert.ok(types(f.human).includes("message.edited:dm-1"), "a party still sees the edit");
  assert.ok(types(f.agent).includes("message.edited:dm-1"), "the addressee still sees the edit");
  assert.equal(types(f.stranger).includes("message.edited:dm-1"), false, "a non-party must not see the edit");
});

test("search still finds archived messages and keeps archived DMs private", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "Quartz plan for the room" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "quartz private note" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "new-pub", body: "quartz follow-up" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const dmSeq = f.store.db.prepare("SELECT seq FROM messages WHERE message_id='old-dm'").get().seq;
  archiveOldest(f, f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons' AND seq<=?").get(dmSeq).n);
  assert.deepEqual(f.store.room("commons").state.messages.map(m => m.id), ["new-pub"]);
  const ids = token => f.store.search(token, "commons", "QUARTZ", "messages").messages.map(m => m.id);
  assert.deepEqual(ids(f.human), ["old-pub", "old-dm", "new-pub"]);
  assert.deepEqual(ids(f.agent), ["old-pub", "old-dm", "new-pub"]);
  assert.deepEqual(ids(f.stranger), ["old-pub", "new-pub"]);
  assert.equal(f.store.search(f.stranger, "commons", "quartz", "messages").total, 2);
});

test("REST search resolves archived hits instead of dropping them, and still hides archived DMs", async t => {
  const { createRoomServer } = await import("../server/http.mjs");
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "Quartz plan for the room" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "quartz private note" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "new-pub", body: "quartz follow-up" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const dmSeq = f.store.db.prepare("SELECT seq FROM messages WHERE message_id='old-dm'").get().seq;
  archiveOldest(f, f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons' AND seq<=?").get(dmSeq).n);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, token) => (await fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } })).json();
  const searchIds = async token => (await get("/api/rooms/commons/search?q=quartz&kind=messages", token)).messages.map(m => m.id);
  assert.deepEqual(await searchIds(f.human), ["old-pub", "old-dm", "new-pub"]);
  assert.deepEqual(await searchIds(f.stranger), ["old-pub", "new-pub"]);
});

test("changing or replying to an archived message is refused with a clear error, a stranger's DM probe is not confirmed", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "old public" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "old private" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "new-pub", body: "new" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const dmSeq = f.store.db.prepare("SELECT seq FROM messages WHERE message_id='old-dm'").get().seq;
  archiveOldest(f, f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons' AND seq<=?").get(dmSeq).n);
  const code = fn => { try { fn(); } catch (error) { return error.code ?? error.message; } return null; };
  const before = f.store.room("commons").sequence;
  assert.equal(code(() => f.send(f.human, T.MESSAGE_EDITED, { messageId: "old-pub", body: "x", expectedMessageRevision: 0 })), "message_archived");
  assert.equal(code(() => f.send(f.human, T.MESSAGE_DELETED, { messageId: "old-pub", expectedMessageRevision: 0, reason: "x" })), "message_archived");
  assert.equal(code(() => f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "old-pub", reaction: "like", active: true })), "message_archived");
  assert.equal(code(() => f.send(f.human, T.MESSAGE_PINNED, { messageId: "old-pub" })), "message_archived");
  assert.equal(code(() => f.send(f.human, T.MESSAGE_POSTED, { messageId: "reply-1", body: "r", replyToId: "old-pub" })), "message_archived");
  assert.equal(code(() => f.send(f.human, T.MESSAGE_POSTED, { messageId: "reply-2", body: "r", replyToId: "old-dm" })), "message_archived");
  assert.notEqual(code(() => f.send(f.stranger, T.MESSAGE_POSTED, { messageId: "probe", body: "r", replyToId: "old-dm" })), "message_archived");
  assert.equal(f.store.room("commons").sequence, before, "a refused command appends nothing");
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "fine", body: "ordinary posts still work" });
});

test("an archived pinned DM can be unpinned by its parties and not by anyone else", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "private" });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "old-dm" });
  for (let i = 0; i < 4; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  // Pins are retained by the compaction, so build the legacy shape directly: the
  // pinned DM is out of the projection and covered by the marker.
  const row = f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
  const projection = JSON.parse(row.projection);
  const seq = f.store.db.prepare("SELECT seq FROM messages WHERE message_id='old-dm'").get().seq;
  const others = projection.messages.filter(m => m.id !== "old-dm" && f.store.db.prepare("SELECT seq FROM messages WHERE message_id=?").get(m.id).seq <= seq).map(m => m.id);
  projection.messages = projection.messages.filter(m => m.id !== "old-dm");
  projection.messagesArchive = { throughSeq: seq, count: 1, retainedIds: others };
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
  f.store.rooms?.clear?.();
  assert.equal(f.store.room("commons").state.pins.some(pin => pin.messageId === "old-dm"), true);
  const code = fn => { try { fn(); } catch (error) { return error.code ?? error.message; } return null; };
  const before = f.store.room("commons").sequence;
  assert.ok(code(() => f.send(f.stranger, T.MESSAGE_UNPINNED, { messageId: "old-dm" })), "a stranger is refused");
  assert.equal(f.store.room("commons").state.pins.some(pin => pin.messageId === "old-dm"), true, "the pin is still there");
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(code(() => f.send(f.agent, T.MESSAGE_UNPINNED, { messageId: "old-dm" })), null, "the recipient can unpin");
  assert.equal(f.store.room("commons").state.pins.some(pin => pin.messageId === "old-dm"), false);
});

test("a new post cannot reuse the id of an archived message, public or DM, and reads like a live duplicate", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "old public" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "old private" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "new-pub", body: "new" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const dmSeq = f.store.db.prepare("SELECT seq FROM messages WHERE message_id='old-dm'").get().seq;
  archiveOldest(f, f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons' AND seq<=?").get(dmSeq).n);
  const attempt = (token, data, id) => { try { f.send(token, T.MESSAGE_POSTED, data, id); return "posted"; } catch (error) { return `${error.status}:${error.code}:${error.message}`; } };
  const duplicate = attempt(f.human, { messageId: "new-pub", body: "again" });
  assert.match(duplicate, /^409:command_rejected:/);
  assert.equal(attempt(f.stranger, { messageId: "old-dm", body: "reuse" }), duplicate, "a stranger gets the live-duplicate answer");
  assert.equal(attempt(f.human, { messageId: "old-pub", body: "reuse" }), duplicate);
  assert.equal(attempt(f.human, { body: "event id reuse" }, "old-pub"), duplicate, "the event id doubles as the message id when none is given");
  assert.equal(attempt(f.human, { messageId: "brand-new", body: "fine" }), "posted");
  assert.equal(f.store.room("commons").state.messages.filter(m => m.id === "old-pub" || m.id === "old-dm").length, 0);
});

test("the archive marker survives later commands and room reloads", t => {
  const f = fixture(t);
  seedAndCatchUp(f, 4);
  archiveOldest(f, 2);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "after-1", body: "after" });
  const marker = () => JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection).messagesArchive;
  assert.equal(marker()?.count, 2);
  assert.equal(f.store.room("commons").state.messagesArchive?.count, 2);
});

test("archiveMessages: dry run reports, a real run moves old unpinned messages, and parity, search and pins stay correct", t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `m-${i}`, body: `zebra ${i}` });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "m-1" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  assert.equal(f.store.checkMessagesParity().ok, true);
  const before = f.store.room("commons").state.messages.length;
  assert.deepEqual(f.store.archiveMessages("commons", { keepNewest: 4 }).dryRun, true);
  assert.equal(f.store.room("commons").state.messages.length, before, "dry run changes nothing");
  const plan = f.store.archiveMessages("commons", { keepNewest: 4 });
  assert.ok(plan.archived > 0 && plan.freedBytes > 0);
  // Parity runs per room per call; certify the room at its head first.
  const done = f.store.archiveMessages("commons", { keepNewest: 4, dryRun: false });
  assert.equal(done.archived, plan.archived);
  const state = f.store.room("commons").state;
  assert.equal(state.messages.length, before - plan.archived);
  assert.ok(state.messages.some(m => m.id === "m-1"), "the pinned message stays");
  assert.equal(state.messagesArchive.count, plan.archived);
  assert.ok(state.messagesArchive.retainedIds.includes("m-1"));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons'").get().n, before, "no row leaves the table");
  assert.equal(f.store.checkMessagesParity().ok, true);
  assert.equal(f.store.search(f.human, "commons", "zebra", "messages").total, 10);
  assert.equal(f.store.archiveMessages("commons", { keepNewest: 4, dryRun: false }).archived, 0, "a second run has nothing to move");
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "later", body: "zebra later" });
  assert.equal(f.store.room("commons").state.messagesArchive.count, plan.archived);
});

test("archiveMessages refuses a room whose messages table is not certified", t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `n-${i}`, body: `b ${i}` });
  assert.deepEqual(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }), { ok: false, reason: "messages_table_not_certified" });
  assert.equal(f.store.room("commons").state.messagesArchive, undefined);
});

test("archiveMessages keeps the reply ancestors of recent messages in the projection", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "root", body: "thread root" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `filler-${i}`, body: `filler ${i}` });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "recent-reply", body: "late reply", replyToId: "root" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  const done = f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false });
  assert.ok(done.archived > 0);
  const ids = f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(ids.includes("root"), "the thread root of a recent reply stays");
  assert.ok(!ids.includes("filler-0"), "unrelated old messages are archived");
  assert.equal(f.store.checkMessagesParity().ok, true);
});

test("unpinning or reacting to an archived DM as a non-party confirms nothing and writes nothing", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "private" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "old-dm"), false);
  const before = f.store.room("commons").sequence;
  for (const type of [T.MESSAGE_UNPINNED, T.MESSAGE_PINNED, T.MESSAGE_REACTION_SET]) {
    let code = null;
    try { f.send(f.stranger, type, { messageId: "old-dm", reaction: "like", active: true }); } catch (error) { code = error.code ?? error.message; }
    assert.ok(code, `${type} is refused`);
    assert.notEqual(code, "message_archived", `${type} does not confirm the archived DM`);
  }
  assert.equal(f.store.room("commons").sequence, before);
});

test("the recovery audit accepts a room whose old messages are archived and still rejects a tampered marker", t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `r-${i}`, body: `recovery ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.doesNotThrow(() => auditRecovery(f.store), "audit passes before archival");
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 3, dryRun: false }).archived > 0);
  assert.doesNotThrow(() => auditRecovery(f.store), "audit passes after archival");
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "after", body: "posted after the archive" });
  assert.doesNotThrow(() => auditRecovery(f.store), "audit passes after a later post");
  const projection = JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  projection.messagesArchive.count += 1;
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
  assert.throws(() => auditRecovery(f.store), /operator reconciliation/);
});

test("a message kept only because it was pinned is archived on a later run once it is unpinned", t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `p-${i}`, body: `pin ${i}` });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "p-0" });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 3, dryRun: false }).archived > 0);
  const ids = () => f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(ids().includes("p-0"), "the pinned message stays");
  f.send(f.human, T.MESSAGE_UNPINNED, { messageId: "p-0" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `q-${i}`, body: `later ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 3, dryRun: false }).archived > 0);
  assert.ok(!ids().includes("p-0"), "once unpinned it is archived like any other old message");
});

test("archiveMessages keeps unanswered questions so the open-questions list does not shrink", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "q-open", body: "Who owns the invoice?" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "q-answered", body: "Is staging up?" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "a-1", body: "yes", replyToId: "q-answered" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `pad-${i}`, body: `pad ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  const ids = f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(ids.includes("q-open"), "the unanswered question stays");
  assert.ok(!ids.includes("q-answered"), "an answered old question can be archived");
});

test("archiving keeps every open question (more than the reader's 100-newest cap) and what closes a kept one", t => {
  const f = fixture(t);
  f.store.roomFlood = { consume: () => false, refund() {} }; // 130 quick posts would hit the per-member burst limit
  const openFor = who => listOpenQuestions(f.store, who, "commons", { limit: 100 }).openQuestions.map(q => q.messageId);
  for (let i = 0; i < 130; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `oq-${i}`, body: `open ${i}?` });
  // Public question closed only by a DM to its asker: the public view still sees it open.
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "q-dm", body: "who has the key?" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "a-dm", toMemberId: "human", body: "I do", replyToId: "q-dm" });
  // Pinned question closed by a public answer.
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "q-pin", body: "is staging up?" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "a-pin", body: "yes", replyToId: "q-pin" });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "q-pin" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `pad-${i}`, body: `pad ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  const views = { human: f.human, agent: f.agent, stranger: f.stranger };
  const before = Object.fromEntries(Object.entries(views).map(([name, token]) => [name, openFor(token)]));
  assert.ok(before.human.length > 0 && !before.human.includes("q-dm"), "the asker sees the DM-answered question as closed");
  assert.ok(before.stranger.includes("q-dm"), "a public view still sees it open");
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  for (const [name, token] of Object.entries(views)) assert.deepEqual(openFor(token), before[name], `${name}'s open questions are unchanged by the archive`);
  const ids = f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(ids.includes("a-dm") && ids.includes("a-pin"), "the answers that close kept questions stay");
  assert.ok(ids.includes("oq-0") && ids.includes("oq-129"), "all 130 open questions stay, not just the newest 100");
});

test("archiving keeps the answer of a question that is only kept as a reply ancestor of a recent message", t => {
  const f = fixture(t);
  const openFor = who => listOpenQuestions(f.store, who, "commons", { limit: 100 }).openQuestions.map(q => q.messageId);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "q", body: "is staging up?" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "ans", body: "yes", replyToId: "q" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "k", body: "thanks, what about prod?", replyToId: "q" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `pad-${i}`, body: `pad ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  const views = { human: f.human, agent: f.agent, stranger: f.stranger };
  const before = Object.fromEntries(Object.entries(views).map(([name, token]) => [name, openFor(token)]));
  assert.deepEqual(before.human, ["k"], "q is answered, k is open");
  // keepNewest 2 keeps the last pads; k is old enough to be cut unless it is retained as an open question.
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  for (const [name, token] of Object.entries(views)) assert.deepEqual(openFor(token), before[name], `${name}'s list is unchanged`);
  const ids = f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(ids.includes("k") && ids.includes("q") && ids.includes("ans"), "k, its ancestor q and q's answer all stay");
});

test("event-log redaction still applies to archived messages (a withdrawn archived message keeps no body)", async t => {
  const { redactEventPage } = await import("../server/redact-read.mjs");
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-gone", body: "oops secret" });
  f.send(f.human, T.MESSAGE_DELETED, { messageId: "old-gone", expectedMessageRevision: 0, reason: "x" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-live", body: "still here" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-edit", body: "first version" });
  f.send(f.human, T.MESSAGE_EDITED, { messageId: "old-edit", body: "second version", expectedMessageRevision: 0 });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "old-gone"), false);
  // An older withdrawal can still carry the original body in the log row.
  const page = { events: [{ sequence: 1, event: { type: "message.posted", id: "old-gone", data: { messageId: "old-gone", body: "oops secret" } } }] };
  const out = redactEventPage(page, f.store.redactionMessages("commons"));
  assert.equal(out.events[0].event.data.body, null);
  // A live archived message keeps its current body (not the tombstone), and an edited one
  // shows the current version, not the first. These fail if archived messages are not looked up.
  const ids = f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(!ids.includes("old-live") && !ids.includes("old-edit"), "both are archived");
  const live = redactEventPage({ events: [
    { sequence: 2, event: { type: "message.posted", id: "old-live", data: { messageId: "old-live", body: "still here" } } },
    { sequence: 3, event: { type: "message.posted", id: "old-edit", data: { messageId: "old-edit", body: "first version" } } },
    { sequence: 4, event: { type: "message.edited", data: { messageId: "old-edit", body: "second version" } } },
  ] }, f.store.redactionMessages("commons"));
  assert.equal(live.events[0].event.data.body, "still here", "a live archived message keeps its body");
  assert.equal(live.events[1].event.data.body, "second version", "an edited archived message shows the current body, not v1");
  assert.equal(live.events[2].event.data.body, "second version");
});

test("the thread view of an archived root (and archived replies under a kept root) still works, and archived DMs stay private", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-root", body: "old root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-reply", body: "old reply", replyToId: "old-root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm-reply", toMemberId: "agent", body: "private reply", replyToId: "old-root" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "old-root"), false);
  const ids = token => f.store.messageThread(token, "commons", "old-root").thread.replies.map(r => r.id);
  assert.equal(f.store.messageThread(f.human, "commons", "old-root").thread.id, "old-root");
  assert.deepEqual(ids(f.human), ["old-reply", "old-dm-reply"]);
  assert.deepEqual(ids(f.stranger), ["old-reply"]);
});

test("the thread view of an archived reply still lists its own archived replies, once each", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "t-root", body: "root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "t-reply", body: "reply", replyToId: "t-root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "t-deep", body: "deep", replyToId: "t-reply" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "t-dm", toMemberId: "agent", body: "private", replyToId: "t-reply" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "t-pinned", body: "pinned sibling", replyToId: "t-root" });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "t-pinned" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `pad-${i}`, body: `pad ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  const live = f.store.room("commons").state.messages.map(m => m.id);
  assert.ok(!live.includes("t-reply") && !live.includes("t-deep"), "the reply and its reply are archived");
  assert.ok(live.includes("t-pinned") && live.includes("t-root"), "the pinned sibling and its ancestor root stay in the projection");
  // A message posted after the archive is live but has a row in the table too.
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "t-late", body: "late", replyToId: "t-root" });
  const tree = (token, id) => { const node = f.store.messageThread(token, "commons", id).thread; return { id: node.id, replies: node.replies.map(r => tree2(r)) }; };
  const tree2 = node => ({ id: node.id, replies: node.replies.map(tree2) });
  // The archived reply lists its own replies (private ones only to a party).
  assert.deepEqual(tree(f.human, "t-reply"), { id: "t-reply", replies: [{ id: "t-deep", replies: [] }, { id: "t-dm", replies: [] }] });
  assert.deepEqual(tree(f.stranger, "t-reply"), { id: "t-reply", replies: [{ id: "t-deep", replies: [] }] });
  // The root's view has each message once: the retained pinned sibling and the live late reply are in the
  // projection and the table, and must not be listed twice.
  assert.deepEqual(tree(f.human, "t-root"), { id: "t-root", replies: [
    { id: "t-reply", replies: [{ id: "t-deep", replies: [] }, { id: "t-dm", replies: [] }] },
    { id: "t-pinned", replies: [] },
    { id: "t-late", replies: [] },
  ] });
  // A stranger still learns nothing about an archived DM reply by asking for it.
  assert.throws(() => f.store.messageThread(f.stranger, "commons", "t-dm"), /not found|Message not found/i);
});

test("activity, saved list and read horizon resolve archived messages", async t => {
  const { listActivity, listSaved, setSaved, setReadHorizon } = await import("../server/activity.mjs");
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "private ping" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "old public" });
  setSaved(f.store, f.human, "commons", { messageId: "old-pub", saved: true });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  const gone = id => !f.store.room("commons").state.messages.some(m => m.id === id);
  assert.ok(gone("old-dm") && gone("old-pub"));
  const items = token => listActivity(f.store, token, "commons", {}).items ?? listActivity(f.store, token, "commons", {}).events;
  assert.ok(items(f.agent).some(item => item.messageId === "old-dm" && item.messageBody === "private ping"), "the archived DM mention is still listed to its party");
  assert.equal(listSaved(f.store, f.human, "commons").items.some(item => item.messageId === "old-pub" && item.body === "old public"), true);
  assert.doesNotThrow(() => setSaved(f.store, f.human, "commons", { messageId: "old-pub", saved: false }));
  assert.doesNotThrow(() => setReadHorizon(f.store, f.human, "commons", { threadId: "", lastReadMessageId: "old-pub" }));
  // A stranger still gets the same 404 for an archived DM as for an unknown id.
  const code = fn => { try { fn(); } catch (error) { return error.code ?? error.message; } return null; };
  assert.equal(code(() => setSaved(f.store, f.stranger, "commons", { messageId: "old-dm", saved: true })), code(() => setSaved(f.store, f.stranger, "commons", { messageId: "no-such", saved: true })));
});

test("the archived-reply thread lookup ignores a same-id message in another room", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "s-root", body: "root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "s-reply", body: "reply", replyToId: "s-root" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "s-deep", body: "deep", replyToId: "s-reply" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "s-pinned", body: "pinned sibling", replyToId: "s-root" });
  f.send(f.human, T.MESSAGE_PINNED, { messageId: "s-pinned" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `pad-${i}`, body: `pad ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  // Another room holds a message with the same id under a different thread. It gets the lowest rowid so an
  // unscoped lookup (message_id only) would read it first.
  f.store.db.exec("PRAGMA foreign_keys=OFF");
  f.store.db.prepare("INSERT INTO messages (rowid, room_id, message_id, seq, thread_root_id, author_id, created_at) VALUES (-1, 'other-room', 's-reply', 1, 'other-root', 'x', '2026-01-01T00:00:00Z')").run();
  const ids = f.store.messageThread(f.human, "commons", "s-reply").thread.replies.map(r => r.id);
  assert.deepEqual(ids, ["s-deep"]);
});

test("a file committed onto an archived DM stays visible to the DM's parties only", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "public" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "private" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "old-dm"), false);
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "old-pub"), false, "old-pub is archived too");
  const files = f.store.roomAttachments, index = files.messageIndex("commons");
  const row = { state: "committed", message_id: "old-dm", uploader_id: "human" };
  assert.equal(files.visibleTo(row, index, "human"), true);
  assert.equal(files.visibleTo(row, index, "agent"), true);
  assert.equal(files.visibleTo(row, index, "stranger"), false);
  // An archived public message is visible to a stranger; a never-posted message falls back to its uploader only.
  assert.equal(files.visibleTo({ ...row, message_id: "old-pub" }, index, "stranger"), true);
  assert.equal(files.visibleTo({ ...row, message_id: "never-posted" }, index, "stranger"), false);
});

test("reports can be filed against archived messages and keep their context, an archived DM stays hidden", t => {
  const f = fixture(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-pub", body: "rude old message" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "old-dm", toMemberId: "agent", body: "private" });
  for (let i = 0; i < 6; i++) f.send(f.human, T.MESSAGE_POSTED, { messageId: `x-${i}`, body: `x ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  f.store.checkMessagesParity();
  assert.ok(f.store.archiveMessages("commons", { keepNewest: 2, dryRun: false }).archived > 0);
  f.store.moderation.report(f.stranger, "commons", { messageId: "old-pub", reason: "rude" });
  const code = fn => { try { fn(); } catch (error) { return error.code ?? error.message; } return null; };
  assert.equal(code(() => f.store.moderation.report(f.stranger, "commons", { messageId: "old-dm", reason: "x" })), code(() => f.store.moderation.report(f.stranger, "commons", { messageId: "no-such", reason: "x" })));
  const { reports } = f.store.moderation.list(f.owner, "commons");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].message?.body, "rude old message");
});
