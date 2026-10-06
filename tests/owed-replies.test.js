// Owed-replies inbox: one poll for "what replies are owed to me right now".
// Kinds: direct questions (request), mentions awaiting reply, DMs, review
// requests naming the viewer, and open handoffs addressed to the viewer.
// Answered, handled, and cleared items leave the list; the list is ordered
// by waiting time, oldest first, so the most overdue reply surfaces first.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";
import { listOwedReplies } from "../server/updates.mjs";

const AGENT_PERMISSIONS = ["accept_work", "complete_work"];

function serve(t, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), "room-owed-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  const ownerKey = store.issueAccessKey(roomId, "owner");
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory, ownerKey, roomId };
}

// Identity-linked agent member; returns the identity secret for listOwedReplies.
function addIdentityAgent(store, roomId, token, memberId, displayName, permissions = AGENT_PERMISSIONS) {
  const secret = `pri_${memberId}${"s".repeat(43 - memberId.length)}`;
  assert.match(secret, /^pri_[A-Za-z0-9_-]{43}$/);
  const identity = store.identities.create(displayName, { secret });
  store.identities.link(token, roomId, {
    identityId: identity.identityId, memberId, displayName, permissions
  });
  return { secret, identityId: identity.identityId, memberKey: store.issueAccessKey(roomId, memberId) };
}

function ask(store, roomId, token, toMemberId, body = "please confirm the plan") {
  const messageId = randomUUID();
  const opened = store.command(token, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId, body, toMemberId, requestKind: "reply"
  } });
  return { messageId, opened };
}

function answer(store, roomId, token, messageId, opened, toMemberId = "owner", body = "confirmed") {
  store.command(token, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body, replyToId: messageId, responseToRequestId: messageId,
    expectedRequestRevision: 0, responseOutcome: "answered", toMemberId, workItemId: null,
    contextEventId: opened.event.id, contextSequence: opened.sequence
  } });
}

function owed(store, secret, query) {
  return listOwedReplies(store, secret, query);
}

test("a direct question owed to the agent carries who, what, where, and waiting", async t => {
  const { store, ownerKey } = serve(t);
  const { secret } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  const { messageId } = ask(store, "commons", ownerKey, "agent", "can you confirm the deploy window?");
  const listed = owed(store, secret);
  assert.equal(listed.untrusted, true);
  assert.equal(listed.items.length, 1);
  const item = listed.items[0];
  assert.equal(item.kind, "request");
  assert.equal(item.state, "unread");
  assert.equal(item.actor, "owner");
  assert.match(item.title, /deploy window/);
  assert.equal(item.roomId, "commons");
  assert.equal(item.sourceRef.requestId, messageId);
  assert.equal(item.where.roomId, "commons");
  assert.equal(item.where.requestId, messageId);
  assert.ok(typeof item.waitingMs === "number" && item.waitingMs >= 0, "waitingMs is a non-negative number");
  assert.match(item.basisToken, /^ub1_[a-f0-9]{64}$/);
  assert.ok(item.next, "a next action is suggested");
});

test("an answered question leaves the owed list", async t => {
  const { store, ownerKey } = serve(t);
  const { secret, memberKey } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  const { messageId, opened } = ask(store, "commons", ownerKey, "agent");
  assert.equal(owed(store, secret).items.length, 1);
  answer(store, "commons", memberKey, messageId, opened);
  assert.deepEqual(owed(store, secret).items, []);
});

test("a mention awaiting reply is owed; the agent's own post retires it", async t => {
  const { store, ownerKey } = serve(t);
  const { secret, memberKey } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  const mentionId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: mentionId, body: "@Owed Agent please review the plan"
  } });
  const listed = owed(store, secret);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].kind, "mention");
  assert.equal(listed.items[0].actor, "owner");
  assert.equal(listed.items[0].where.messageId, mentionId);
  store.command(memberKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "looking now", replyToId: mentionId
  } });
  assert.deepEqual(owed(store, secret).items, [], "a reply to the mention retires it");
});

test("the list is ordered by waiting time, oldest first", async t => {
  const { store, ownerKey } = serve(t);
  const { secret } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  ask(store, "commons", ownerKey, "agent", "first question");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "@Owed Agent second thing"
  } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "third thing", toMemberId: "agent"
  } });
  const items = owed(store, secret).items;
  assert.equal(items.length, 3);
  for (let i = 0; i + 1 < items.length; i++) {
    assert.ok(items[i].createdAt <= items[i + 1].createdAt, "createdAt is non-decreasing");
    assert.ok(items[i].waitingMs >= items[i + 1].waitingMs, "waitingMs is non-increasing: oldest waits longest");
  }
  assert.equal(items[0].kind, "request", "the oldest item (the question) sorts first");
});

test("a DM is owed until the agent replies to it", async t => {
  const { store, ownerKey } = serve(t);
  const { secret, memberKey } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  const dmId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: dmId, body: "quick question for you", toMemberId: "agent"
  } });
  const listed = owed(store, secret);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].kind, "dm");
  assert.equal(listed.items[0].where.messageId, dmId);
  store.command(memberKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "on it", replyToId: dmId, toMemberId: "owner"
  } });
  assert.deepEqual(owed(store, secret).items, []);
});

test("a done mark retires the item from the owed list", async t => {
  const { store, ownerKey } = serve(t);
  const { secret, memberKey } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  ask(store, "commons", ownerKey, "agent");
  const item = owed(store, secret).items[0];
  const { markUpdate } = await import("../server/updates.mjs");
  const marked = markUpdate(store, memberKey, "commons", item.id, "done", randomUUID(), null, item.basisToken);
  assert.equal(marked.item.state, "handled");
  assert.deepEqual(owed(store, secret).items, [], "handled items are not owed");
});

test("an unknown identity secret is refused", async t => {
  const { store } = serve(t);
  assert.throws(() => owed(store, `pri_${"z".repeat(43)}`), /Unknown or revoked identity secret/);
});

test("limit and cursor page through the oldest-first list", async t => {
  const { store, ownerKey } = serve(t);
  const { secret } = addIdentityAgent(store, "commons", ownerKey, "agent", "Owed Agent");
  ask(store, "commons", ownerKey, "agent", "question one");
  ask(store, "commons", ownerKey, "agent", "question two");
  ask(store, "commons", ownerKey, "agent", "question three");
  const first = owed(store, secret, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.cursor, "a cursor is returned while pages remain");
  const second = owed(store, secret, { limit: 2, cursor: first.cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.cursor, null);
  const ids = new Set([...first.items, ...second.items].map(item => item.id));
  assert.equal(ids.size, 3, "pages do not repeat items");
  assert.throws(() => owed(store, secret, { limit: 0 }), /limit/);
  assert.throws(() => owed(store, secret, { cursor: "bogus" }), /cursor/);
});

test("an open handoff addressed to the viewer is owed; closing it removes it", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-owed-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  // The viewer is the room owner here because an open handoff triages to the owner.
  const secret = `pri_${"b".repeat(43)}`;
  const identity = store.identities.create("Boss Agent", { secret });
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "boss", roomId: "commons",
      data: { roomId: "commons", ownerId: "boss", title: "t", purpose: "t" } }),
    event({ type: T.MEMBER_ADDED, actorId: "boss", roomId: "commons",
      data: { memberId: "boss", displayName: "Boss Agent", kind: "agent",
        identityId: identity.identityId, permissions: [...PERMISSIONS] } })
  ]);
  const bossKey = store.issueAccessKey("commons", "boss");
  store.identities.link(bossKey, "commons", {
    identityId: identity.identityId, memberId: "boss", displayName: "Boss Agent", permissions: [...PERMISSIONS]
  });
  store.command(bossKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "wi-1", title: "Handoff fixture", definitionOfDone: "done",
    accountableMemberId: "boss"
  } });
  const revision = store.room("commons").state.workItems["wi-1"].revision;
  store.command(bossKey, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: {
    workItemId: "wi-1", expectedRevision: revision
  } });
  store.command(bossKey, "commons", { id: randomUUID(), type: T.WORK_HANDOFF_RECORDED, data: {
    workItemId: "wi-1", expectedRevision: revision + 1,
    doneSummary: "half done", nextAction: "finish the rest", limitReason: "context ended"
  } });
  const listed = owed(store, secret);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].kind, "handoff");
  assert.equal(listed.items[0].sourceRef.workItemId, "wi-1");
  assert.equal(listed.items[0].where.workItemId, "wi-1");
  assert.match(listed.items[0].title, /finish the rest/);
});
