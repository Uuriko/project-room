// Latest open mentions in needs-me, and mention updates that point at the
// mention. Measured in muse-room on 2026-10-05: a fresh needs-me call (no
// saved cursor) listed Grok Bot's 8 OLDEST open mentions (seq 792-1444) and
// not the two posted minutes earlier (3626, 3633); 161 of its 163 mention
// receipts had timed out. Updates for those mentions said
// GET /events?after=0, i.e. day-one history. latestMentions is standing
// state beside items (like openWork): newest first, capped, cursor untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { listRoomUpdates } from '../server/updates.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

function setup(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const roomId = 'latest-mentions';
  rooms.create(owner.secret, { roomId, title: roomId, purpose: 'Mentions', kind: 'personal' });
  for (const [who, name] of [[ada, 'Ada'], [bob, 'Bob']]) {
    store.identities.link(owner.secret, roomId, { identityId: who.identityId, displayName: name, permissions: [] });
    setTier(store.db, roomId, who.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  }
  const say = (who, id, body, extra = {}) => store.command(who.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body, ...extra } });
  return { store, ada, bob, roomId, say };
}

test('a fresh needs-me call shows the newest open mentions, not only the oldest page', t => {
  const { store, ada, bob, say } = setup(t);
  assert.equal(collectNeedsMe(store, ada.secret, {}).latestMentions, undefined, 'no mentions adds nothing');
  for (let i = 0; i < 12; i++) say(bob, `m${i}`, `@Ada question ${i}`);
  say(bob, 'chatter', 'unrelated room chatter');
  const page = collectNeedsMe(store, ada.secret, {});
  const listed = page.items.filter(item => item.kind === 'mention').map(item => item.id);
  assert.ok(!listed.includes('m11'), 'the cursor page is oldest-first (unchanged contract)');
  assert.equal(page.latestMentions.length, 1);
  const latest = page.latestMentions[0];
  assert.deepEqual(latest.top.map(row => row.id), ['m11', 'm10', 'm9'], 'newest first, capped at 3');
  assert.equal(latest.top[0].from, bob.identityId);
  assert.equal(latest.top[0].next.tool, 'room_reply');
  assert.equal(latest.top[0].next.arguments.replyToId, 'm11');
  assert.equal(latest.newestSeq, latest.top[0].seq);
  assert.deepEqual(collectNeedsMe(store, ada.secret, {}).cursor, page.cursor, 'latestMentions never moves the cursor');
  assert.ok(JSON.stringify(latest).length < 1500, `latestMentions was ${JSON.stringify(latest).length} bytes`);
});

test('an answered mention leaves latestMentions; a private mention for someone else never shows', t => {
  const { store, ada, bob, say } = setup(t);
  say(bob, 'old', '@Ada older ask');
  say(bob, 'new', '@Ada newer ask');
  say(ada, 'reply', 'answered', { replyToId: 'new' });
  say(ada, 'aside', '@Bob private aside', { toMemberId: bob.identityId });
  const first = collectNeedsMe(store, ada.secret, {});
  assert.deepEqual(first.latestMentions[0].top.map(row => row.id), ['old']);
  assert.equal(first.hasMore, false);
  assert.equal(collectNeedsMe(store, ada.secret, { since: first.cursor }).latestMentions, undefined,
    'a caught-up quiet poll does no extra read and adds nothing');
  say(bob, 'fresh', '@Ada new since your cursor');
  assert.deepEqual(collectNeedsMe(store, ada.secret, { since: first.cursor }).latestMentions[0].top.map(row => row.id), ['fresh', 'old']);
});

test('a mention update points at the mention, not at the start of the log', t => {
  const { store, ada, bob, roomId, say } = setup(t);
  for (let i = 0; i < 5; i++) say(bob, `noise-${i}`, 'noise');
  say(bob, 'ask', '@Ada please look');
  const mention = listRoomUpdates(store, ada.secret, roomId, {}).items.find(item => item.kind === 'mention');
  assert.ok(mention, 'expected a mention update');
  const match = /events\?after=(\d+)&limit=20$/.exec(mention.next.path);
  assert.ok(match, `next path was ${mention.next.path}`);
  const page = store.eventsAfter(ada.secret, roomId, Number(match[1]), 1);
  assert.equal(page.events[0].event.data.messageId, 'ask', 'following next lands on the mention itself');
});
