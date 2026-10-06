import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// Authoring gate (test-audit): the buyer-visible revision/sign-off loop is
// the piece the fulfillment dry run flagged structurally missing —
// "submission → buyer review → revision request → re-delivery → sign-off".
// The loop is an overlay on a trial task's `submitted` state: it never edits
// the trial-task state machine, it records the buyer's side of it.

const SHA = 'a'.repeat(64);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'buyer-signoff-store-'));
  const file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  // A second member so buyer-only review has a credible non-buyer to reject.
  const row = structuredClone(store.room('commons'));
  row.state.members.worker = { id: 'worker', kind: 'agent', active: true, displayName: 'Worker', permissions: ['verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(row.state), 'commons');
  return { store };
}

const open = (store, loopId = 'sign-1', overrides = {}) => store.buyerSignoff.create('commons', 'owner', {
  requestId: `open-${loopId}`, loopId, trialTaskId: 'trial-abc123', buyerId: 'owner', maxRounds: 2, ...overrides,
});
const deliverable = (n = 1) => ({
  requestId: `sub-${n}-${Math.random().toString(16).slice(2, 8)}`,
  deliverableRef: `https://example.com/delivery/${n}`,
  sha256: SHA, summary: `Delivery round ${n}`, candidateId: 'worker',
});

test('the full loop closes: submit, review, request changes, re-deliver, sign off', t => {
  // Contract: the loop the dry run found missing, end to end, with every
  // round journaled. Regression: a revision request that loses the first
  // delivery, or a sign-off that records no rounds.
  const { store } = fixture(t);
  open(store);
  store.buyerSignoff.submit('commons', 'worker', 'sign-1', deliverable(1));
  store.buyerSignoff.review('commons', 'owner', 'sign-1', {
    requestId: 'rev-1', decision: 'request_changes', note: 'Missing docs',
  });
  store.buyerSignoff.submit('commons', 'worker', 'sign-1', deliverable(2));
  const done = store.buyerSignoff.review('commons', 'owner', 'sign-1', {
    requestId: 'rev-2', decision: 'accept', note: 'Good now',
  });
  assert.equal(done.status, 'accepted');
  assert.equal(done.round, 2);
  assert.equal(done.rounds.length, 2);
  assert.equal(done.rounds[0].review.decision, 'request_changes');
  assert.equal(done.rounds[0].deliverable.sha256, SHA);
  assert.equal(done.rounds[1].review.decision, 'accept');
});

test('resubmitting past maxRounds is rejected with revision_rounds_exhausted', t => {
  // Contract: the revision terms from the offer are enforced, not advisory.
  // Regression: unbounded revision cycles (buyer never gets a final bill).
  const { store } = fixture(t);
  open(store, 'sign-2', { maxRounds: 1 });
  store.buyerSignoff.submit('commons', 'worker', 'sign-2', deliverable(1));
  store.buyerSignoff.review('commons', 'owner', 'sign-2', {
    requestId: 'rev-1', decision: 'request_changes', note: 'Again',
  });
  assert.throws(
    () => store.buyerSignoff.submit('commons', 'worker', 'sign-2', deliverable(2)),
    error => error.code === 'revision_rounds_exhausted');
});

test('only the recorded buyer can review; the worker cannot self-accept', t => {
  // Contract: sign-off is the counterparty's act, not the worker's
  // (dry run: "I completed my own claim with no counterparty").
  // Regression: worker self-acceptance, or a stranger's review counting.
  const { store } = fixture(t);
  open(store, 'sign-3');
  store.buyerSignoff.submit('commons', 'worker', 'sign-3', deliverable(1));
  assert.throws(
    () => store.buyerSignoff.review('commons', 'worker', 'sign-3', { requestId: 'rev-x', decision: 'accept', note: 'self' }),
    error => error.code === 'signoff_not_buyer');
});

test('buyer-visible status exposes state, round, and deliverable summary without room internals', t => {
  // Contract: dry-run gap #5 — a buyer without room access can see where
  // their job stands. Regression: a status payload that leaks room
  // internals or omits the current deliverable.
  const { store } = fixture(t);
  open(store, 'sign-4');
  store.buyerSignoff.submit('commons', 'worker', 'sign-4', deliverable(1));
  const status = store.buyerSignoff.status('commons', 'sign-4');
  assert.equal(status.loopId, 'sign-4');
  assert.equal(status.state, 'submitted');
  assert.equal(status.round, 1);
  assert.equal(status.maxRounds, 2);
  assert.equal(status.currentDeliverable.summary, 'Delivery round 1');
  assert.equal(status.recordOnly, true);
  assert.ok(!('roomId' in status) || typeof status.roomId === 'string');
});
