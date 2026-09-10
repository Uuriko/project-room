import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, replay } from "../src/events.js";
import { conversationIndex, searchMessages, ConversationDrafts, messageCluster, mentionQuery, mentionMatches, insertMention, mentionHtml, GROUP_WINDOW_MS, kindLabel, memberStatus, addressMember, shouldAddressPresenceClick } from "../src/conversation.js";
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
  drafts.save(null, { body: "Room thought", toMemberId: "human", error: "Room send failed" });
  drafts.save("topic", { body: "Thread thought", toMemberId: "agent", replyToId: "reply", pending, error: "Thread send failed" });
  drafts.save("second", { body: "Another thought" });
  assert.equal(drafts.get("topic").pending.command.id, pending.command.id);
  assert.equal(drafts.get("topic").replyToId, "reply");
  assert.equal(drafts.get("topic").error, "Thread send failed");
  assert.equal(drafts.get(null).error, "Room send failed");
  assert.equal(drafts.get(null).toMemberId, "human");
  drafts.clear("topic");
  assert.equal(drafts.get("topic").replyToId, "topic");
  assert.equal(drafts.get("topic").error, "");
  assert.equal(drafts.get(null).error, "Room send failed");
  assert.equal(drafts.get(null).body, "Room thought");
  const nextSession = new ConversationDrafts();
  assert.equal(nextSession.hasText(), false);
  assert.equal(nextSession.get(null).error, "");
});

test("consecutive same-author messages cluster until a new day or a different person", () => {
  const t0 = "2026-09-09T18:00:00.000Z";
  const t1 = new Date(Date.parse(t0) + GROUP_WINDOW_MS / 2).toISOString();
  const tLate = new Date(Date.parse(t0) + GROUP_WINDOW_MS + 1000).toISOString();
  const tNextDay = "2026-09-10T18:00:00.000Z";
  const messages = [
    { id: "a", authorId: "maya", createdAt: t0 },
    { id: "b", authorId: "maya", createdAt: t1 },
    { id: "c", authorId: "jordan", createdAt: t1 },
    { id: "d", authorId: "maya", createdAt: tLate },
    { id: "e", authorId: "maya", createdAt: tNextDay }
  ];
  assert.equal(messageCluster(messages, 0).grouped, false);
  assert.equal(messageCluster(messages, 0).dayStart, true);
  assert.equal(messageCluster(messages, 1).grouped, true);
  assert.equal(messageCluster(messages, 2).grouped, false);
  assert.equal(messageCluster(messages, 3).grouped, false);
  assert.equal(messageCluster(messages, 4).dayStart, true);
  assert.equal(messageCluster(messages, 4).grouped, false);
});

test("composer @ query picks people and agents and mention HTML stays escaped", () => {
  assert.equal(mentionQuery("hello", 5), null);
  assert.deepEqual(mentionQuery("hi @In", 6), { start: 3, query: "In" });
  const members = [
    { id: "instinct", displayName: "Instinct", kind: "agent", active: true },
    { id: "maya", displayName: "Maya", kind: "human", active: true },
    { id: "gone", displayName: "Gone", kind: "human", active: false }
  ];
  assert.deepEqual(mentionMatches(members, "in").map(m => m.id), ["instinct"]);
  assert.equal(mentionMatches(members, "").length, 2);
  const inserted = insertMention("hi @In", 6, 3, members[0]);
  assert.equal(inserted.body, "hi @Instinct ");
  assert.equal(inserted.toMemberId, "instinct");
  const esc = value => String(value).replaceAll("<", "&lt;");
  assert.match(mentionHtml("Ask @Instinct tomorrow", members, esc), /mention agent/);
  assert.equal(mentionHtml("Ask <script> @Maya", members, esc).includes("<script>"), false);
  assert.match(mentionHtml("Ask <script> @Maya", members, esc), /mention"/);
  assert.equal(kindLabel("agent"), "Agent");
  assert.equal(kindLabel("human"), "Person");
  assert.equal(kindLabel("agent") === kindLabel("human"), false);
  assert.equal(memberStatus({ kind: "agent", active: true }), "Agent");
  assert.equal(memberStatus({ kind: "human", active: true }), "Person");
  assert.equal(memberStatus({ kind: "agent", active: false }), "access revoked");
  const fromClick = addressMember("hello", 5, members[0]);
  assert.equal(fromClick.body, "hello @Instinct ");
  assert.equal(fromClick.toMemberId, "instinct");
  const fromAt = addressMember("hi @In", 6, members[0]);
  assert.equal(fromAt.body, "hi @Instinct ");
  assert.equal(fromAt.toMemberId, insertMention("hi @In", 6, 3, members[0]).toMemberId);
});

function presenceTree() {
  const matches = (node, selector) => selector.split(",").map(part => part.trim()).some(part => {
    if (part.startsWith(".")) return (node.className || "").split(/\s+/).includes(part.slice(1));
    if (part.startsWith("#")) return node.id === part.slice(1);
    return node.tagName === part.toUpperCase();
  });
  const make = (tag, attrs = {}) => {
    const node = {
      tagName: tag.toUpperCase(), className: attrs.className || "", id: attrs.id || "", parentNode: null,
      closest(selector) { let n = this; while (n) { if (matches(n, selector)) return n; n = n.parentNode; } return null; },
      contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    };
    return node;
  };
  const panel = make("details", { id: "people-panel" });
  const panelSummary = make("summary", { id: "presence-title" });
  const list = make("div", { id: "presence-list" });
  const row = make("div", { className: "presence-member" });
  const name = make("strong");
  const inner = make("details");
  const innerSummary = make("summary");
  panelSummary.parentNode = panel;
  list.parentNode = panel;
  row.parentNode = list;
  name.parentNode = row;
  inner.parentNode = row;
  innerSummary.parentNode = inner;
  return { panel, panelSummary, name, innerSummary };
}

test("People-panel wrapping details does not swallow a name click; inner capabilities summary does", () => {
  const { name, innerSummary, panelSummary } = presenceTree();
  assert.equal(shouldAddressPresenceClick(name), true);
  assert.equal(shouldAddressPresenceClick(innerSummary), false);
  assert.equal(shouldAddressPresenceClick(panelSummary), false);
});
