import {seedHistoricalNeedsMeRoom} from './helpers/historical-needs-me-room.mjs';
// Round 3 of W2-F9-CURE (RES-1538, Codex seq 25334): the room digest
// composes its attention section from roomAttention, whose bounded
// reply scan clamps the window to scanned ground — but the digest
// advertised the room head as through/next with an attentionTotal of
// 0 and no incomplete marker, so a visible reply beyond the clamp was
// silently lost to any reader that advanced its cursor. Reproduced on
// a real RoomStore at the round-2 head: parent post, 300 plain posts,
// then a reply — round-1 head attentionTotal=1 with the reply present;
// round-2 head attentionTotal=0, reply absent, through/next=head, no
// marker. The cure propagates the slice's coverage: the digest names
// coverage.attentionThrough, marks coverage.attentionIncomplete, and
// carries a followUps.attention continuation read. The scans stay
// bounded — no full-history scan is restored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function setup(t, roomId) {
  const store = new RoomStore(':memory:');
  let clock = Date.now();
  store.now = () => (clock += 2100); // stay under the chat flood guard
  t.after(() => store.close());
  const bob = store.identities.create('Bob');
  const owner = store.identities.create('OwnerC');
  seedHistoricalNeedsMeRoom(store,owner, { roomId, title: roomId, purpose: 'Digest coverage', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  store.command(owner.secret, roomId, { id: 'add-maya', type: 'member.added', data: { memberId: 'maya', displayName: 'Maya', kind: 'human', permissions: [] } });
  const maya = store.identities.create('Maya');
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run(roomId, maya.identityId, 'maya', Date.now());
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  return { store, bob, owner, maya, roomId, post };
}

test('digest coverage: a reply past the scan clamp is marked incomplete, and the continuation finds it', t => {
  const { store, bob, owner, maya, roomId, post } = setup(t, 'digest-coverage-clamped');
  post(maya.secret, 'parent', { body: 'Maya parent post' });
  for (let i = 0; i < 300; i++) post(i % 2 ? owner.secret : bob.secret, `plain-${i}`, { body: `plain post ${i}` });
  post(bob.secret, 'the-reply', { body: 'a reply to Maya', replyToId: 'parent' });
  const head = store.room(roomId).sequence;

  const digest = store.roomDigest(maya.secret, roomId, { since: 0 });
  assert.equal(digest.coverage.attentionTotal, 0, 'the clamped window contains no attention items');
  assert.equal(digest.coverage.attentionIncomplete, true,
    'the digest admits the attention scan stopped at its budget');
  assert.ok(Number.isSafeInteger(digest.coverage.attentionThrough) && digest.coverage.attentionThrough < head,
    `attention coverage stops at scanned ground, not the head (got ${digest.coverage.attentionThrough} of ${head})`);
  assert.equal(digest.followUps.attention, `GET /api/rooms/${roomId}/digest?since=${digest.coverage.attentionThrough}`,
    'the continuation read rides the digest');

  const continued = store.roomDigest(maya.secret, roomId, { since: digest.coverage.attentionThrough });
  assert.ok(continued.attention.some(item => item.id === 'the-reply'),
    'the continuation read surfaces the reply the first read could not scan to');
  assert.equal(continued.coverage.attentionIncomplete, undefined,
    'the continuation scanned its whole window, so no marker is carried');
});

test('digest coverage: a fully scanned window carries no incomplete marker', t => {
  const { store, bob, maya, roomId, post } = setup(t, 'digest-coverage-complete');
  post(maya.secret, 'parent', { body: 'Maya parent post' });
  post(bob.secret, 'the-reply', { body: 'a reply to Maya', replyToId: 'parent' });
  const digest = store.roomDigest(maya.secret, roomId, { since: 0 });
  assert.ok(digest.attention.some(item => item.id === 'the-reply'), 'the reply is in the first read');
  assert.equal(digest.coverage.attentionTotal, 1);
  assert.equal(digest.coverage.attentionIncomplete, undefined);
  assert.equal(digest.coverage.attentionThrough, undefined, 'complete coverage keeps the pre-marker shape');
  assert.equal(digest.followUps.attention, undefined);
});
