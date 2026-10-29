// Privacy: a reply request's title must not echo a private context message the
// viewer cannot see. recordReplyPost moves contextMessageId to the newest message
// in the request's thread, and that message can be a DM to a third member.
// /updates (listRoomUpdates) and the owed-replies list both read projectRoom(),
// so both must apply the same rule as reply-context (server/reply-requests.mjs):
// a private message is visible only to its author and its recipient.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { listOwedReplies } from "../server/updates.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function serve(t, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), "room-req-privacy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  const ownerKey = store.issueAccessKey(roomId, "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

function addAgent(store, roomId, token, memberId, displayName) {
  const secret = `pri_${memberId}${"s".repeat(43 - memberId.length)}`;
  const identity = store.identities.create(displayName, { secret });
  linkWithProof(store, token, roomId, { identityId: identity.identityId, secret }, { memberId, displayName, permissions: ["accept_work", "complete_work"] });
  return { secret, memberKey: store.issueAccessKey(roomId, memberId) };
}

test("a request title never shows another member's private context message", async t => {
  const { store, ownerKey } = serve(t);
  const agent = addAgent(store, "commons", ownerKey, "agent", "Asked Agent");
  addAgent(store, "commons", ownerKey, "carol", "Carol");
  const requestId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: requestId, body: "can you confirm the plan?", toMemberId: "agent", requestKind: "reply"
  } });
  // The requester then DMs a third member inside the request's thread.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "carol-only secret: the budget is 42", toMemberId: "carol", replyToId: requestId
  } });
  const items = listOwedReplies(store, agent.secret).items.filter(item => item.kind === "request");
  assert.equal(items.length, 1, "the request is still owed to the agent");
  assert.doesNotMatch(items[0].title, /carol-only secret|budget/, "private context to carol must not reach the agent");
  assert.equal(items[0].sourceRef.requestId, requestId);
});

test("a request title still shows context the viewer can see", async t => {
  const { store, ownerKey } = serve(t);
  const agent = addAgent(store, "commons", ownerKey, "agent", "Asked Agent");
  const requestId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: requestId, body: "can you confirm the deploy window?", toMemberId: "agent", requestKind: "reply"
  } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "clarifying: the 4pm window", replyToId: requestId
  } });
  const items = listOwedReplies(store, agent.secret).items.filter(item => item.kind === "request");
  assert.equal(items.length, 1);
  assert.match(items[0].title, /4pm window/, "public context in the thread is the visible title");
});

test('reactivation hides old message-derived attention and work conversation pointers', async t => {
  const { store, ownerKey } = serve(t);
  const agent = addAgent(store, 'commons', ownerKey, 'agent', 'Asked Agent');
  const frozen = Date.now() + 10000; store.now = () => frozen;
  const send = (type, data) => store.command(ownerKey, 'commons', { id: randomUUID(), type, data });
  send(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: 'since_join' });
  send(T.WORK_PROPOSED, { workItemId: 'linked-work', title: 'Visible work', definitionOfDone: 'Done', accountableMemberId: 'agent', mode: 'read' });
  const post = (id, data = {}) => send(T.MESSAGE_POSTED, { messageId: id, body: `SECRET-${id}`, ...data });
  post('old-request', { toMemberId: 'agent', requestKind: 'reply', workItemId: 'linked-work' });
  const claim = (key, id) => {
    const request = store.room('commons').state.replyRequests[id];
    store.requestRuns.apply(key, 'commons', { requestMessageId: id, attemptId: `attempt-${id}`, action: 'claim',
      expectedRequestRevision: request.revision, contextEventId: request.contextEventId });
  };
  claim(agent.memberKey, 'old-request');
  post('old-unclaimed', { toMemberId: 'agent', requestKind: 'reply' });
  post('old-dm', { toMemberId: 'agent' });
  post('old-mention', { body: 'SECRET-old-mention @Asked Agent please look' });
  for (const active of [false, true]) {
    const member = store.room('commons').state.members.agent;
    send(T.MEMBER_ACCESS_CHANGED, { memberId: 'agent', active, permissions: member.permissions, expectedMemberRevision: member.revision ?? 0 });
  }
  const key = store.issueAccessKey('commons', 'agent');
  post('fresh-request', { body: 'Current question', toMemberId: 'agent', requestKind: 'reply', workItemId: 'linked-work' });
  claim(key, 'fresh-request');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/request-runs`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  assert.equal(response.status, 200);
  const { listRoomUpdates } = await import('../server/updates.mjs');
  const { roomAttention, collectNeedsMe } = await import('../server/needs-me.mjs');
  const observations = {
    httpRuns: await response.json(),
    runs: store.requestRuns.list(key, 'commons'),
    inbox: store.agentInbox(key, 'commons'),
    updates: listRoomUpdates(store, key, 'commons'),
    owed: listOwedReplies(store, agent.secret),
    attention: roomAttention(store, 'commons', 'agent', store.authenticate(key, 'commons').identityId, 0),
    needsMe: collectNeedsMe(store, agent.secret),
    work: store.workContext(key, 'commons', 'linked-work')
  };
  for (const [name, value] of Object.entries(observations)) await t.test(name, () => {
    assert.doesNotMatch(JSON.stringify(value), /SECRET-old-|old-request|old-unclaimed|old-dm|old-mention/);
    assert.match(JSON.stringify(value), /fresh-request/);
  });
  for (const [id, action] of [['old-unclaimed', 'claim'], ['old-request', 'working']]) {
    const request = store.room('commons').state.replyRequests[id];
    assert.throws(() => store.requestRuns.apply(key, 'commons', { requestMessageId: id, attemptId: `attempt-${id}`, action,
      expectedRequestRevision: request.revision, contextEventId: request.contextEventId }), e => e.code === 'request_run_changed');
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM request_runs WHERE request_id=?').get('old-unclaimed').n, 0);
  assert.equal(store.requestRuns.apply(key, 'commons', { requestMessageId: 'old-request', attemptId: 'attempt-old-request',
    action: 'needs_attention' }).state, 'needs_attention', 'the existing host may reconcile without restarting hidden work');
  send(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: 'all' });
  for (const value of [listRoomUpdates(store, key, 'commons'), listOwedReplies(store, agent.secret),
    roomAttention(store, 'commons', 'agent', store.authenticate(key, 'commons').identityId, 0),
    collectNeedsMe(store, agent.secret), store.workContext(key, 'commons', 'linked-work'), store.agentInbox(key, 'commons'),
    store.requestRuns.list(key, 'commons')]) {
    assert.match(JSON.stringify(value), /old-request/);
  }
});

test('hidden mention overflow cannot stall visible attention pagination', async t => {
  const { store, ownerKey } = serve(t);
  const agent = addAgent(store, 'commons', ownerKey, 'agent', 'Asked Agent');
  let clock = Date.now() + 10000; store.now = () => clock;
  const send = (type, data) => { clock += 2001; return store.command(ownerKey, 'commons', { id: randomUUID(), type, data }); };
  send(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: 'since_join' });
  for (let i = 0; i < 12; i++) send(T.MESSAGE_POSTED, { messageId: `hidden-${i}`, body: `@Asked Agent SECRET-old-${i}` });
  for (const active of [false, true]) {
    const member = store.room('commons').state.members.agent;
    send(T.MEMBER_ACCESS_CHANGED, { memberId: 'agent', active, permissions: member.permissions, expectedMemberRevision: member.revision ?? 0 });
  }
  for (let i = 0; i < 12; i++) send(T.MESSAGE_POSTED, { messageId: `fresh-${i}`, body: `@Asked Agent current ${i}` });
  const { collectNeedsMe } = await import('../server/needs-me.mjs');
  const key = store.issueAccessKey('commons', 'agent');
  const standing = store.agentInbox(key, 'commons', { after: 999999, limit: 20 });
  assert.deepEqual(standing.directMentions, []);
  assert.doesNotMatch(JSON.stringify(standing), /hidden-|SECRET-old-/);
  assert.equal(standing.attention.pendingMentions.length, 12, 'visible unanswered mentions survive an advanced delivery cursor');
  const seen = new Set(); let since = 0, page;
  for (let i = 0; i < 6; i++) {
    page = collectNeedsMe(store, agent.secret, { since });
    assert.doesNotMatch(JSON.stringify(page), /hidden-|SECRET-old-/);
    for (const item of page.items.filter(item => item.kind === 'mention')) {
      assert.equal(seen.has(item.id), false, 'no duplicate visible mentions'); seen.add(item.id);
    }
    since = page.cursor;
    if (!page.hasMore) break;
  }
  assert.equal(page.hasMore, false, 'bounded pagination terminates');
  assert.deepEqual([...seen].sort(), Array.from({ length: 12 }, (_, i) => `fresh-${i}`).sort());
});
