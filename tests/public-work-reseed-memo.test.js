// PERF-10X L11 (VIS-C): public-work-reseed's enabled() recomputed
// starterPoolStatus() from scratch on every job-alarm scan — 12 of the
// scan's 23 statements on a representative request. The status is now
// memoized per PublicWorkClaims instance (per DO wake in production).
// These tests pin the two proofs the charter requires:
//  (a) statement count on the arm path: 23 (memo off) -> 12 (memo warm),
//      with the reseed gate itself going 12 -> 1 statement;
//  (b) equivalence: gate outcomes identical with the memo on and off
//      across a scripted sequence with pool-mutating commands between
//      calls in the same wake, including a lease lapsing on time alone,
//      mutations made through other instances/modules, raw SQL writes,
//      and a rolled-back transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema, PUBLIC_WORK_STARTER_SEED_IDS, starterRoundId } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';
import { JOBS, earliestFutureAlarm, jobByName, jobEnabled } from '../server/jobs.mjs';
import { unpublishPublic } from '../server/legal-store.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';
import { withPublicWorkClaimWriter } from '../server/public-work-claim-fence.mjs';

const SEED_FILES = {
  'pw-garden-firsttask-probe-20261005': ['deploy/agent-discovery.mjs'],
  'pw-garden-glossary-20261005': ['docs/GLOSSARY.md'],
  'pw-garden-linkcheck-20261005': ['docs/SWARM-PLUG-IN.md'],
  'pw-garden-mcp-paths-20261005': ['docs/JOIN-ANY-AGENT.md'],
};

// VIS-C's counting method: wrap db.prepare so every statement execution
// (get/all/run) counts, and count each db.exec call (transaction
// wrappers) as one.
function countStatements(store) {
  let n = 0;
  const origPrepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const stmt = origPrepare(sql);
    for (const method of ['get', 'all', 'run']) {
      const orig = stmt[method].bind(stmt);
      stmt[method] = (...args) => { n++; return orig(...args); };
    }
    return stmt;
  };
  const origExec = store.db.exec.bind(store.db);
  store.db.exec = sql => { n++; return origExec(sql); };
  return { reset: () => { n = 0; }, count: () => n };
}

// A PublicWorkClaims whose memo can never engage: its key probe is
// disabled, so starterPoolStatus() is exactly the unmemoized
// computation. This is the memo-off oracle for both proofs.
function unmemoized(store) {
  const service = new PublicWorkClaims(store);
  service._starterPoolMemoKey = () => null;
  return service;
}

function bareFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reseed-memo-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('arm path: earliestFutureAlarm drops 23 -> 12 statements once the reseed memo is warm, same alarm', t => {
  const store = bareFixture(t);
  // VIS-C section 4 fixture shape: one due webhook delivery and one open
  // land-queue item, public-read-model backfill unfinished, no starter
  // pool anchored, nothing due for claim-prs.
  const now = Date.now();
  store.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES ('del_due', 'manual:del_due', 'sub_due', 'ai_due', 'message.posted', '{}', 'sig', 'pending', 0, ?, ?, ?)`).run(now, now, now);
  store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, mergeable, behind, checks_state, observed, created_at, updated_at)
    VALUES ('commons', 'lq_memo', 'acme/demo', 1, 'owner', 'owner', 'unknown', 0, 'pending', 0, 1, 1)`).run();

  const counter = countStatements(store);
  const arm = (svc) => {
    // A store view whose reseed gate resolves through svc, standing in
    // for the pre-memo code (fresh instance per scan) and the memoized
    // singleton respectively; every other job reads the real store.
    const view = Object.create(store);
    Object.defineProperty(view, 'publicWorkClaims', { value: svc });
    return earliestFutureAlarm(JOBS, { env: {}, store: view, now, lastRan: {}, runtime: 'worker' });
  };

  // Memo off: a fresh key-disabled instance per scan pays the full
  // starterPoolStatus() every time — VIS-C's measured 23.
  counter.reset();
  const offAlarm = arm(unmemoized(store));
  assert.equal(counter.count(), 23, 'unmemoized arm scan (VIS-C baseline)');
  counter.reset();
  assert.equal(arm(unmemoized(store)), offAlarm);
  assert.equal(counter.count(), 23, 'unmemoized arm scan pays full price again');

  // Memo on (the store singleton): the first scan in the wake computes
  // (23 + the 1-statement memo key probe); later scans in the same
  // wake, with no intervening write, reuse it.
  counter.reset();
  const coldAlarm = earliestFutureAlarm(JOBS, { env: {}, store, now, lastRan: {}, runtime: 'worker' });
  assert.equal(coldAlarm, offAlarm, 'cold memoized scan arms the same alarm');
  assert.equal(counter.count(), 24, 'cold scan = unmemoized 23 + 1 key probe');
  counter.reset();
  const warmAlarm = earliestFutureAlarm(JOBS, { env: {}, store, now, lastRan: {}, runtime: 'worker' });
  assert.equal(warmAlarm, offAlarm, 'warm memoized scan arms the same alarm');
  assert.equal(counter.count(), 12, 'warm arm scan: reseed gate 12 -> 1 statement');
  counter.reset();
  assert.equal(earliestFutureAlarm(JOBS, { env: {}, store, now, lastRan: {}, runtime: 'worker' }), offAlarm);
  assert.equal(counter.count(), 12, 'warm arm scan stays at 12');

  // The gate alone: 12 statements unmemoized, 1 warm.
  const job = jobByName('public-work-reseed');
  counter.reset();
  assert.equal(jobEnabled(job, {}, { publicWorkClaims: unmemoized(store) }), false);
  assert.equal(counter.count(), 12, 'reseed gate unmemoized (VIS-C)');
  counter.reset();
  assert.equal(jobEnabled(job, {}, store), false);
  assert.equal(counter.count(), 1, 'reseed gate warm: only the memo key probe');
});

function seededFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reseed-memo-eq-')), file = join(dir, 'room.sqlite');
  let clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const worker = store.identities.create('Memo worker');
  const service = () => new PublicWorkClaims(store);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public starter task.', acceptanceCriteria: ['Deliver it'],
        repositoryUrl: 'https://github.com/uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: SEED_FILES[id] });
  }
  let seq = 0;
  const submit = id => {
    const stamp = `w-${++seq}`;
    service().act(id, worker.secret, 'claim', { requestId: `${stamp}-claim`, expectedTermsVersion: 1 });
    service().act(id, worker.secret, 'finish', { requestId: `${stamp}-finish`, expectedTermsVersion: 1, generation: 1, artifactText: `Done ${id}`, checksReported: [] });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, worker, submit, tick: ms => { clock += ms; }, now: () => clock };
}

test('equivalence: memoized status and gate match the unmemoized computation across pool mutations in one wake', t => {
  const f = seededFixture(t);
  const job = jobByName('public-work-reseed');
  const memoized = f.store.publicWorkClaims;
  // After every step: the singleton (memo on) must agree with a fresh
  // key-disabled instance (memo off), for the status and for the gate.
  const check = label => {
    const expected = unmemoized(f.store).starterPoolStatus();
    assert.deepEqual(memoized.starterPoolStatus(), expected, `${label}: status`);
    assert.deepEqual(memoized.starterPoolStatus(), expected, `${label}: status again (memo hit)`);
    const gate = jobEnabled(job, {}, f.store);
    assert.equal(gate, expected.available && expected.anchored > 0 && expected.claimable === 0 && expected.due.length > 0, `${label}: gate`);
  };

  check('initial board: 4 claimable');
  assert.equal(memoized.starterPoolStatus().claimable, 4);

  // Mutating the returned object must not poison the memo.
  const served = memoized.starterPoolStatus();
  served.due.push('bogus'); served.claimable = 999;
  check('after caller mutates the served status');

  // Pool-mutating command through a DIFFERENT PublicWorkClaims instance
  // (the doors do this in tests; the keeper must still see it).
  const held = PUBLIC_WORK_STARTER_SEED_IDS[0];
  f.service().act(held, f.worker.secret, 'claim', { requestId: 'held-claim', expectedTermsVersion: 1, leaseHours: 1 });
  check('after claim through a fresh instance');
  assert.equal(memoized.starterPoolStatus().claimable, 3);

  // Time alone lapses the lease: no write happens, the gate must still
  // move exactly when the unmemoized computation moves.
  f.tick(60 * 60 * 1000 - 1000);
  check('one second before the lease lapses');
  assert.equal(memoized.starterPoolStatus().claimable, 3);
  f.tick(1000);
  check('at the lease lapse');
  assert.equal(memoized.starterPoolStatus().claimable, 4, 'lapsed claim is claimable again');

  // Re-claim and release through the singleton itself.
  memoized.act(held, f.worker.secret, 'claim', { requestId: 're-claim', expectedTermsVersion: 1 });
  check('after re-claim');
  memoized.act(held, f.worker.secret, 'release', { requestId: 're-release', expectedTermsVersion: 1, generation: 2 });
  check('after release');

  // Mutations from outside the public-work module entirely: an offer
  // withdrawal (project-offers) and an operator unpublish (legal store).
  f.store.projectOffers.transition('commons', 'owner', PUBLIC_WORK_STARTER_SEED_IDS[1], 'withdraw', { requestId: 'withdraw-1', expectedRevision: 2 });
  check('after offer withdrawal');
  unpublishPublic(f.store.db, { kind: 'room', id: 'commons', byAccount: 'operator', now: f.now() });
  check('after operator unpublish of the room');
  assert.equal(memoized.starterPoolStatus().claimable, 0);

  // A raw SQL write between requests in the same wake (operator path).
  f.store.db.prepare('DELETE FROM public_unpublish WHERE kind=? AND target=?').run('room', 'commons');
  check('after raw SQL republishes the room');
  f.store.db.prepare('DELETE FROM public_work_tasks WHERE offer_id=?').run(PUBLIC_WORK_STARTER_SEED_IDS[2]);
  check('after raw SQL deletes a starter task');
  assert.equal(memoized.starterPoolStatus().anchored, 3);
});

test('equivalence past a full board page: a held claim beyond the page still bounds the memo by its lease', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reseed-memo-page-')), file = join(dir, 'room.sqlite');
  let clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  // 101 list-visible public tasks seeded directly (offer + task rows):
  // 100 claimable fill the first page, so the one held claim — the
  // board's earliest lease — sits past the slice list() returns and
  // only the claim-row fallback can bound the memo by it.
  const terms = JSON.stringify({ kind: 'task', title: 'Bulk task', summary: 'Bulk.', acceptanceCriteria: ['Deliver it'],
    repositoryUrl: 'https://github.com/uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } });
  const offer = store.db.prepare('INSERT INTO project_offers VALUES (?,?,?,?,?,?,?,?,?,?)');
  const taskRow = store.db.prepare('INSERT INTO public_work_tasks VALUES (?,?,?,?,?,?,?,?,?)');
  // Claim rows in a public namespace are fence-protected; seed them
  // through the same writer permit the public-work doors use.
  withPublicWorkClaimWriter(store, () => {
    for (let i = 0; i <= 100; i++) {
      const id = `bulk-task-${String(i).padStart(3, '0')}`;
      offer.run(id, 'commons', 'owner', 1, 1, 'published', terms, '{}', clock, clock);
      taskRow.run(id, 'memo_ns', 'commons', 1, 'https://github.com/uuriko/project-room', 'main', '["a.js"]', 0, clock);
      store.workClaims.set('memo_ns', createWork({ id, title: id, files: ['a.js'], reviewPolicy: 'self_attested' }, { now: clock }));
    }
    const heldItem = store.workClaims.get('memo_ns', 'bulk-task-100');
    store.workClaims.set('memo_ns', claimWork(heldItem, 'holder', { files: ['a.js'], leaseHours: 1, now: clock }));
  });

  const memoized = store.publicWorkClaims;
  assert.equal(memoized.starterPoolStatus().claimable, 100);
  assert.deepEqual(memoized.starterPoolStatus(), unmemoized(store).starterPoolStatus(), 'memo hit past a full page');
  clock += 60 * 60 * 1000 + 1;
  const after = memoized.starterPoolStatus();
  assert.equal(after.claimable, 101, 'the held claim past the page lapsed on time alone');
  assert.deepEqual(after, unmemoized(store).starterPoolStatus(), 'post-lapse status matches the unmemoized computation');
});

test('equivalence: drain, reseed, and a rolled-back transaction leave the memoized gate exact', t => {
  const f = seededFixture(t);
  const job = jobByName('public-work-reseed');
  const memoized = f.store.publicWorkClaims;
  const check = label => {
    const expected = unmemoized(f.store).starterPoolStatus();
    assert.deepEqual(memoized.starterPoolStatus(), expected, `${label}: status`);
    assert.deepEqual(memoized.starterPoolStatus(), expected, `${label}: status again (memo hit)`);
  };

  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  check('after the pool drains');
  assert.equal(jobEnabled(job, {}, f.store), true, 'keeper due at zero claimable');

  // Inside a transaction: delete a receipt row so the in-transaction
  // status genuinely differs (the seed is no longer submitted, so it
  // leaves `due`); then roll back — the memo must not resurrect the
  // uncommitted answer afterwards.
  assert.ok(memoized.starterPoolStatus().due.includes(PUBLIC_WORK_STARTER_SEED_IDS[0]), 'seed is due before the transaction');
  assert.throws(() => f.store.transaction(() => {
    f.store.db.prepare('DELETE FROM public_work_receipts WHERE offer_id=?').run(PUBLIC_WORK_STARTER_SEED_IDS[0]);
    const inTxn = memoized.starterPoolStatus();
    assert.deepEqual(inTxn, unmemoized(f.store).starterPoolStatus(), 'in-transaction status');
    assert.equal(inTxn.due.includes(PUBLIC_WORK_STARTER_SEED_IDS[0]), false, 'in-transaction status reflects the uncommitted delete');
    throw new Error('roll it back');
  }), /roll it back/);
  check('after rollback');
  assert.ok(memoized.starterPoolStatus().due.includes(PUBLIC_WORK_STARTER_SEED_IDS[0]), 'rolled-back delete never happened');

  // The keeper run itself mutates the pool through the singleton.
  return job.run(f.store, {}).then(summary => {
    assert.equal(summary.seeded, 4);
    check('after reseed');
    assert.equal(jobEnabled(job, {}, f.store), false, 'keeper stands down after reseed');
    assert.equal(memoized.starterPoolStatus().claimable, 4);
    // The fresh rounds are the new claimable pool; drain one and the
    // memo tracks the singleton-door claim + finish too.
    const round2 = starterRoundId(PUBLIC_WORK_STARTER_SEED_IDS[0], 2);
    memoized.act(round2, f.worker.secret, 'claim', { requestId: 'r2-claim', expectedTermsVersion: 1 });
    check('after claiming a round-2 starter');
    memoized.act(round2, f.worker.secret, 'finish', { requestId: 'r2-finish', expectedTermsVersion: 1, generation: 1, artifactText: 'Done r2', checksReported: [] });
    check('after submitting a round-2 starter');
  });
});
