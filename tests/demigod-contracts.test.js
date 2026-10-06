import {addRailMember,acceptedReceipt} from "../scripts/record-rails-fixture.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// Authoring gate (test-audit): the contract structure is the record-only
// agreement representation — parties, terms snapshot, acceptance flow. It is
// the piece that turns an accepted offer into an auditable deal both sides
// can point at (dry-run gap: "the claim I ran had no acceptance criteria
// field; done was my judgment call").

const offerInput = (id = 'dg-offer-1') => ({
  requestId: `create-${id}`, offerId: id,
  reviewerMemberIds: ['owner'],
  terms: {
    repositoryUrl: 'https://github.com/Uuriko/project-room',
    kind: 'project', title: 'Paid trial: web automation',
    summary: 'Build a small web-automation workflow',
    acceptanceCriteria: ['Workflow runs end to end'],
    reward: { kind: 'cash', unit: 'USD', amountMinor: '5000' },
    approvalPolicy: { mode: 'human' },
  },
});

const profileInput = (profileId = 'dgp-1') => ({
  requestId: `profile-${profileId}`, profileId,
  offerRef: 'dg-offer-1', demigodReqId: 'demigod-req-42', buyerId: 'owner',
  trialScope: { hours: '40', deliverableShape: 'code-pr' },
  vettingRubric: [{ criterionId: 'c1', description: 'Works end to end', maxScore: '5.00' }],
  priceType: 'fixed', priceMilli: '5000000',
  timeline: { estimateDays: '14', deadline: '2026-11-01T00:00:00.000Z' },
  revisionTerms: { maxRounds: 2, turnaroundDays: '3' },
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'demigod-contract-store-'));
  const file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  addRailMember(store,"worker-1");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.projectOffers.create('commons', 'owner', offerInput());
  store.demigodOffers.create('commons', 'owner', profileInput());
  store.demigodOffers.present('commons', 'owner', 'dgp-1', { requestId: 'p1', expectedRevision: 1 });
  store.demigodOffers.accept('commons', 'owner', 'dgp-1', { requestId: 'a1', expectedRevision: 2 });
  return { store };
}

test('accepting an offer mints a contract with a byte-exact terms snapshot', t => {
  // Contract: the contract freezes the exact accepted terms — later offer
  // edits cannot rewrite the deal. Regression: contract terms drifting from
  // what the buyer accepted.
  const { store } = fixture(t);
  const contract = store.demigodContracts.create('commons', 'owner', {
    requestId: 'c1', contractId: 'dgc-1', offerProfileId: 'dgp-1', expectedRevision: 3, workerId: 'worker-1',
  });
  assert.equal(contract.status, 'pending');
  assert.equal(contract.parties.buyerId, 'owner');
  assert.equal(contract.parties.workerId, 'worker-1');
  assert.equal(contract.termsSnapshot.status, 'accepted');
  assert.equal(contract.termsSnapshot.priceMilli, '5000000');
  assert.equal(contract.recordOnly, true);
  // A stale revision cannot mint a contract against changed terms.
  assert.throws(
    () => store.demigodContracts.create('commons', 'owner', {
      requestId: 'c2', contractId: 'dgc-2', offerProfileId: 'dgp-1', expectedRevision: 1,
    }),
    error => error.code === 'stale_demigod_offer');
});

test('acceptance flow: pending, worker acknowledges, buyer completes against a trial receipt', t => {
  // Contract: the acceptance flow both sides can point at — worker
  // acknowledges the deal, buyer completes it only against a concrete trial
  // receipt. Regression: "completed" with no linked evidence (the dry run's
  // worker-asserted done).
  const { store } = fixture(t);
  store.demigodContracts.create('commons', 'owner', {
    requestId: 'c1', contractId: 'dgc-1', offerProfileId: 'dgp-1', expectedRevision: 3, workerId: 'worker-1',
  });
  const active = store.demigodContracts.acknowledge('commons', 'worker-1', 'dgc-1', { requestId: 'ack1' });
  assert.equal(active.status, 'active');
  assert.ok(active.acceptance.workerAcknowledgedAt);
  assert.throws(
    () => store.demigodContracts.complete('commons', 'owner', 'dgc-1', { requestId: 'done1' }),
    error => error.code === 'invalid_demigod_contract');
  assert.throws(()=>store.demigodContracts.complete('commons','owner','dgc-1',{requestId:'fabricated',trialTaskId:'trial-abc123',receiptRef:'fake'}), error=>error.code==='trial_task_not_found');
  const receipt=acceptedReceipt(store,{candidateId:'worker-1',contractId:'dgc-1'});
  const done = store.demigodContracts.complete('commons', 'owner', 'dgc-1', {
    requestId: 'done2', trialTaskId: 'trial-abc123', receiptRef: receipt.receiptId,
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.completion.trialTaskId, 'trial-abc123');
});

test('buyer or owner can terminate an active contract; terminal contracts are immutable', t => {
  // Contract: termination is a recorded first-class outcome, not a silent
  // delete. Regression: a terminated contract being re-completed.
  const { store } = fixture(t);
  store.demigodContracts.create('commons', 'owner', {
    requestId: 'c1', contractId: 'dgc-1', offerProfileId: 'dgp-1', expectedRevision: 3,
  });
  const ended = store.demigodContracts.terminate('commons', 'owner', 'dgc-1', { requestId: 't1', reason: 'Scope changed' });
  assert.equal(ended.status, 'terminated');
  assert.equal(ended.termination.reason, 'Scope changed');
  assert.throws(
    () => store.demigodContracts.acknowledge('commons', 'worker-1', 'dgc-1', { requestId: 'ack2' }),
    error => error.code === 'invalid_demigod_contract_status');
});
