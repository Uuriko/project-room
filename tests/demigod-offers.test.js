import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// Authoring gate (test-audit): each test below names the observable contract
// it protects and the credible regression that makes it fail. The Demigod
// buyer-offer layer composes with the generic project-offers surface (not
// duplicating it): a profile anchors a Demigod buyer offer to a
// project_offers offer and adds the trial scope, rubric, price type,
// timeline, and revision terms the fulfillment dry run found missing.

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

const profileInput = (profileId = 'dgp-1', overrides = {}) => ({
  requestId: `profile-${profileId}`,
  profileId,
  offerRef: 'dg-offer-1',
  demigodReqId: 'demigod-req-42',
  buyerId: 'owner',
  trialScope: { hours: '40', deliverableShape: 'code-pr' },
  vettingRubric: [
    { criterionId: 'c1', description: 'Works end to end', maxScore: '5.00' },
    { criterionId: 'c2', description: 'Documented', maxScore: '5.00' },
  ],
  priceType: 'fixed',
  priceMilli: '5000000',
  timeline: { estimateDays: '14', deadline: '2026-11-01T00:00:00.000Z' },
  revisionTerms: { maxRounds: 2, turnaroundDays: '3' },
  ...overrides,
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'demigod-offer-store-'));
  const file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.projectOffers.create('commons', 'owner', offerInput());
  return { store };
}

test('profile anchors to an existing project offer and pins the rubric at creation', t => {
  // Contract: composition with the generic offer surface (offerRef must
  // resolve in-room) and an immutable rubric snapshot. Regression: a
  // dangling offerRef accepted, or later rubric edits rewriting history.
  const { store } = fixture(t);
  const saved = store.demigodOffers.create('commons', 'owner', profileInput());
  assert.equal(saved.status, 'draft');
  assert.equal(saved.offerRef, 'dg-offer-1');
  assert.deepEqual(saved.vettingRubric.map(c => c.criterionId), ['c1', 'c2']);
  assert.throws(
    () => store.demigodOffers.create('commons', 'owner', profileInput('dgp-2', { offerRef: 'nope' })),
    error => error.code === 'demigod_offer_ref_missing');
});

test('price type, timeline, and revision terms are validated; every record is record-only', t => {
  // Contract: the offer template's money shape (priceType/priceMilli/
  // timeline/revisionTerms) plus the record-only invariant — nothing here
  // may imply payment is configured. Regression: a typo'd priceType
  // persisting, or paymentStatus suggesting money moves.
  const { store } = fixture(t);
  for (const bad of [{ priceType: 'equity' }, { priceType: 'fixed', priceMilli: '12.5' },
    { timeline: { estimateDays: '0', deadline: 'not-a-date' } },
    { revisionTerms: { maxRounds: 99, turnaroundDays: '3' } }]) {
    assert.throws(
      () => store.demigodOffers.create('commons', 'owner', profileInput(`bad-${Math.random().toString(16).slice(2, 8)}`, bad)),
      error => error.code === 'invalid_demigod_offer', JSON.stringify(bad));
  }
  const saved = store.demigodOffers.create('commons', 'owner', profileInput());
  assert.equal(saved.recordOnly, true);
  assert.equal(saved.paymentStatus, 'not_configured');
  assert.equal(saved.priceType, 'fixed');
  assert.equal(saved.feePolicyRef, 'demigod:placement-10pct/v1');
});

test('present then accept requires the exact revision; a stale revision is rejected', t => {
  // Contract: compare-and-swap acceptance — the buyer accepts the exact
  // terms they read. Regression: buyer accepts terms the room changed after
  // they read them (the dry run's "done was my judgment call" gap).
  const { store } = fixture(t);
  store.demigodOffers.create('commons', 'owner', profileInput());
  assert.throws(
    () => store.demigodOffers.accept('commons', 'owner', 'dgp-1', { requestId: 'a1', expectedRevision: 1 }),
    error => error.code === 'invalid_demigod_offer_status');
  store.demigodOffers.present('commons', 'owner', 'dgp-1', { requestId: 'p1', expectedRevision: 1 });
  assert.throws(
    () => store.demigodOffers.accept('commons', 'owner', 'dgp-1', { requestId: 'a2', expectedRevision: 1 }),
    error => error.code === 'stale_demigod_offer');
  const accepted = store.demigodOffers.accept('commons', 'owner', 'dgp-1', { requestId: 'a3', expectedRevision: 2 });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.revision, 3);
});

test('rendered offer document is buyer-presentable: scope, price, timeline, revision terms, record-only line', t => {
  // Contract: the presentable document — the buyer-facing surface the dry
  // run found missing. Regression: a document that omits the price, the
  // revision terms, or the honest record-only line (buyer can't see the
  // deal, or thinks payment is live).
  const { store } = fixture(t);
  store.demigodOffers.create('commons', 'owner', profileInput());
  const doc = store.demigodOffers.document('commons', 'dgp-1');
  assert.match(doc, /Paid trial: web automation/);
  assert.match(doc, /40 hours/);
  assert.match(doc, /code-pr/);
  assert.match(doc, /fixed/);
  assert.match(doc, /14 days/);
  assert.match(doc, /2 revision rounds/);
  assert.match(doc, /record-only/i);
  assert.match(doc, /no payment is collected or moved/i);
});

test('request ids are idempotent: same input replays the same outcome', t => {
  // Contract: safe retries on offer creation. Regression: a retried POST
  // minting a duplicate profile.
  const { store } = fixture(t);
  const first = store.demigodOffers.create('commons', 'owner', profileInput());
  const replay = store.demigodOffers.create('commons', 'owner', profileInput());
  assert.deepEqual(replay, first);
  assert.equal(store.demigodOffers.list('commons').profiles.length, 1);
});
