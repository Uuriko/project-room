// room_since (RR-D1, RS design): cross-room, identity-scoped, enumerative
// delta read. A refresh-class caller passes back the cursor from the
// previous call and gets only what changed — asks, messages, claim changes
// and decisions as fields — instead of a whole-room payload.
// Contract pinned here (RS DESIGN §1/§5, tests T1-T6, T8, T9):
// - omitted since = bootstrap: empty buckets, cursor pinned at room heads
// - since = 0 = genesis enumeration
// - pure delta: re-polling a returned cursor is quiet and byte-stable
// - journal buckets paginate (25/room, 100/bucket), never shed
// - ahead watermarks clamp (never 409); malformed cursors 422
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectRoomSince } from '../server/room-since.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const WRITER = ['steer', 'accept_work', 'complete_work', 'verify'];

function setup(t, roomId = 'since-room') {
  const store = new RoomStore(':memory:', { now: () => Date.parse('2026-10-05T00:00:00Z') });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  rooms.create(owner.secret, { roomId, title: roomId, purpose: 'Delta read', kind: 'personal' });
  for (const identity of [ada, bob]) {
    linkWithProof(store, owner.secret, roomId, identity, { displayName: identity === ada ? 'Ada' : 'Bob', permissions: WRITER });
  }
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const memberOf = identity => store.db.prepare('SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?')
    .get(identity.identityId, roomId).m;
  const insertEvent = (id, type, data, actorId = 'owner') => {
    const head = store.room(roomId).sequence;
    store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)")
      .run(roomId, head + 1, id, JSON.stringify({ id, type, actorId, roomId, at: new Date().toISOString(), data }));
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(head + 1, roomId);
    return head + 1;
  };
  return { store, rooms, owner, ada, bob, roomId, memberOf, insertEvent };
}

test('T1 bootstrap: omitted since returns empty buckets and a head-pinned cursor; genesis in a chatter-only room advances watermarks', t => {
  const { store, ada, bob, roomId } = setup(t);
  store.command(bob.secret, roomId, { id: 'chat-1', type: 'message.posted', data: { messageId: 'chat-1', body: 'Ordinary chatter for someone else' } });
  const boot = collectRoomSince(store, ada.secret, {});
  assert.equal(boot.bootstrapped, true);
  assert.deepEqual(boot.asks, []);
  assert.deepEqual(boot.messages, []);
  assert.deepEqual(boot.claims, []);
  assert.deepEqual(boot.decisions, []);
  assert.equal(boot.hasMore, false);
  const head = store.room(roomId).sequence;
  assert.equal(boot.cursor.decisions[roomId], head);
  assert.equal(boot.cursor.claims[roomId], head);

  const genesis = collectRoomSince(store, ada.secret, { since: 0 });
  assert.deepEqual(genesis.asks, []);
  assert.deepEqual(genesis.messages, []);
  assert.deepEqual(genesis.decisions, []);
  assert.equal(genesis.coverage.find(row => row.roomId === roomId).decisionsTotal, 0);
  assert.equal(genesis.cursor.decisions[roomId], head, 'complete window advances the watermark to the head');
});

test('T2 mid-stream: one poll returns exactly the new ask, message, claim change and decision, in the right buckets', t => {
  const { store, ada, bob, roomId, memberOf, insertEvent } = setup(t);
  const adaId = memberOf(ada);
  let claim = claimWork(createWork({ id: 'claim-1', title: 'Delta claim' }, { now: Date.parse('2026-10-05T00:00:00Z'), agentId: adaId }), adaId, { now: Date.parse('2026-10-05T00:00:00Z') });
  claim = { ...claim, pullRequest: { url: 'https://github.com/Uuriko/project-room/pull/4242' } };
  store.workClaims.set(roomId, claim);

  const boot = collectRoomSince(store, ada.secret, {});
  store.command(bob.secret, roomId, { id: 'dm-1', type: 'message.posted', data: { messageId: 'dm-1', body: 'A direct word for Ada', toMemberId: ada.identityId } });
  store.command(bob.secret, roomId, { id: 'ask-1', type: 'message.posted', data: { messageId: 'ask-1', body: 'Please respond to this ask', toMemberId: ada.identityId, requestKind: 'reply' } });
  insertEvent('dec-1', 'decision.recorded', { statement: 'We ship the delta read first', sourceMessageId: 'dm-1' });
  insertEvent('wc-1', 'work_claim.updated', { workClaim: 'claim-1', action: 'state_changed', claimState: 'in_progress', title: 'Delta claim' });

  const page = collectRoomSince(store, ada.secret, { since: boot.cursor });
  assert.deepEqual(page.asks.map(row => row.id), ['ask-1']);
  assert.equal(page.asks[0].kind, 'direct_ask');
  assert.ok(page.messages.some(row => row.id === 'dm-1' && row.kind === 'dm'), 'the DM lands in messages');
  assert.deepEqual(page.decisions.map(row => row.eventId), ['dec-1']);
  assert.equal(page.decisions[0].statement, 'We ship the delta read first');
  assert.equal(page.decisions[0].sourceMessageId, 'dm-1');
  assert.deepEqual(page.claims.map(row => row.id), ['claim-1']);
  assert.equal(page.claims[0].state, 'in_progress', 'claim state comes from the latest journal row in the window');
  assert.equal(page.claims[0].pullRequest, 'https://github.com/Uuriko/project-room/pull/4242', 'claim row carries the current board PR url');
  const coverage = page.coverage.find(row => row.roomId === roomId);
  assert.equal(coverage.decisionsTotal, 1);
  assert.equal(coverage.claimsChangedTotal, 1);
});

test('T3 idempotent re-poll: original cursor replays identically, returned cursor is quiet and stable', t => {
  const { store, ada, bob, roomId, insertEvent } = setup(t);
  const boot = collectRoomSince(store, ada.secret, {});
  store.command(bob.secret, roomId, { id: 'dm-1', type: 'message.posted', data: { messageId: 'dm-1', body: 'Ping for Ada', toMemberId: ada.identityId } });
  insertEvent('dec-1', 'decision.recorded', { statement: 'Decided once' });
  const first = collectRoomSince(store, ada.secret, { since: boot.cursor });
  const replay = collectRoomSince(store, ada.secret, { since: boot.cursor });
  assert.deepEqual(replay.decisions, first.decisions);
  assert.deepEqual(replay.messages, first.messages);
  const quiet = collectRoomSince(store, ada.secret, { since: first.cursor });
  assert.deepEqual(quiet.asks, []);
  assert.deepEqual(quiet.messages, []);
  assert.deepEqual(quiet.claims, []);
  assert.deepEqual(quiet.decisions, []);
  assert.equal(quiet.hasMore, false);
  assert.deepEqual(quiet.cursor, first.cursor, 'a quiet re-poll returns a byte-identical cursor');
});

test('T4 continuation: 30 decisions paginate 25 + 5 with no overlap and a monotone watermark', t => {
  const { store, ada, roomId, insertEvent } = setup(t);
  const boot = collectRoomSince(store, ada.secret, {});
  for (let i = 0; i < 30; i++) insertEvent(`dec-${i}`, 'decision.recorded', { statement: `Decision ${i}` });
  const first = collectRoomSince(store, ada.secret, { since: boot.cursor });
  assert.equal(first.decisions.length, 25);
  assert.equal(first.hasMore, true);
  const second = collectRoomSince(store, ada.secret, { since: first.cursor });
  assert.equal(second.decisions.length, 5);
  assert.equal(second.hasMore, false);
  const seqs = [...first.decisions, ...second.decisions].map(row => row.seq);
  assert.equal(new Set(seqs).size, 30, 'union is every decision exactly once');
  assert.ok(second.cursor.decisions[roomId] > first.cursor.decisions[roomId], 'watermark is monotone');
});

test('T5 clamped cursor: a watermark above the head clamps without a 409 and the next event still arrives', t => {
  const { store, ada, roomId, insertEvent } = setup(t);
  const boot = collectRoomSince(store, ada.secret, {});
  const ahead = JSON.parse(JSON.stringify(boot.cursor));
  ahead.decisions[roomId] = 999999;
  ahead.claims[roomId] = 999999;
  const page = collectRoomSince(store, ada.secret, { since: ahead });
  assert.deepEqual(page.clampedRooms, [roomId]);
  assert.deepEqual(page.decisions, []);
  insertEvent('dec-late', 'decision.recorded', { statement: 'After the clamp' });
  const next = collectRoomSince(store, ada.secret, { since: page.cursor });
  assert.deepEqual(next.decisions.map(row => row.eventId), ['dec-late']);
});

test('T6 handled-ask honesty: an ask answered between polls never appears, a decision in the same window does', t => {
  const { store, ada, bob, roomId, memberOf, insertEvent } = setup(t);
  const boot = collectRoomSince(store, ada.secret, {});
  const asked = store.command(bob.secret, roomId, { id: 'ask-1', type: 'message.posted', data: { messageId: 'ask-1', body: 'Please respond', toMemberId: ada.identityId, requestKind: 'reply' } });
  // Ada answers the ask before polling, through the formal response path:
  // needs-me retires handled asks.
  store.command(ada.secret, roomId, { id: 'reply-1', type: 'message.posted', data: { messageId: 'reply-1', body: 'Answered', responseToRequestId: 'ask-1', expectedRequestRevision: 0, responseOutcome: 'answered', contextEventId: asked.event.id, contextSequence: asked.sequence, replyToId: 'ask-1', toMemberId: memberOf(bob), workItemId: null } });
  insertEvent('dec-1', 'decision.recorded', { statement: 'Still recorded' });
  const page = collectRoomSince(store, ada.secret, { since: boot.cursor });
  assert.deepEqual(page.asks, [], 'handled asks stay retired (inherited needs-me semantics)');
  assert.deepEqual(page.decisions.map(row => row.eventId), ['dec-1'], 'journal-complete buckets have no handled filter');
});

test('T8 auth: an unknown identity secret is refused 401 unauthenticated', t => {
  const { store } = setup(t);
  assert.throws(() => collectRoomSince(store, 'pri_not-a-real-secret', {}),
    error => error.status === 401 && error.code === 'unauthenticated');
});

test('T9 malformed cursors are 422 invalid_cursor', t => {
  const { store, ada, roomId } = setup(t);
  const bad = [
    { v: 2, needsMe: {}, decisions: {}, claims: {} },
    { v: 1, needsMe: {}, decisions: { [roomId]: -1 }, claims: {} },
    { v: 1, needsMe: {}, decisions: {}, claims: {}, bogus: 1 },
    { v: 1, needsMe: {}, decisions: { [roomId]: 1.5 }, claims: {} },
    'not-a-cursor-object'
  ];
  for (const since of bad) {
    assert.throws(() => collectRoomSince(store, ada.secret, { since }),
      error => error.status === 422 && error.code === 'invalid_cursor', `cursor ${JSON.stringify(since)} must 422`);
  }
});
