// #3606: the claimable-first browse walk used to resume a bare offer_id
// cursor in an ordering recomputed from live claim states, so a claim
// landing mid-walk could repeat a task or end the walk (nextCursor: null)
// while tasks claimable for the whole walk were never returned. The walk
// now carries a versioned cursor: a page resumes only when the board
// fingerprint still matches the walk's own, and otherwise restarts
// explicitly with `restarted: true` — exactly-once or a told restart,
// never a silent skip. These tests pin the issue's two deterministic
// repros, the unaffected filtered control, and a randomized
// mutation-during-walk property.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';

const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });

function fixture(t) {
  // In-memory store: the randomized property builds one per run.
  const store = new RoomStore(':memory:', { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('Walk worker one'), store.identities.create('Walk worker two'),
    store.identities.create('Walk worker three'), store.identities.create('Walk worker four')];
  const service = () => new PublicWorkClaims(store);
  const enable = id => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`src/${id}.js`] });
  };
  let claimSeq = 0;
  const claimTask = id => {
    const worker = identities[claimSeq % identities.length];
    service().act(id, worker.secret, 'claim', claim(`walk-claim-${claimSeq++}`));
  };
  t.after(() => { store.close(); });
  return { store, service, enable, claimTask };
}

// A client that follows the documented contract: follow nextCursor as
// after; on `restarted: true`, discard the pages collected so far.
function walk(service, { limit, claimable = false, claimableFirst = true } = {}, betweenPages = () => {}) {
  let seen = [], after = '', restarts = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = service.list({ limit, after, claimable, claimableFirst });
    if (page.restarted) { seen = []; restarts++; }
    seen.push(...page.tasks.map(task => task.taskId));
    if (page.nextCursor === null) return { seen, restarts };
    after = page.nextCursor;
    betweenPages();
  }
  throw new Error('walk did not terminate');
}

test('repro 1: claims of both returned tasks mid-walk restart instead of silently dropping the still-claimable task', t => {
  const f = fixture(t);
  for (const id of ['a-open', 'b-open', 'c-open']) f.enable(id);
  const first = f.service().list({ limit: 2 });
  assert.deepEqual(first.tasks.map(task => task.taskId), ['a-open', 'b-open']);
  assert.equal(first.restarted, undefined);
  // Routine board activity: another worker claims both returned tasks.
  f.claimTask('a-open'); f.claimTask('b-open');
  const second = f.service().list({ limit: 2, after: first.nextCursor });
  // The old code answered [] with nextCursor null here — c-open, claimable
  // for the entire walk (claimableCount: 1), was silently dropped. The
  // walk now restarts explicitly from the recomputed first page.
  assert.equal(second.restarted, true);
  assert.deepEqual(second.tasks.map(task => task.taskId), ['c-open', 'a-open']);
  assert.equal(second.claimableCount, 1);
  const third = f.service().list({ limit: 2, after: second.nextCursor });
  assert.equal(third.restarted, undefined);
  assert.deepEqual(third.tasks.map(task => task.taskId), ['b-open']);
  assert.equal(third.nextCursor, null);
  // A contract-following client ends with every task exactly once.
  const { seen } = walk(f.service(), { limit: 2 });
  assert.deepEqual([...seen].sort(), ['a-open', 'b-open', 'c-open']);
});

test('repro 2: claiming a returned task mid-walk restarts instead of returning it twice', t => {
  const f = fixture(t);
  for (const id of ['a-open', 'b-open', 'c-open', 'd-held']) f.enable(id);
  f.claimTask('d-held');
  const first = f.service().list({ limit: 2 });
  assert.deepEqual(first.tasks.map(task => task.taskId), ['a-open', 'b-open']);
  // Another worker claims a-open, which page 1 already returned.
  f.claimTask('a-open');
  const second = f.service().list({ limit: 2, after: first.nextCursor });
  // The old code returned [c-open, a-open] here — a-open twice in one walk.
  assert.equal(second.restarted, true);
  assert.deepEqual(second.tasks.map(task => task.taskId), ['b-open', 'c-open']);
  const third = f.service().list({ limit: 2, after: second.nextCursor });
  assert.deepEqual(third.tasks.map(task => task.taskId), ['a-open', 'd-held']);
  assert.equal(third.nextCursor, null);
  const restartedWalk = [...second.tasks, ...third.tasks].map(task => task.taskId);
  assert.equal(new Set(restartedWalk).size, restartedWalk.length, 'no task repeats within the restarted walk');
});

test('control: the claimable-filtered walk under the same mutations is unchanged — no restarts, no drops, no duplicates', t => {
  const f = fixture(t);
  for (const id of ['a-open', 'b-open', 'c-open']) f.enable(id);
  let step = 0;
  const { seen, restarts } = walk(f.service(), { limit: 2, claimable: true }, () => {
    if (step++ === 0) { f.claimTask('a-open'); f.claimTask('b-open'); }
  });
  assert.equal(restarts, 0);
  assert.deepEqual(seen, ['a-open', 'b-open', 'c-open']);
});

test('offer_id scan (claimableFirst: false, the availablePublicTasks path) stays exactly-once under mid-walk claims', t => {
  const f = fixture(t);
  for (const id of ['a-open', 'b-open', 'c-open', 'd-open']) f.enable(id);
  let step = 0;
  const { seen, restarts } = walk(f.service(), { limit: 2, claimableFirst: false }, () => {
    if (step++ === 0) f.claimTask('a-open');
  });
  assert.equal(restarts, 0);
  assert.deepEqual(seen, ['a-open', 'b-open', 'c-open', 'd-open']);
});

test('a bare task-id cursor carries no board fingerprint, so the browse walk restarts explicitly instead of resuming into a recomputed order', t => {
  const f = fixture(t);
  for (const id of ['a-open', 'b-open', 'c-open']) f.enable(id);
  const page = f.service().list({ limit: 2, after: 'a-open' });
  assert.equal(page.restarted, true);
  assert.deepEqual(page.tasks.map(task => task.taskId), ['a-open', 'b-open']);
});

test('randomized mutation-during-walk: never duplicates, never omits a task that stayed claimable for the whole walk', t => {
  const ids = ['task-01', 'task-02', 'task-03', 'task-04', 'task-05', 'task-06'];
  fc.assert(fc.property(
    fc.subarray(ids, { minLength: 0, maxLength: 3 }),          // initially claimed
    fc.integer({ min: 1, max: 4 }),                            // page size
    fc.array(fc.subarray(ids, { minLength: 0, maxLength: 2 }), { minLength: 0, maxLength: 6 }), // claims before each later page
    (initialClaims, limit, flips) => {
      const f = fixture(t);
      for (const id of ids) f.enable(id);
      const claimed = new Set();
      const flip = id => { if (!claimed.has(id)) { f.claimTask(id); claimed.add(id); } };
      for (const id of initialClaims) flip(id);
      let flipRound = 0;
      const { seen } = walk(f.service(), { limit }, () => {
        for (const id of flips[flipRound++ % Math.max(flips.length, 1)] ?? []) flip(id);
      });
      assert.equal(new Set(seen).size, seen.length, `duplicate in walk: ${seen}`);
      // Claims are monotone, so the final (re)started segment walked one
      // consistent board state: every never-claimed task was claimable in
      // it and must appear exactly once.
      for (const id of ids) if (!claimed.has(id)) assert.ok(seen.includes(id), `${id} stayed claimable but was dropped: ${seen}`);
      assert.ok(seen.every(id => ids.includes(id)), 'walk returned an unknown task');
    }), { numRuns: 15, seed: 3606 });
});
