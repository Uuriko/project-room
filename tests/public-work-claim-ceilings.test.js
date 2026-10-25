import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema, PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY, PUBLIC_WORK_MAX_RENEWALS_PER_CLAIM } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';

// #3707 (ECON-ATTACK-LAB F4): claim squatting was free and unbounded — one
// identity held all 9 tranche-1 First Shift tasks for 72h+ on renewals
// alone (99/99 granted), and a finish succeeded at day 10 against a 48h
// submission deadline that existed only as task text. These tests pin the
// ceilings on the same surface the lab drove (store.publicWorkClaims.act)
// and pin that an honest worker's normal flow is untouched.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-ceilings-')), file = join(dir, 'room.sqlite');
  let clock = Date.parse('2026-11-02T00:00:00Z');
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('Squatter'), store.identities.create('Honest worker')];
  const service = () => new PublicWorkClaims(store);
  const enable = (id, extraTerms = {}) => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' }, ...extraTerms } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`first-shift/${id}.txt`] });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, identities, enable, now: () => clock, tick(ms) { clock += ms; } };
}
const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });
const code = expected => error => error.code === expected;
const HOUR = 3600 * 1000;

test('the squat fails at the live-claim ceiling: one identity cannot hold the whole shelf', t => {
  const f = fixture(t), [squatter, honest] = f.identities;
  const ids = Array.from({ length: 9 }, (_, i) => `t1-task-${i}`);
  for (const id of ids) f.enable(id);
  // The report's adversary claimed all 9 tranche-1 tasks; now the ceiling
  // (PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY) stops the 4th claim.
  for (let i = 0; i < PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY; i++)
    f.service().act(ids[i], squatter.secret, 'claim', claim(`squat-${i}`, { leaseHours: 8 }));
  assert.throws(() => f.service().act(ids[3], squatter.secret, 'claim', claim('squat-3', { leaseHours: 8 })), code('public_work_claim_limit'));
  // The refusal is not journaled: the same requestId may be reused once a
  // slot frees, and the shelf stays mostly claimable instead of 0.
  assert.equal(f.service().list({ limit: 100 }).claimableCount, 9 - PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY);
  // Another identity is unaffected by the squatter's ceiling.
  f.service().act(ids[3], honest.secret, 'claim', claim('honest-3', { leaseHours: 8 }));
  // Finishing frees a slot; releasing frees a slot.
  f.service().act(ids[0], squatter.secret, 'finish', owned('finish-0', 1, { artifactText: 'done', checksReported: [] }));
  f.service().act(ids[4], squatter.secret, 'claim', claim('squat-4', { leaseHours: 8 }));
  f.service().act(ids[1], squatter.secret, 'release', owned('release-1', 1));
  f.service().act(ids[5], squatter.secret, 'claim', claim('squat-5', { leaseHours: 8 }));
  // match() auto-claim funnels through the same claim path and is bound too.
  assert.throws(() => f.service().match(squatter.secret, { requestId: 'squat-match', autoClaim: true }), code('public_work_claim_limit'));
});

test('the renewal ceiling lapses the lease for real and the next round starts fresh', t => {
  const f = fixture(t), [squatter, honest] = f.identities;
  f.enable('held-task');
  f.service().act('held-task', squatter.secret, 'claim', claim('claim', { leaseHours: 8 }));
  // The report renewed 99/99 times; now exactly the budget is granted.
  for (let n = 1; n <= PUBLIC_WORK_MAX_RENEWALS_PER_CLAIM; n++) {
    f.tick(7 * HOUR);
    f.service().act('held-task', squatter.secret, 'renew', owned(`renew-${n}`, 1, { leaseHours: 8 }));
  }
  f.tick(7 * HOUR);
  assert.throws(() => f.service().act('held-task', squatter.secret, 'renew', owned('renew-over', 1, { leaseHours: 8 })), code('public_work_renewal_limit'));
  // The refusal does not kill the claim early: it is still held until the
  // current lease expiry, then it lapses for real and returns to the board.
  assert.equal(f.service().read('held-task').claim.state, 'claimed');
  f.tick(2 * HOUR);
  assert.equal(f.service().read('held-task').claim.state, 'unclaimed');
  // A fresh claim round carries a fresh renewal budget.
  f.service().act('held-task', honest.secret, 'claim', claim('honest-claim', { leaseHours: 8 }));
  f.tick(7 * HOUR);
  f.service().act('held-task', honest.secret, 'renew', owned('honest-renew', 2, { leaseHours: 8 }));
});

test('honest flow untouched: claim, a few renewals, finish inside the deadline', t => {
  const f = fixture(t), [, honest] = f.identities;
  const deadline = new Date(f.now() + 72 * HOUR).toISOString();
  f.enable('honest-task', { deadline });
  const claimed = f.service().act('honest-task', honest.secret, 'claim', claim('claim', { leaseHours: 8 }));
  assert.equal(claimed.task.claim.state, 'claimed');
  for (let n = 1; n <= 3; n++) {
    f.tick(7 * HOUR);
    f.service().act('honest-task', honest.secret, 'renew', owned(`renew-${n}`, 1, { leaseHours: 8 }));
  }
  f.tick(7 * HOUR);
  const done = f.service().act('honest-task', honest.secret, 'finish', owned('finish', 1, { artifactText: 'Real work', checksReported: ['tests pass'] }));
  assert.equal(done.task.claim.state, 'submitted');
  assert.equal(done.receipt.state, 'submitted');
});

test('deadline clamps claim and renewal leases; the claim lapses at the deadline and late finishes are refused', t => {
  const f = fixture(t), [worker] = f.identities;
  const t0 = f.now(), deadlineMs = t0 + 48 * HOUR, deadline = new Date(deadlineMs).toISOString();
  f.enable('deadline-a', { deadline });
  f.enable('deadline-b', { deadline });
  // Claim late in the window with a lease that would overrun the deadline:
  // the granted lease is clamped to the deadline, visibly, in the packet.
  f.tick(30 * HOUR);
  const a = f.service().act('deadline-a', worker.secret, 'claim', claim('claim-a', { leaseHours: 24 }));
  assert.equal(a.task.claim.leaseExpiresAt, deadline);
  const b = f.service().act('deadline-b', worker.secret, 'claim', claim('claim-b', { leaseHours: 8 }));
  assert.equal(b.task.claim.leaseExpiresAt, new Date(t0 + 38 * HOUR).toISOString());
  // A renewal that would cross the deadline clamps to it too.
  f.tick(7 * HOUR);
  const renewed = f.service().act('deadline-b', worker.secret, 'renew', owned('renew-b', 1, { leaseHours: 24 }));
  assert.equal(renewed.task.claim.leaseExpiresAt, deadline);
  // Finishing inside the deadline works.
  f.tick(10 * HOUR); // t0 + 47h
  const done = f.service().act('deadline-a', worker.secret, 'finish', owned('finish-a', 1, { artifactText: 'In time', checksReported: [] }));
  assert.equal(done.receipt.state, 'submitted');
  // Past the deadline the other claim has lapsed: a late finish meets the
  // ordinary stale-claim refusal, and the task is not claimable any more.
  f.tick(2 * HOUR); // t0 + 49h
  assert.throws(() => f.service().act('deadline-b', worker.secret, 'finish', owned('finish-b', 1, { artifactText: 'Too late', checksReported: [] })), code('stale_public_claim'));
  const packetB = f.service().read('deadline-b');
  assert.equal(packetB.claim.state, 'unclaimed');
  assert.equal(packetB.claimable, false);
  // A fresh claim after the deadline is refused by name, and match does not
  // offer the closed task.
  assert.throws(() => f.service().act('deadline-b', worker.secret, 'claim', claim('claim-late', { leaseHours: 8 })), code('public_work_deadline_passed'));
  assert.deepEqual(f.service().match(null, {}).recommendations, []);
});

test('deadline refusal backstop: a pre-clamp lease cannot finish after the deadline', t => {
  const f = fixture(t), [worker] = f.identities;
  const t0 = f.now();
  f.enable('legacy-task');
  // A claim granted before deadline enforcement (lease runs 24h), on an
  // offer whose terms only later gain a 12h deadline — written straight to
  // the terms row, the way a terms state the claim predates would look.
  f.service().act('legacy-task', worker.secret, 'claim', claim('claim', { leaseHours: 24 }));
  const row = f.store.db.prepare('SELECT terms FROM project_offers WHERE offer_id=?').get('legacy-task');
  const terms = JSON.parse(row.terms);
  terms.deadline = new Date(t0 + 12 * HOUR).toISOString();
  f.store.db.prepare('UPDATE project_offers SET terms=? WHERE offer_id=?').run(JSON.stringify(terms), 'legacy-task');
  f.tick(13 * HOUR); // past the deadline, inside the pre-clamp lease
  assert.throws(() => f.service().act('legacy-task', worker.secret, 'finish', owned('finish-late', 1, { artifactText: 'Too late', checksReported: [] })), code('public_work_deadline_passed'));
  // Renewals on the same pre-clamp claim are refused by name too.
  assert.throws(() => f.service().act('legacy-task', worker.secret, 'renew', owned('renew-late', 1, { leaseHours: 8 })), code('public_work_deadline_passed'));
});
