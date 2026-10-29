// Negative controls for the two F-B10-1-family legs that had no standing
// tests (RESILIENCE AUDIT row 12; MEASURE-IMPROVE register rows 45 and 47).
// F-B10-1's write gate and bootstrap disclosure are covered by
// private-reply-boundary.test.js and bootstrap-private-requests.test.js.
// These tests pin the sibling boundaries from the same seam, replaying the
// executed UT-MIXED specimens at store level:
//
// (a) F-S6c-3 (S3, register #45): existence privacy. In production, a
//     bystander's visible message horizon was 13 while their needs-me
//     cursor and list-requests evaluatedThrough read 15, so the member
//     could compute that exactly two hidden events existed; presence
//     lastSeenAt equalled the private event's exact timestamp. S6c's gap
//     spanned a work proposal plus the private request; here the private
//     request is the ONLY hidden event after the seed, so any gap is
//     attributable to it alone. The container/proposal leg is (b).
// (b) F-S8a-5 (S3, register #47; also S6a O1): a private conversation's
//     work-item metadata — title and definition-of-done announcing that a
//     private confirmation happened — is board/list visible to
//     non-participants. The board/list path (listWork in
//     server/mcp-room-profile.mjs) serialises title + definitionOfDone
//     straight from the work snapshot, so the snapshot is the surface
//     asserted here.
//
// Boundary asserted: a non-participant's sequence-bearing surfaces stop
// at their visible horizon, their presence view of another member does
// not track that member's hidden events, and a work item carrying a
// private tracked request exposes no title/definition-of-done to
// non-participants. Participants keep full access throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { readRoomSnapshot } from '../server/snapshot-window.mjs';
import { buildReplyCommand } from '../client/reply-actions.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

const T_SEED = 1_700_000_060_000;
const T_PRIV = 1_700_000_120_000;
const iso = ms => new Date(ms).toISOString();

function world(t) {
  let now = 1_700_000_000_000;
  const store = new RoomStore(':memory:', { now: () => now });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const alice = store.identities.create('Alice');
  const bob = store.identities.create('Bob');
  const carol = store.identities.create('Carol');
  const roomId = 'existence-room';
  rooms.create(alice.secret, { roomId, title: 'existence', purpose: 'x', kind: 'personal' });
  linkWithProof(store, alice.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  linkWithProof(store, alice.secret, roomId, carol, { displayName: 'Carol', permissions: [] });
  const memberId = name => Object.values(store.room(roomId).state.members)
    .find(m => (m.displayName ?? m.name) === name).id;
  return {
    store, alice, bob, carol, roomId,
    aliceId: memberId('Alice'), bobId: memberId('Bob'), carolId: memberId('Carol'),
    setNow: ms => { now = ms; }
  };
}

// Alice posts one public seed, then (later, at T_PRIV) opens a private
// tracked request to Bob. Returns the two event sequences and the private
// message id. Carol is a room member who is party to neither act's
// private half.
function seedThenPrivateAsk(w, { workItemId } = {}) {
  w.setNow(T_SEED);
  const seed = w.store.command(w.alice.secret, w.roomId, {
    id: 'seed', type: 'message.posted', data: { messageId: 'seed', body: 'Public seed' }
  });
  w.setNow(T_PRIV);
  const ask = w.store.command(w.alice.secret, w.roomId, buildReplyCommand(
    { roomId: w.roomId, memberId: w.aliceId }, 'room_request_reply',
    { requestId: 'priv-ask', toMemberId: w.bobId, body: 'PRIV-BODY-MARKER', ...(workItemId ? { workItemId } : {}) }
  ));
  return { visibleHorizon: seed.sequence, privateSequence: ask.sequence, privateMessageId: ask.event.data.messageId };
}

test('content privacy holds: the bystander cannot read the private request, participants can', t => {
  const w = world(t), { privateMessageId } = seedThenPrivateAsk(w);
  const carolView = readRoomSnapshot(w.store, w.carol.secret, w.roomId, null);
  assert.equal(carolView.state.messages.some(m => m.id === privateMessageId), false);
  assert.equal(Object.hasOwn(carolView.state.replyRequests, privateMessageId), false);
  assert.throws(() => w.store.replyRequests.selected(w.carol.secret, w.roomId, privateMessageId), { status: 404 });
  const bobList = w.store.replyRequests.list(w.bob.secret, w.roomId, { direction: 'incoming', status: 'open' });
  assert.equal(bobList.requests.length, 1);
  assert.equal(bobList.requests[0].id, privateMessageId);
});

test('existence: reply-list evaluatedThrough stops at the non-participant visible horizon', t => {
  const w = world(t), { visibleHorizon, privateSequence } = seedThenPrivateAsk(w);
  assert.ok(privateSequence > visibleHorizon, 'construction: a hidden event exists past the horizon');
  const list = w.store.replyRequests.list(w.carol.secret, w.roomId, { direction: 'incoming', status: 'open' });
  // The boundary: evaluatedThrough presented to Carol must not count
  // events she cannot see. F-S6c-3: hers read 15 against a horizon of 13.
  assert.equal(list.evaluatedThrough, visibleHorizon,
    `evaluatedThrough ${list.evaluatedThrough} reveals hidden events past Carol's visible horizon ${visibleHorizon}`);
});

test('existence: the needs-me cursor stops at the non-participant visible horizon', t => {
  const w = world(t), { visibleHorizon, privateSequence } = seedThenPrivateAsk(w);
  assert.ok(privateSequence > visibleHorizon, 'construction: a hidden event exists past the horizon');
  const cursor = collectNeedsMe(w.store, w.carol.secret, {}).cursor.rooms[w.roomId];
  assert.equal(cursor, visibleHorizon,
    `needs-me cursor ${cursor} reveals hidden events past Carol's visible horizon ${visibleHorizon}`);
});

test('existence: presence for the requester does not track their hidden event', t => {
  const w = world(t), { privateMessageId } = seedThenPrivateAsk(w);
  const canonical = w.store.room(w.roomId).state.messages.find(m => m.id === privateMessageId);
  assert.equal(canonical.createdAt, iso(T_PRIV), 'construction: the private event carries the T_PRIV stamp');
  const row = w.store.presenceMembers(w.roomId, []).find(r => r.memberId === w.aliceId);
  // Alice's last Carol-visible act is the seed at T_SEED. Her presence
  // stamp must not advance to the private request's timestamp: in
  // production it equalled it exactly (F-S6c-3; X2: last-write stamp,
  // 6/6 writes).
  assert.notEqual(row.lastSeenAt, canonical.createdAt,
    'presence lastSeenAt equals the hidden event timestamp — a bystander can time the private act');
  assert.equal(row.lastSeenAt, iso(T_SEED),
    `presence lastSeenAt ${row.lastSeenAt} should stop at Alice's last visible act ${iso(T_SEED)}`);
});

test('metadata: a work item carrying a private request exposes no title or definition-of-done to non-participants', t => {
  const w = world(t);
  w.setNow(T_SEED);
  w.store.command(w.alice.secret, w.roomId, { id: 'propose', type: 'work.proposed', data: {
    workItemId: 'priv-container', title: 'PRIV-TITLE-MARKER', definitionOfDone: 'PRIV-DOD-MARKER',
    accountableMemberId: w.bobId, mode: 'read'
  } });
  seedThenPrivateAsk(w, { workItemId: 'priv-container' });
  // Participant control: Bob, the request's recipient and the item's
  // accountable member, still reads the item's metadata.
  const bobWork = w.store.snapshot(w.bob.secret, w.roomId, null, 'work');
  assert.equal(bobWork.state.workItems['priv-container']?.title, 'PRIV-TITLE-MARKER');
  // The exact read listWork serialises from, taken as the non-participant:
  const carolWork = w.store.snapshot(w.carol.secret, w.roomId, null, 'work');
  const exposed = JSON.stringify(carolWork.state.workItems ?? {});
  assert.equal(exposed.includes('PRIV-TITLE-MARKER'), false,
    'non-participant board/list read carries the private item title (F-S8a-5)');
  assert.equal(exposed.includes('PRIV-DOD-MARKER'), false,
    'non-participant board/list read carries the private item definition-of-done (F-S8a-5)');
});

// --- Critic follow-up on #5355 (BLOCKING, comment 6510915135): the work
// snapshot above was the only redacted serialiser. The same private
// work-item state also leaves through the full snapshot / bootstrap,
// through room search, and roomContext carried the same horizon leak
// as the reply list. The tests below pin those reads; participants
// keep full access on each of them.

function seedPrivateWorkItem(w) {
  w.setNow(T_SEED);
  w.store.command(w.alice.secret, w.roomId, { id: 'propose', type: 'work.proposed', data: {
    workItemId: 'priv-container', title: 'PRIV-TITLE-MARKER', definitionOfDone: 'PRIV-DOD-MARKER',
    accountableMemberId: w.bobId, mode: 'read'
  } });
  return seedThenPrivateAsk(w, { workItemId: 'priv-container' });
}

test('metadata: the full snapshot exposes no title or definition-of-done to non-participants', t => {
  const w = world(t);
  seedPrivateWorkItem(w);
  const bobView = readRoomSnapshot(w.store, w.bob.secret, w.roomId, null);
  assert.equal(bobView.state.workItems['priv-container']?.title, 'PRIV-TITLE-MARKER');
  assert.equal(bobView.state.workItems['priv-container']?.definitionOfDone, 'PRIV-DOD-MARKER');
  const carolView = readRoomSnapshot(w.store, w.carol.secret, w.roomId, null);
  assert.equal(carolView.state.workItems['priv-container']?.title, null);
  assert.equal(carolView.state.workItems['priv-container']?.definitionOfDone, null);
  const exposed = JSON.stringify(carolView.state.workItems ?? {}) + JSON.stringify(carolView.state.eventLog ?? []);
  assert.equal(exposed.includes('PRIV-TITLE-MARKER'), false,
    'non-participant full-snapshot read carries the private item title (F-S8a-5)');
  assert.equal(exposed.includes('PRIV-DOD-MARKER'), false,
    'non-participant full-snapshot read carries the private item definition-of-done (F-S8a-5)');
});

test('metadata: room bootstrap exposes no title or definition-of-done to non-participants', async t => {
  const { buildRoomBootstrap } = await import('../server/room-bootstrap.mjs');
  const w = world(t);
  seedPrivateWorkItem(w);
  const bobBoot = buildRoomBootstrap(w.store, w.bob.secret, w.roomId, null);
  assert.equal(bobBoot.snapshot.state.workItems['priv-container']?.title, 'PRIV-TITLE-MARKER');
  assert.equal(bobBoot.snapshot.state.workItems['priv-container']?.definitionOfDone, 'PRIV-DOD-MARKER');
  const carolBoot = buildRoomBootstrap(w.store, w.carol.secret, w.roomId, null);
  assert.equal(carolBoot.snapshot.state.workItems['priv-container']?.title, null);
  assert.equal(carolBoot.snapshot.state.workItems['priv-container']?.definitionOfDone, null);
  const exposed = JSON.stringify(carolBoot);
  assert.equal(exposed.includes('PRIV-TITLE-MARKER'), false,
    'non-participant bootstrap carries the private item title (F-S8a-5)');
  assert.equal(exposed.includes('PRIV-DOD-MARKER'), false,
    'non-participant bootstrap carries the private item definition-of-done (F-S8a-5)');
});

test('metadata: room search neither matches on nor returns a private item title or definition-of-done to non-participants', t => {
  const w = world(t);
  seedPrivateWorkItem(w);
  // Participant control: Bob finds the item by its definition-of-done
  // and by its title, and receives the title.
  const bobDod = w.store.search(w.bob.secret, w.roomId, 'PRIV-DOD-MARKER', 'work');
  assert.equal(bobDod.total, 1);
  assert.equal(bobDod.workItems[0]?.id, 'priv-container');
  assert.equal(bobDod.workItems[0]?.title, 'PRIV-TITLE-MARKER');
  const bobTitle = w.store.search(w.bob.secret, w.roomId, 'PRIV-TITLE-MARKER', 'all');
  assert.equal(bobTitle.workItems.some(item => item.id === 'priv-container'), true);
  // Non-participant: searching the private text is not a confirm-oracle
  // and returns no title, for either kind.
  for (const kind of ['work', 'all']) {
    const carolDod = w.store.search(w.carol.secret, w.roomId, 'PRIV-DOD-MARKER', kind);
    assert.equal(carolDod.total, 0, `non-participant search kind=${kind} matched the private definition-of-done`);
    assert.equal(carolDod.workItems.length, 0);
    const carolTitle = w.store.search(w.carol.secret, w.roomId, 'PRIV-TITLE-MARKER', kind);
    assert.equal(carolTitle.workItems.some(item => item.id === 'priv-container'), false,
      `non-participant search kind=${kind} returned the private item on its title`);
    // The result's workItems/messages (not its echoed query field)
    // must carry neither private marker.
    assert.equal(JSON.stringify(carolTitle.workItems).includes('PRIV-TITLE-MARKER'), false);
    assert.equal(JSON.stringify(carolDod.workItems).includes('PRIV-TITLE-MARKER'), false);
  }
});

test('existence: roomContext evaluatedThrough stops at the non-participant visible horizon', t => {
  const w = world(t), { visibleHorizon, privateSequence } = seedThenPrivateAsk(w);
  assert.ok(privateSequence > visibleHorizon, 'construction: a hidden event exists past the horizon');
  const carolContext = w.store.roomContext(w.carol.secret, w.roomId, {});
  assert.equal(carolContext.evaluatedThrough, visibleHorizon,
    `roomContext evaluatedThrough ${carolContext.evaluatedThrough} reveals hidden events past Carol's visible horizon ${visibleHorizon}`);
  // Participant legs are unchanged: sender and recipient reach the
  // private event's sequence.
  assert.equal(w.store.roomContext(w.bob.secret, w.roomId, {}).evaluatedThrough, privateSequence);
  assert.equal(w.store.roomContext(w.alice.secret, w.roomId, {}).evaluatedThrough, privateSequence);
});
