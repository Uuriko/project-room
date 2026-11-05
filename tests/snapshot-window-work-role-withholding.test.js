import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoomSnapshot } from '../server/snapshot-window.mjs';

// Site 6 (the legacy full-read serialiser in readRoomSnapshot) recomputes the
// private-work withholding predicate locally. It must apply the same
// predicate as every other read site (store work/full/search views,
// orientation, orient, current-room repository): a work item's title and
// definitionOfDone are withheld from a viewer who is not a party to any
// reply request on the item, EXCEPT a member the item itself names in a
// work role (proposer, accountable, verifier, human decision maker, claim
// holder) — a private request on the item must not lock them out of it.
//
// The store is stubbed at the snapshot boundary (the same fidelity as the
// executed drift probe): snapshot() emits the item already conforming-
// filtered or unfiltered; the serialiser's own decision is what is tested.
// The db stub answers no current-room head row, so the real isCurrentRoom()
// routes to the legacy path under test.

const ITEM = {
  id: 'work-1', title: 'synthetic-title', definitionOfDone: 'synthetic-dod',
  proposedById: 'proposer-1', accountableMemberId: 'accountable-1',
  verifierMemberId: 'verifier-1', humanDecisionMakerId: 'decider-1',
  claim: { holderId: 'holder-1' },
};
// The request is between two members who hold no role on the item.
const REQUESTS = {
  'req-1': { id: 'req-1', workItemId: 'work-1', requesterId: 'requester-1', recipientId: 'recipient-1', status: 'open', createdAt: '2026-01-01T00:00:00.000Z' },
};
const PROPOSED_EVENT = { type: 'work.proposed', data: { workItemId: 'work-1', title: 'synthetic-title', definitionOfDone: 'synthetic-dod' } };

function storeFor(viewerId, { requests = REQUESTS, items = { 'work-1': ITEM }, eventLog = [PROPOSED_EVENT] } = {}) {
  return {
    db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
    historyFloor: () => null,
    snapshot: () => ({
      viewerId, sequence: 7,
      state: {
        room: { id: 'room-1', ownerId: 'room-owner-1' },
        members: {}, messages: [], pins: [],
        replyRequests: structuredClone(requests),
        workItems: structuredClone(items),
        eventLog: structuredClone(eventLog),
      },
    }),
  };
}
const VISIBILITY = { dmMessageVisible: () => true, roomEventVisible: () => true, peerContext: { memberId: null, identityId: null, isOwner: false } };
const read = (viewerId, opts) => readRoomSnapshot(storeFor(viewerId, opts), 'tok', 'room-1', null, { view: 'full', windowed: false, visibility: VISIBILITY });

test('work role holders who are not request parties keep the item title and definition', () => {
  for (const viewer of ['verifier-1', 'accountable-1', 'decider-1', 'holder-1', 'proposer-1']) {
    const snap = read(viewer);
    assert.equal(snap.state.workItems['work-1'].title, 'synthetic-title', viewer);
    assert.equal(snap.state.workItems['work-1'].definitionOfDone, 'synthetic-dod', viewer);
    assert.equal(snap.state.eventLog[0].data.title, 'synthetic-title', `${viewer} event log`);
    assert.equal(snap.state.eventLog[0].data.definitionOfDone, 'synthetic-dod', `${viewer} event log`);
  }
});

test('non-party members without a work role still get the item withheld', () => {
  for (const viewer of ['member-plain', 'room-owner-1', 'unknown-viewer']) {
    const snap = read(viewer);
    assert.equal(snap.state.workItems['work-1'].title, null, viewer);
    assert.equal(snap.state.workItems['work-1'].definitionOfDone, null, viewer);
    assert.equal(snap.state.eventLog[0].data.title, null, `${viewer} event log`);
    assert.equal(snap.state.eventLog[0].data.definitionOfDone, null, `${viewer} event log`);
  }
});

test('request parties keep the item, and an item with no requests is visible to anyone', () => {
  for (const viewer of ['requester-1', 'recipient-1']) {
    assert.equal(read(viewer).state.workItems['work-1'].title, 'synthetic-title', viewer);
  }
  assert.equal(read('member-plain', { requests: {} }).state.workItems['work-1'].title, 'synthetic-title');
});

test('one bad row does not crash or widen the read', () => {
  const requests = {
    ...REQUESTS,
    'req-bad-1': { id: 'req-bad-1', requesterId: 'x', recipientId: 'y', status: 'open' }, // no workItemId: skipped by the recompute
  };
  // A ghost item: a request points at it but it is absent from workItems;
  // its event stays withheld for non-parties, exactly as before the cure.
  const eventLog = [...[PROPOSED_EVENT], { type: 'work.proposed', data: { workItemId: 'work-ghost', title: 'ghost-title', definitionOfDone: 'ghost-dod' } }];
  const ghostRequests = { ...requests, 'req-ghost': { id: 'req-ghost', workItemId: 'work-ghost', requesterId: 'requester-1', recipientId: 'recipient-1', status: 'open', createdAt: '2026-01-01T00:00:00.000Z' } };
  const snap = read('verifier-1', { requests: ghostRequests, eventLog });
  assert.equal(snap.state.workItems['work-1'].title, 'synthetic-title');
  assert.equal(snap.state.eventLog[1].data.title, null);
  const plain = read('member-plain', { requests: ghostRequests, eventLog });
  assert.equal(plain.state.eventLog[1].data.title, null);
});

test('an item with missing role fields withholds from non-parties without crashing', () => {
  const bare = { id: 'work-1', title: 'synthetic-title', definitionOfDone: 'synthetic-dod' };
  assert.equal(read('member-plain', { items: { 'work-1': bare } }).state.workItems['work-1'].title, null);
  assert.equal(read('requester-1', { items: { 'work-1': bare } }).state.workItems['work-1'].title, 'synthetic-title');
});
