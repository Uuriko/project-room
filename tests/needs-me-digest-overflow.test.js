import {seedHistoricalNeedsMeRoom} from './helpers/historical-needs-me-room.mjs';
// CURE5582 (Codex seq 25449, restated seq 25522): the needs-me digest
// truncated its attention listing with no attentionIncomplete /
// continuation marker — a room with 8 replies to the viewer's post
// listed 5 of coverage.attentionTotal 8, the scans complete and no
// per-kind clamp engaged, so a consumer advancing the digest cursor
// (next = through) silently lost the unlisted replies. Two silent
// drops composed: the digest section cap took the LATEST 5 rows, and
// the slice's per-kind overflow clamp (MAX_PER_KIND) excluded items
// from the listing while the slice still reported complete coverage
// through the pre-clamp sequence. The cure: the slice reports the
// ground its listing is complete through (an engaged clamp marks it
// incomplete), the digest lists attention chronologically (earliest
// first) and marks attentionIncomplete whenever the section is not
// the whole listing, with coverage.attentionThrough naming the
// sequence the listing is complete through and followUps.attention
// paging it forward. A fully listed window keeps the pre-marker shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { buildRoomDigest } from '../server/room-digest.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function setup(t, roomId) {
  const store = new RoomStore(':memory:');
  let clock = Date.now();
  store.now = () => (clock += 2100); // stay under the chat flood guard
  t.after(() => store.close());
  const bob = store.identities.create('Bob');
  const owner = store.identities.create('OwnerC');
  seedHistoricalNeedsMeRoom(store,owner, { roomId, title: roomId, purpose: 'Digest overflow', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  store.command(owner.secret, roomId, { id: 'add-maya', type: 'member.added', data: { memberId: 'maya', displayName: 'Maya', kind: 'human', permissions: [] } });
  const maya = store.identities.create('Maya');
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run(roomId, maya.identityId, 'maya', Date.now());
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  const reply = n => post(n % 2 ? bob.secret : owner.secret, `reply-${n}`, { body: `reply ${n} to Maya`, replyToId: 'parent' });
  post(maya.secret, 'parent', { body: 'Maya parent post' });
  return { store, maya, roomId, reply };
}

test('digest overflow: 8 replies list the earliest 5 with the marker, and the continuation lists the rest', t => {
  const { store, maya, roomId, reply } = setup(t, 'digest-overflow-cap');
  for (let i = 1; i <= 8; i++) reply(i);

  const digest = store.roomDigest(maya.secret, roomId, { since: 0 });
  assert.deepEqual(digest.attention.map(a => a.id), ['reply-1', 'reply-2', 'reply-3', 'reply-4', 'reply-5'],
    'the section lists the earliest items, not the latest');
  assert.equal(digest.coverage.attentionTotal, 8);
  assert.equal(digest.coverage.attentionIncomplete, true,
    'the digest admits the section is not the whole listing');
  const fifthSeq = digest.attention[digest.attention.length - 1].seq;
  assert.equal(digest.coverage.attentionThrough, fifthSeq,
    'the listing is complete through the last listed row (distinct sequences)');
  assert.equal(digest.followUps.attention, `GET /api/rooms/${roomId}/digest?since=${fifthSeq}`,
    'the continuation read rides the digest');

  const continued = store.roomDigest(maya.secret, roomId, { since: digest.coverage.attentionThrough });
  assert.deepEqual(continued.attention.map(a => a.id), ['reply-6', 'reply-7', 'reply-8'],
    'the continuation surfaces the replies the first read could not list');
  assert.equal(continued.coverage.attentionIncomplete, undefined,
    'the continuation listed its whole window, so no marker is carried');
  assert.equal(continued.followUps.attention, undefined);
});

test('digest overflow: 10 replies page to ground — the per-kind clamp marks the slice incomplete', t => {
  const { store, maya, roomId, reply } = setup(t, 'digest-overflow-kind');
  for (let i = 1; i <= 10; i++) reply(i);

  const seen = [];
  let since = 0;
  let digest;
  for (let page = 0; page < 6; page++) {
    digest = store.roomDigest(maya.secret, roomId, { since });
    seen.push(...digest.attention.map(a => a.id));
    if (digest.coverage.attentionIncomplete !== true) break;
    assert.ok(Number.isSafeInteger(digest.coverage.attentionThrough) && digest.coverage.attentionThrough > since,
      `page ${page}: the continuation advances (through ${digest.coverage.attentionThrough} > since ${since})`);
    since = digest.coverage.attentionThrough;
  }
  assert.equal(digest.coverage.attentionIncomplete, undefined, 'paging reaches a fully listed window');
  assert.deepEqual([...new Set(seen)].sort(), Array.from({ length: 10 }, (_, i) => `reply-${i + 1}`).sort(),
    'every reply is listed on some page — none is silently dropped');
});

test('digest overflow: a fully listed window keeps the pre-marker shape', t => {
  const { store, maya, roomId, reply } = setup(t, 'digest-overflow-complete');
  reply(1);
  reply(2);
  const digest = store.roomDigest(maya.secret, roomId, { since: 0 });
  assert.deepEqual(digest.attention.map(a => a.id), ['reply-1', 'reply-2']);
  assert.equal(digest.coverage.attentionTotal, 2);
  assert.equal(digest.coverage.attentionIncomplete, undefined);
  assert.equal(digest.coverage.attentionThrough, undefined);
  assert.equal(digest.followUps.attention, undefined);
});

const builderBase = {
  roomId: 'r', viewerId: 'v', since: 0, through: 100, now: 0,
  context: { context_version: 'a'.repeat(64), roster: [], focusWork: [], decisions: [], locks: [], omitted: [] },
  byType: { 'message.posted': 8 }, workChanged: [], workChangedTotal: 0,
  messages: [], decisions: [], actionable: { total: 0, byKind: {} }
};
const item = (seq, kind = 'reply') => ({ kind, seq, id: `item-${seq}`, summary: `s${seq}` });

test('digest overflow (builder): the section cap alone marks the listing incomplete', () => {
  const attention = Array.from({ length: 8 }, (_, i) => item(i + 1));
  const digest = buildRoomDigest({ ...builderBase, attention, attentionCoverage: { through: 100, complete: true } });
  assert.equal(digest.attention.length, 5);
  assert.equal(digest.coverage.attentionTotal, 8);
  assert.equal(digest.coverage.attentionIncomplete, true);
  assert.equal(digest.coverage.attentionThrough, 5, 'complete through the last listed row');
  assert.equal(digest.followUps.attention, 'GET /api/rooms/r/digest?since=5');
  const whole = buildRoomDigest({ ...builderBase, attention: attention.slice(0, 5), attentionCoverage: { through: 100, complete: true } });
  assert.equal(whole.coverage.attentionIncomplete, undefined, 'at the cap exactly, nothing is unlisted');
  assert.equal(whole.followUps.attention, undefined);
});

test('digest overflow (builder): adversarial — missing coverage ground, unknown kind, shared sequence group', () => {
  // Read-error shape: the slice reports incomplete but its ground is
  // missing (undefined). The marker must still fire and the
  // continuation must fall back to the window start, never throw.
  const noGround = buildRoomDigest({
    ...builderBase, attention: [item(3)],
    attentionCoverage: { complete: false }
  });
  assert.equal(noGround.coverage.attentionIncomplete, true);
  assert.equal(noGround.coverage.attentionThrough, 0, 'missing ground falls back to since');
  assert.equal(noGround.followUps.attention, 'GET /api/rooms/r/digest?since=0');

  // Unknown value: an unrecognised kind and absent coverage input do
  // not suppress the cap marker; the kind rides through untouched.
  const unknown = buildRoomDigest({
    ...builderBase,
    attention: Array.from({ length: 6 }, (_, i) => item(i + 1, i === 0 ? 'some_future_kind' : 'reply')),
    attentionCoverage: null
  });
  assert.equal(unknown.coverage.attentionIncomplete, true);
  assert.equal(unknown.attention[0].kind, 'some_future_kind');

  // One bad row shape: two items share a sequence (one event, two
  // kinds). The cap splits the group — the listing is complete only
  // through the sequence BEFORE the group, so the continuation
  // re-lists the group in full instead of skipping its second half.
  const shared = buildRoomDigest({
    ...builderBase,
    attention: [item(1), item(2), item(3), item(4), item(5, 'reply'), item(5, 'mention')],
    attentionCoverage: { through: 100, complete: true }
  });
  assert.equal(shared.coverage.attentionIncomplete, true);
  assert.equal(shared.coverage.attentionThrough, 4,
    'a sequence group is advanced past only when returned in full');
  assert.equal(shared.followUps.attention, 'GET /api/rooms/r/digest?since=4');
});
