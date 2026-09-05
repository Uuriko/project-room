import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, replay } from "../src/events.js";
import { conversationIndex, searchMessages, ConversationDrafts } from "../src/conversation.js";
import { draftCommand } from "../src/client.js";

function room(t) {
  const directory = mkdtempSync(join(tmpdir(), "conversation-")), filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data, id = crypto.randomUUID()) => store.command(key, "commons", { id, type, data });
  for (const kind of ["human", "agent"]) send(owner, T.MEMBER_ADDED, { memberId: kind, displayName: kind, kind, permissions: [] });
  const human = store.issueAccessKey("commons", "human"), agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, owner, human, agent, send, restart() { store.close(); store = new RoomStore(filename); } };
}

test("historical reply chains form one thread and survive restart without copying messages", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "A place to hang out" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "reply", body: "A reading club?", replyToId: "topic" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "nested", body: "Yes, science fiction", replyToId: "reply" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "other-topic", body: "Coffee?" });
  const before = f.store.snapshot(f.human, "commons").state;
  f.restart();
  const after = f.store.snapshot(f.human, "commons").state;
  assert.deepEqual(after, before);
  const index = conversationIndex(after.messages);
  assert.deepEqual(index.roots.map(m => m.id), ["topic", "other-topic"]);
  assert.deepEqual(index.threads.get("topic").map(m => m.id), ["topic", "reply", "nested"]);
  assert.equal(index.rootById.get("nested"), "topic");
  assert.equal(after.messages.length, 4);
  assert.equal(Object.keys(after.workItems).length, 0);
  assert.deepEqual(replay(after.eventLog).messages, after.messages);
  f.send(f.owner, T.WORK_PROPOSED, { workItemId: "reading", title: "Choose a book", definitionOfDone: "A shortlist", accountableMemberId: "owner", sourceMessageId: "nested" });
  assert.equal(f.store.snapshot(f.owner, "commons").state.workItems.reading.sourceMessageId, "nested");
});

test("reaction choices belong to their actors and old retries never reverse a later removal", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Friday gathering" });
  const before = f.store.snapshot(f.owner, "commons").state;
  const choice = { messageId: "topic", reaction: "heart", active: true };
  const first = f.send(f.human, T.MESSAGE_REACTION_SET, choice, "like-once");
  f.send(f.agent, T.MESSAGE_REACTION_SET, choice);
  f.send(f.human, T.MESSAGE_REACTION_SET, choice);
  assert.deepEqual(f.store.snapshot(f.owner, "commons").state.messages[0].reactions.heart, ["agent", "human"]);
  f.send(f.human, T.MESSAGE_REACTION_SET, { ...choice, active: false });
  f.restart();
  const retry = f.send(f.human, T.MESSAGE_REACTION_SET, choice, "like-once");
  assert.equal(retry.duplicate, true); assert.equal(retry.sequence, first.sequence);
  const after = f.store.snapshot(f.owner, "commons").state;
  assert.deepEqual(after.messages[0].reactions.heart, ["agent"]);
  assert.deepEqual(after.members, before.members); assert.deepEqual(after.workItems, before.workItems);
  assert.deepEqual(replay(after.eventLog).messages, after.messages);
});

test("invalid or unauthorized conversation references leave both history and projection unchanged", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Local discussion" });
  f.store.initialize(initialRoom("separate", "elsewhere"));
  const elsewhere = f.store.issueAccessKey("separate", "elsewhere");
  f.store.command(elsewhere, "separate", { id: "foreign-message", type: T.MESSAGE_POSTED, data: { messageId: "foreign", body: "Other room" } });
  const before = f.store.snapshot(f.owner, "commons");
  for (const data of [
    { messageId: "foreign", reaction: "heart", active: true },
    { messageId: "topic", reaction: "unbounded-choice", active: true },
    { messageId: "topic", reaction: "heart", active: "yes" },
    { messageId: "topic", reaction: "heart", active: true, memberId: "owner" }
  ]) assert.throws(() => f.send(f.human, T.MESSAGE_REACTION_SET, data));
  assert.throws(() => f.send(f.human, T.MESSAGE_POSTED, { body: "Reply", replyToId: "foreign" }));
  assert.throws(() => f.store.snapshot(elsewhere, "commons"), /does not grant access/);
  assert.deepEqual(f.store.snapshot(f.owner, "commons"), before);
  f.send(f.owner, T.MEMBER_ACCESS_CHANGED, { memberId: "human", expectedMemberRevision: 0, permissions: [], active: false });
  const removed = f.store.snapshot(f.owner, "commons");
  assert.throws(() => f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "heart", active: true }), /revoked/);
  assert.deepEqual(f.store.snapshot(f.owner, "commons"), removed);
});

test("search finds older replies outside the audit tail, is literal, bounded, and does not mutate the room", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Book club" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "target", body: "Dune [edition] <paperback>", replyToId: "topic" });
  for (let i = 0; i < 110; i++) f.send(f.human, T.MESSAGE_POSTED, { body: `Update ${i}` });
  const snapshot = f.store.snapshot(f.human, "commons"), before = JSON.stringify(snapshot);
  assert.equal(snapshot.state.eventLog.length, 100);
  assert.equal(searchMessages(snapshot.state, "DUNE [edition]").messages[0].id, "target");
  assert.equal(searchMessages(snapshot.state, "<paperback>").total, 1);
  assert.equal(searchMessages(snapshot.state, "agent").total, 1);
  assert.equal(searchMessages(snapshot.state, ".*").total, 0);
  assert.equal(searchMessages(snapshot.state, "  ").total, 0);
  assert.equal(searchMessages(snapshot.state, "update").messages.length, 50);
  assert.equal(searchMessages(snapshot.state, "update").total, 110);
  assert.equal(JSON.stringify(snapshot), before);
});

test("navigation preserves independent reply targets and retry IDs; a new session has no old drafts", () => {
  const drafts = new ConversationDrafts();
  const pending = draftCommand(null, T.MESSAGE_POSTED, { body: "Thread thought", replyToId: "reply" });
  drafts.save(null, { body: "Room thought", toMemberId: "human" });
  drafts.save("topic", { body: "Thread thought", toMemberId: "agent", replyToId: "reply", pending });
  drafts.save("second", { body: "Another thought" });
  assert.equal(drafts.get("topic").pending.command.id, pending.command.id);
  assert.equal(drafts.get("topic").replyToId, "reply");
  assert.equal(drafts.get(null).toMemberId, "human");
  drafts.clear("topic");
  assert.equal(drafts.get("topic").replyToId, "topic");
  assert.equal(drafts.get(null).body, "Room thought");
  assert.equal(new ConversationDrafts().hasText(), false);
});
