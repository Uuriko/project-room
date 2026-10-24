// SPILL-1 (iii): two-leg read parity. Archiving moves a room's old
// messages out of the projection into the messages table; every reader
// surface must answer identically before and after, or the archive is a
// behaviour change wearing a storage costume. This suite captures the
// reader-visible shape of a room — list, recent, single read, visibility-
// filtered list (targeted DMs), full-text search (including a third
// party searching for a DM needle), and a thread whose root and early
// replies archive — then archives most of the room and asserts every
// capture is byte-identical. It then exercises the rollback
// (restoreArchivedMessages) and asserts the projection is whole again,
// down to the full stored records.
//
// Reader-visible shape: the stored projection record carries editHistory,
// which the read path strips before serving (server/conversation-sync.mjs
// removes it; the archived leg keeps it in reducer_extras_json instead).
// Captures therefore compare records with editHistory removed — the shape
// readers actually get — and a separate assertion proves the archived
// edited message's history survives in reducer_extras_json and comes
// back, in full, on restore.
//
// The store's read code is one module set on both doors (the Cloudflare
// door serves the same store; cloudflare/operator-archive.check.mjs pins
// the archive door itself under workerd). Parity here is therefore
// asserted at the store surface both doors share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { messageRepository } from "../server/message-repository.mjs";
import { restoreArchivedMessages } from "../server/messages-store.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const memberId of ["alice", "bob"]) {
    store.command(owner, "commons", command(T.MEMBER_ADDED, {
      memberId, displayName: memberId, kind: "human",
      permissions: ["accept_work", "complete_work", "verify"]
    }));
  }
  const keys = {
    owner,
    alice: store.issueAccessKey("commons", "alice"),
    bob: store.issueAccessKey("commons", "bob")
  };
  t.after(() => { store.close(); });
  const senders = [keys.owner, keys.alice, keys.bob];
  let turn = 0;
  const post = (data, id) => store.command(senders[turn++ % senders.length], "commons",
    command(T.MESSAGE_POSTED, { messageId: id, ...data }, id));
  return { store, keys, post };
}

// The reader-visible record shape: every field a reader can observe,
// with editHistory removed (stripped on the read path; see the header).
function shape(message) {
  if (!message) return message;
  const { editHistory: _history, ...rest } = message;
  return rest;
}

function capture(store, keys) {
  const repo = messageRepository(store, "commons");
  const list = [...repo.records()].map(shape);
  const visibleToAlice = [...repo.records({ visibility: { viewerId: "alice" } })].map(shape);
  const recent = repo.recent(12).map(shape);
  const searchAlpha = store.search(keys.alice, "commons", "needle-alpha");
  const searchDmAlice = store.search(keys.alice, "commons", "needle-dm");
  const searchDmBob = store.search(keys.bob, "commons", "needle-dm");
  const searchDmOwner = store.search(keys.owner, "commons", "needle-dm");
  const thread = store.messageThread(keys.alice, "commons", "t-root");
  return {
    list,
    visibleToAlice,
    recent,
    singleOldest: shape(repo.get("m-001")),
    singleDm: shape(repo.get("dm-a")),
    count: repo.countMetadata(() => true),
    searchAlpha: { total: searchAlpha.total, hits: searchAlpha.messages.map(m => ({ id: m.id, body: m.body })) },
    searchDmAlice: { total: searchDmAlice.total, hits: searchDmAlice.messages.map(m => m.id) },
    searchDmBob: { total: searchDmBob.total, hits: searchDmBob.messages.map(m => m.id) },
    searchDmOwner: { total: searchDmOwner.total, hits: searchDmOwner.messages.map(m => m.id) },
    thread: JSON.parse(JSON.stringify(thread))
  };
}

test("list, read, search and thread are identical across an archive, and restore makes the projection whole", t => {
  const { store, keys, post } = fixture(t);
  // ~66 messages: plain posts (a search needle in every seventh), a
  // thread, two targeted DMs, an edited message, a deleted message, a
  // pinned message — the shapes whose two-leg behaviour can diverge.
  post({ body: "thread root, an early message" }, "t-root");
  for (let i = 1; i <= 56; i++) {
    post({ body: `parity post ${i}` + (i % 7 === 0 ? " needle-alpha" : "") }, `m-${String(i).padStart(3, "0")}`);
    if (i === 3) post({ body: "needle-dm for bob only", toMemberId: "bob" }, "dm-a");
    if (i === 4) post({ body: "reply one", replyToId: "t-root" }, "t-r1");
    if (i === 5) post({ body: "reply two, also sent to channel", replyToId: "t-root", alsoSendToChannel: true }, "t-r2");
    if (i === 6) post({ body: "needle-dm reply for alice", toMemberId: "alice" }, "dm-b");
    if (i === 8) post({ body: "original wording" }, "m-edit");
    if (i === 9) post({ body: "soon deleted" }, "m-del");
  }
  post({ body: "reply three, near the tail" , replyToId: "t-root" }, "t-r3");
  // The owner may change any message; the rotating posters above make
  // per-message authorship incidental to this fixture.
  store.command(keys.owner, "commons", command(T.MESSAGE_EDITED, { messageId: "m-edit", body: "needle-edited final wording", expectedMessageRevision: 0 }));
  store.command(keys.owner, "commons", command(T.MESSAGE_DELETED, { messageId: "m-del", expectedMessageRevision: 0 }));
  store.command(keys.owner, "commons", command(T.MESSAGE_PINNED, { messageId: "m-002" }));

  for (let i = 0; i < 40 && !store.backfillMessages({ limit: 1000 }).done; i++);
  assert.equal(store.checkMessagesParity({ roomId: "commons" }).ok, true);

  const before = capture(store, keys);
  const fullBefore = structuredClone([...messageRepository(store, "commons").records()]);
  const totalBefore = store.room("commons").state.messages.length;
  assert.equal(before.searchDmOwner.total, 0, "a third party cannot find the DM needle, before");
  assert.equal(before.searchDmAlice.total, 2, "both DMs are findable by a party, before");
  assert.ok(before.list.some(m => m.id === "t-r2:channel"), "the channel copy is listed, before");

  const archived = store.archiveMessages("commons", { keepNewest: 15, dryRun: false });
  assert.equal(archived.ok, true);
  assert.ok(archived.archived > 40, `most of the room archived (${archived.archived})`);
  assert.ok(store.room("commons").state.messagesArchive, "the archive marker is set");
  assert.ok(store.room("commons").state.messages.some(m => m.id === "m-002"),
    "the pinned message is retained in the projection by state");

  // The archived edited message keeps its history in the mirror's extras.
  const editedRow = store.db.prepare("SELECT reducer_extras_json FROM messages WHERE room_id='commons' AND message_id='m-edit'").get();
  const extras = JSON.parse(editedRow.reducer_extras_json);
  assert.ok(Array.isArray(extras.editHistory) && extras.editHistory.length === 1,
    "the archived edited message's edit history survives in reducer_extras_json");

  const after = capture(store, keys);
  assert.deepEqual(after, before, "every reader surface answers identically after the archive");

  // Rollback: restoreArchivedMessages puts every archived message back
  // and drops the marker; the full stored records — editHistory and
  // all — are the ones the room started with.
  const restored = restoreArchivedMessages(store, "commons");
  assert.equal(restored, archived.archived, "restore returns every archived message");
  assert.equal(store.room("commons").state.messagesArchive, undefined, "the marker is gone");
  assert.equal(store.room("commons").state.messages.length, totalBefore, "the projection is whole again");
  const fullAfter = structuredClone([...messageRepository(store, "commons").records()]);
  assert.deepEqual(fullAfter, fullBefore, "full stored records are identical after restore");
});
