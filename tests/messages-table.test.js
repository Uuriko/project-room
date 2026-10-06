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
