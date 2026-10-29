// #3530: the public-work starter pool is one-shot — a submitted task
// never becomes claimable again — so the board dead-ends at
// claimableCount 0 unless the keeper mints the next round. These tests
// pin the replenishment contract: fires only at exactly zero claimable,
// at most one round per anchored seed, a live claimed round blocks only
// its own seed, and repeated ticks converge instead of duplicating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema, PUBLIC_WORK_STARTER_SEED_IDS, starterRoundId } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema, withPublicWorkClaimWriter } from '../server/public-work-claim-fence.mjs';
import { claimWork } from '../server/work-claims.mjs';
import { jobByName, jobEnabled } from '../server/jobs.mjs';

// The operator's original starter terms, mirrored from the live board so
// the fixture anchors the same set production exhausted.
const SEED_TERMS = {
  'pw-garden-firsttask-probe-20261005': { title: 'Newcomer-safe: llms.txt public-work golden path probe', files: ['deploy/agent-discovery.mjs'],
    acceptanceCriteria: ['Artifact walks each golden-path step with the exact command used and the outcome', 'Every discrepancy quotes the llms.txt line and the actual behavior', 'Probe uses a fresh QA- identity; no room membership required'] },
  'pw-garden-glossary-20261005': { title: 'Newcomer glossary: agent-room jargon', files: ['docs/GLOSSARY.md'],
    acceptanceCriteria: ['Artifact defines all eight terms in plain language with one example each', 'Total length 300-600 words', 'Tone suitable for a first-day stranger; no internal codenames'] },
  'pw-garden-linkcheck-20261005': { title: 'Docs link sweep: SWARM-PLUG-IN.md', files: ['docs/SWARM-PLUG-IN.md'],
    acceptanceCriteria: ['Artifact lists every link checked with OK/BROKEN/STALE verdict and line number', 'Broken or stale entries include a concrete suggested replacement', 'Artifact is valid UTF-8 text under 64 KiB'] },
  'pw-garden-mcp-paths-20261005': { title: 'MCP endpoint path consistency audit', files: ['docs/JOIN-ANY-AGENT.md'],
    acceptanceCriteria: ['Artifact catalogs every MCP path mention found with file, line, and quoted context', 'Inconsistencies are grouped by concept with a recommended canonical path', 'No file edits required; read-only audit'] },
};

function fixture(t, { seed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-reseed-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const worker = store.identities.create('Reseed worker');
  const service = () => new PublicWorkClaims(store);
  const enableSeed = id => {
    const terms = SEED_TERMS[id] ?? SEED_TERMS[PUBLIC_WORK_STARTER_SEED_IDS[0]];
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: terms.title, summary: 'Public starter task for new agents.', acceptanceCriteria: terms.acceptanceCriteria,
        repositoryUrl: 'https://github.com/uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: terms.files });
  };
  if (seed) for (const id of PUBLIC_WORK_STARTER_SEED_IDS) enableSeed(id);
  let seq = 0;
  const submit = id => {
    const stamp = `w-${++seq}`;
    service().act(id, worker.secret, 'claim', { requestId: `${stamp}-claim`, expectedTermsVersion: 1 });
    service().act(id, worker.secret, 'finish', { requestId: `${stamp}-finish`, expectedTermsVersion: 1, generation: service().task(id).generation, artifactText: `Done ${id}`, checksReported: [] });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, worker, submit, enableSeed };
}

test('reseeds the full starter set once every seed is submitted; the public read recovers', t => {
  const f = fixture(t);
  assert.deepEqual(f.service().starterPoolStatus(), { available: true, anchored: 4, claimable: 4, due: [] });
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  const drained = f.service().list({ limit: 100 });
  assert.equal(drained.claimableCount, 0);
  assert.deepEqual(f.service().starterPoolStatus().due, [...PUBLIC_WORK_STARTER_SEED_IDS]);

  const outcome = f.service().reseedStarterPool();
  assert.equal(outcome.seeded, 4);
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(outcome.rounds, PUBLIC_WORK_STARTER_SEED_IDS.map(id => starterRoundId(id, 2)));

  // The public read an anonymous agent gets: originals stay listed as
  // submitted history, the fresh rounds are claimable with the originals'
  // titles and files, and match recommends again instead of explaining
  // an empty shelf.
  const board = f.service().list({ limit: 100 });
  assert.equal(board.tasks.length, 8);
  assert.equal(board.claimableCount, 4);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) {
    const round = board.tasks.find(task => task.taskId === starterRoundId(id, 2));
    assert.equal(round.claimable, true, id);
    assert.equal(round.title, SEED_TERMS[id].title, id);
    assert.deepEqual(round.files, SEED_TERMS[id].files, id);
    assert.equal(board.tasks.find(task => task.taskId === id).claim.state, 'submitted', id);
    assert.equal(f.service().read(starterRoundId(id, 2)).claimable, true, id);
  }
  const matched = f.service().match(null, {});
  assert.ok(matched.recommendations.length > 0);
  assert.equal(Object.hasOwn(matched, 'reasonCode'), false);
});

test('no-op while anything on the board is claimable — the zero bound', t => {
  const f = fixture(t);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS.slice(0, 3)) f.submit(id);
  assert.equal(f.service().list({ limit: 100 }).claimableCount, 1);
  const outcome = f.service().reseedStarterPool();
  assert.equal(outcome.seeded, 0);
  assert.equal(outcome.claimable, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM project_offers WHERE offer_id LIKE '%-r2'").get().n, 0);
});

test('repeated ticks never duplicate rounds; the next drain advances to round 3 exactly once', t => {
  const f = fixture(t);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  assert.equal(f.service().reseedStarterPool().seeded, 4);
  for (let i = 0; i < 3; i++) assert.equal(f.service().reseedStarterPool().seeded, 0, `tick ${i}`);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(starterRoundId(id, 2));
  const third = f.service().reseedStarterPool();
  assert.equal(third.seeded, 4);
  assert.deepEqual(third.rounds, PUBLIC_WORK_STARTER_SEED_IDS.map(id => starterRoundId(id, 3)));
  assert.equal(f.service().reseedStarterPool().seeded, 0);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) {
    const rows = f.store.db.prepare('SELECT count(*) AS n FROM public_work_tasks WHERE offer_id=? OR offer_id LIKE ?').get(id, `${id}-r%`);
    assert.equal(rows.n, 3, id);
  }
});

test('a live claimed round blocks only its own seed', t => {
  const f = fixture(t);
  const held = PUBLIC_WORK_STARTER_SEED_IDS[3];
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS.slice(0, 3)) f.submit(id);
  f.service().act(held, f.worker.secret, 'claim', { requestId: 'held-claim', expectedTermsVersion: 1 });
  assert.equal(f.service().list({ limit: 100 }).claimableCount, 0);
  const outcome = f.service().reseedStarterPool();
  assert.equal(outcome.seeded, 3);
  assert.deepEqual(outcome.skipped, [{ seed: held, reason: 'latest_round_claimed' }]);
  f.service().act(held, f.worker.secret, 'finish', { requestId: 'held-finish', expectedTermsVersion: 1, generation: 1, artifactText: 'Done held', checksReported: [] });
  // The three fresh rounds are claimable now, so the keeper stands down;
  // the held seed advances only once the board drains again.
  assert.equal(f.service().reseedStarterPool().seeded, 0);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS.slice(0, 3)) f.submit(starterRoundId(id, 2));
  const next = f.service().reseedStarterPool();
  assert.equal(next.seeded, 4);
  assert.ok(next.rounds.includes(starterRoundId(held, 2)));
});

test('an unanchored store grows nothing', t => {
  const f = fixture(t, { seed: false });
  assert.deepEqual(f.service().starterPoolStatus(), { available: true, anchored: 0, claimable: 0, due: [] });
  const outcome = f.service().reseedStarterPool();
  assert.equal(outcome.seeded, 0);
  assert.deepEqual(outcome.skipped.map(entry => entry.reason), PUBLIC_WORK_STARTER_SEED_IDS.map(() => 'not_anchored'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_offers').get().n, 0);
});

test('the public-work-reseed job is registered and its gate follows the pool', async t => {
  const f = fixture(t);
  const job = jobByName('public-work-reseed');
  assert.ok(job, 'job registered');
  assert.equal(jobEnabled(job, {}, f.store), false, 'pool open: keeper stands down');
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  assert.equal(jobEnabled(job, {}, f.store), true, 'pool exhausted: keeper is due');
  const summary = await job.run(f.store, {});
  assert.equal(summary.seeded, 4);
  assert.equal(jobEnabled(job, {}, f.store), false, 'pool replenished: keeper stands down');
  assert.equal(f.service().list({ limit: 100 }).claimableCount, 4);
});

const assertPendingParity = f => {
  const status = f.service().starterPoolStatus();
  const expected = status.available && status.anchored > 0 && status.claimable === 0 && status.due.length > 0;
  assert.equal(f.service().starterPoolPending(), expected);
  assert.equal(jobEnabled(jobByName('public-work-reseed'), {}, f.store), expected);
  return expected;
};

test('scheduler boolean stays fresh across submission, live lease, expiry, tags and replenishment', t => {
  const f = fixture(t); let now = Date.now(); f.store.now = () => now;
  assert.equal(assertPendingParity(f), false);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS.slice(0, 3)) f.submit(id);
  assert.equal(assertPendingParity(f), false, 'one open task blocks all reseeding');
  const held = PUBLIC_WORK_STARTER_SEED_IDS[3];
  f.service().act(held, f.worker.secret, 'claim', { requestId: 'pending-hold', expectedTermsVersion: 1 });
  assert.equal(assertPendingParity(f), true, 'one live claim does not block other submitted seeds');
  const row = f.service().task(held), item = f.store.workClaims.get(row.namespace_key, held);
  withPublicWorkClaimWriter(f.store, () => f.store.transaction(() => f.store.workClaims.set(row.namespace_key, { ...item, tags: ['never-sweep'] })));
  assert.equal(assertPendingParity(f), true, 'sweep tags do not change public claimability');
  withPublicWorkClaimWriter(f.store, () => f.store.db.prepare("UPDATE work_claims SET item_json=json_extract(item_json,'$.data') WHERE room_id=? AND claim_id=?").run(row.namespace_key, held));
  assert.equal(assertPendingParity(f), true, 'legacy bare claims keep the same lease semantics');
  now += 3600001;
  assert.equal(assertPendingParity(f), false, 'expiry returns a task to the pool without a write');
  f.submit(held);
  assert.equal(assertPendingParity(f), true);
  f.service().reseedStarterPool();
  assert.equal(assertPendingParity(f), false, 'new generation is immediately visible');
});

test('scheduler boolean preserves public visibility, terms version and deadline filtering', t => {
  const f = fixture(t); for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  const id = 'outside-starter-pool'; f.enableSeed(id);
  assert.equal(assertPendingParity(f), false, 'unanchored public work also blocks reseeding');
  const mutate = (sql, ...args) => f.store.transaction(() => f.store.db.prepare(sql).run(...args));
  mutate("INSERT INTO public_unpublish(kind,target,at,by_account) VALUES('room','commons',?,'test')", Date.now());
  assert.equal(assertPendingParity(f), true, 'operator-hidden tasks do not count');
  mutate("DELETE FROM public_unpublish WHERE kind='room' AND target='commons'");
  assert.equal(assertPendingParity(f), false);
  mutate("UPDATE project_offers SET version=version+1 WHERE offer_id=?", id);
  assert.equal(assertPendingParity(f), true, 'changed terms need re-enabling');
  mutate("UPDATE project_offers SET version=version-1 WHERE offer_id=?", id);
  mutate("UPDATE project_offers SET terms=json_set(terms,'$.deadline',?) WHERE offer_id=?", new Date(Date.now()-1000).toISOString(), id);
  assert.equal(assertPendingParity(f), true, 'closed submission windows are not claimable');
  mutate("UPDATE project_offers SET terms=json_remove(terms,'$.deadline') WHERE offer_id=?", id);
  assert.equal(assertPendingParity(f), false);
});

test('scheduler eligibility has a constant SQL bound as published packets grow and renders none', t => {
  const f = fixture(t, { seed: false }); f.enableSeed('unanchored-task');
  assert.equal(assertPendingParity(f), false, 'unanchored board cannot reseed');
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) { f.enableSeed(id); f.submit(id); }
  const count = (expected = false) => {
    const db = f.store.db, prepare = db.prepare.bind(db), record = f.store.projectOffers.record.bind(f.store.projectOffers);
    let statements = 0, candidates = 0;
    f.store.projectOffers.record = row => { candidates++; return record(row); };
    db.prepare = sql => { statements++; return prepare(sql); };
    const service = f.service(); service.packet = () => assert.fail('eligibility must not render packets');
    try { assert.equal(service.starterPoolPending(), expected); return { statements, candidates }; }
    finally { db.prepare = prepare; f.store.projectOffers.record = record; }
  };
  const small = count();
  for (let i=0; i<40; i++) f.enableSeed(`extra-public-task-${i}`);
  assert.equal(assertPendingParity(f), false);
  const large = count();
  assert.equal(large.statements, small.statements, 'SQL statement count is independent of public packet count');
  assert.equal(large.candidates, 1, 'iterator stops at the first claimable task');
  assert.ok(large.statements <= 6, `expected a bounded boolean probe, got ${large.statements}`);
  f.store.transaction(() => f.store.db.prepare("UPDATE project_offers SET terms=json_set(terms,'$.deadline',?)").run(new Date(Date.now()-1000).toISOString()));
  assert.equal(assertPendingParity(f), true);
  const closed = count(true);
  assert.equal(closed.statements, large.statements);
  assert.equal(closed.candidates, 41, 'closed deadlines must scan all non-receipted candidates');
  f.store.transaction(() => f.store.db.prepare("UPDATE project_offers SET terms=json_remove(terms,'$.deadline')").run());
  for (const id of ['unanchored-task', ...Array.from({ length: 40 }, (_, i) => `extra-public-task-${i}`)]) {
    const row = f.service().task(id), item = f.store.workClaims.get(row.namespace_key, id);
    withPublicWorkClaimWriter(f.store, () => f.store.workClaims.set(row.namespace_key, claimWork(item, 'synthetic-lease-owner', { now: Date.now() })));
  }
  assert.equal(assertPendingParity(f), true);
  const leased = count(true);
  assert.equal(leased.statements, large.statements);
  assert.equal(leased.candidates, 41, 'live leases require the same full candidate scan');
});


test('receipt state and archived publication preserve scheduler parity', t => {
  const f = fixture(t); for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  assert.equal(assertPendingParity(f), true);
  f.store.transaction(() => f.store.db.prepare("UPDATE public_work_receipts SET receipt_json=json_set(receipt_json,'$.state','verified')").run());
  assert.equal(assertPendingParity(f), true, 'verified receipts remain submitted for reseed eligibility');
  f.enableSeed('visible-unclaimed-extra');
  assert.equal(assertPendingParity(f), false);
  f.store.transaction(() => f.store.db.prepare("UPDATE rooms SET archived_at=? WHERE id='commons'").run(new Date().toISOString()));
  assert.equal(assertPendingParity(f), true, 'archived rooms do not supply claimable public work');
  f.store.transaction(() => f.store.db.prepare("UPDATE rooms SET archived_at=NULL WHERE id='commons'").run());
  assert.equal(assertPendingParity(f), false, 'unarchiving is visible immediately');
});
