import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';

// ESCROW-GUARDS PR 1 (HUNT state-machine F3 / ATLAS-WORK-MONEY W-11): an
// offer's terms.deadline was validated at create and then never read again —
// a draft could be published after its own deadline and a published offer
// could be bound into a public task (funding escrow, for paid offers) long
// after the submission window closed. The public-work claim/renew/finish
// doors already refuse past the deadline (#3707, public_work_deadline_passed);
// these tests pin the two doors that did not: offer publish and public-work
// enable. In-flight bindings made before the deadline are unaffected.
const HOUR = 3600 * 1000;
const code = expected => error => error.code === expected;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'offer-deadline-')), file = join(dir, 'room.sqlite');
  let clock = Date.parse('2026-11-02T00:00:00Z');
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, now: () => clock, tick(ms) { clock += ms; } };
}

const terms = (deadline, extra = {}) => ({ kind: 'task', title: 'Deadline work', summary: 'Bound by a deadline',
  acceptanceCriteria: ['One concrete accepted result'], repositoryUrl: 'https://github.com/Example/Project',
  reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' }, deadline, ...extra });
const create = (store, id, deadline) => store.projectOffers.create('commons', 'owner',
  { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'], terms: terms(deadline) });
const publish = (store, id, requestId = `publish-${id}`) =>
  store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId, expectedRevision: 1 });

test('publish refuses once the offer deadline has passed; the draft is untouched', t => {
  const f = fixture(t), { store } = f;
  const deadline = new Date(f.now() + 2 * HOUR).toISOString();
  create(store, 'born-late', deadline);
  create(store, 'in-window', new Date(f.now() + 72 * HOUR).toISOString());
  f.tick(3 * HOUR); // past born-late's deadline, inside in-window's
  assert.throws(() => publish(store, 'born-late'), error => error.code === 'offer_deadline_passed' && error.status === 409);
  // The refusal is the deadline's, not a state change: still a draft, still
  // unpublished, and a retry under a fresh request id refuses identically.
  const mine = store.projectOffers.ownerList('commons', 'owner').offers;
  assert.equal(mine.find(offer => offer.id === 'born-late').status, 'draft');
  assert.throws(() => publish(store, 'born-late', 'publish-retry'), code('offer_deadline_passed'));
  assert.equal(store.projectOffers.list().offers.some(offer => offer.id === 'born-late'), false);
  // The control offer publishes normally inside its window.
  assert.equal(publish(store, 'in-window').status, 'published');
});

test('publish at exactly the deadline refuses (the window is closed at the deadline)', t => {
  const f = fixture(t), { store } = f;
  const deadline = new Date(f.now() + 2 * HOUR).toISOString();
  create(store, 'edge', deadline);
  f.tick(2 * HOUR); // now == deadline
  assert.throws(() => publish(store, 'edge'), code('offer_deadline_passed'));
});

test('enable refuses once the deadline has passed: no task is bound', t => {
  const f = fixture(t), { store } = f;
  const deadline = new Date(f.now() + 2 * HOUR).toISOString();
  create(store, 'bind-late', deadline);
  publish(store, 'bind-late'); // published inside its window
  f.tick(3 * HOUR);
  assert.throws(() => store.publicWorkClaims.enable('commons', 'owner', 'bind-late',
    { requestId: 'enable-late', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['work.txt'] }),
    error => error.code === 'offer_deadline_passed' && error.status === 409);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM public_work_tasks WHERE offer_id=?').get('bind-late').n, 0);
  assert.equal(store.publicWorkClaims.list({ limit: 100 }).claimableCount, 0);
  // The offer itself is untouched: still published, and the owner can still
  // withdraw it after the deadline (cleanup is not an act on the offer's
  // submission window).
  assert.equal(store.projectOffers.read('bind-late').status, 'published');
  const withdrawn = store.projectOffers.transition('commons', 'owner', 'bind-late', 'withdraw', { requestId: 'withdraw-late', expectedRevision: 2 });
  assert.equal(withdrawn.status, 'withdrawn');
});

test('paid enable after the deadline locks no escrow and records no settlement', t => {
  const f = fixture(t), { store } = f;
  const worker = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.worker = { id: 'worker', revision: 1, kind: 'agent', active: true, displayName: 'Worker', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', worker.identityId, 'worker', f.now());
  store.bountyEscrow.ensureGenesis('commons');
  const deadline = new Date(f.now() + 2 * HOUR).toISOString();
  store.projectOffers.create('commons', 'owner', { requestId: 'create-paid', offerId: 'paid-late', reviewerMemberIds: ['owner'],
    terms: terms(deadline, { reward: { kind: 'work_trade', unit: 'credit', amountMinor: '4000' } }) });
  store.projectOffers.transition('commons', 'owner', 'paid-late', 'publish', { requestId: 'publish-paid', expectedRevision: 1 });
  const payable = () => store.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id='commons' AND account_id='owner' AND lot_state='payable'").get().t;
  const before = payable();
  f.tick(3 * HOUR);
  assert.throws(() => store.publicWorkClaims.enable('commons', 'owner', 'paid-late',
    { requestId: 'enable-paid', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] }),
    code('offer_deadline_passed'));
  // Nothing funded, nothing bound, conservation exact.
  assert.equal(payable(), before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM public_work_tasks WHERE offer_id=?').get('paid-late').n, 0);
  assert.equal(store.publicWorkSettlement.viewForOffer('paid-late'), null);
  assert.equal(store.bountyEscrow.verifyConservation('commons').ok, true);
});

test('a binding made before the deadline is unaffected after it', t => {
  const f = fixture(t), { store } = f;
  const deadline = new Date(f.now() + 2 * HOUR).toISOString();
  create(store, 'bound-early', deadline);
  publish(store, 'bound-early');
  const packet = store.publicWorkClaims.enable('commons', 'owner', 'bound-early',
    { requestId: 'enable-early', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['work.txt'] });
  assert.equal(packet.taskId, 'bound-early');
  f.tick(3 * HOUR); // deadline passes with the binding already in flight
  // The binding stands (it is not retroactively torn down); the task reads
  // back, simply no longer claimable — the #3707 claim-door semantics.
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM public_work_tasks WHERE offer_id=?').get('bound-early').n, 1);
  const after = store.publicWorkClaims.read('bound-early');
  assert.equal(after.claim.state, 'unclaimed');
  assert.equal(after.claimable, false);
});
