// #2988 (server-side L1 availability surfacing): the public browse list must
// say which tasks are claimable, surface them first, and let callers filter
// to claimable supply; match must explain an empty result with a
// machine-readable reasonCode when it inspected tasks but none is claimable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';
import { createRoomServer } from '../server/http.mjs';

const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });

// Offer ids sort a < b < c < d, while claim states are deliberately mixed:
// a submitted, b unclaimed, c claimed, d unclaimed. Claimable-first order is
// therefore [b, d, a, c] — not offer_id order.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-claimable-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('Claimable worker one'), store.identities.create('Claimable worker two')];
  const service = () => new PublicWorkClaims(store);
  const enable = id => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`src/${id}.js`] });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, identities, enable };
}

function mixedFixture(t) {
  const f = fixture(t), [a, b] = f.identities;
  for (const id of ['a-submitted', 'b-open', 'c-claimed', 'd-open']) f.enable(id);
  f.service().act('a-submitted', a.secret, 'claim', claim('claim-a'));
  f.service().act('a-submitted', a.secret, 'finish', owned('finish-a', 1, { artifactText: 'Done a', checksReported: [] }));
  f.service().act('c-claimed', b.secret, 'claim', claim('claim-c'));
  return f;
}

test('list packets carry claimable and claimableCount counts the full result set, not the page', t => {
  const f = mixedFixture(t);
  const all = f.service().list();
  assert.deepEqual(all.tasks.map(task => task.taskId), ['b-open', 'd-open', 'a-submitted', 'c-claimed']);
  assert.deepEqual(all.tasks.map(task => task.claimable), [true, true, false, false]);
  assert.ok(all.tasks.every(task => task.claimable === (task.claim.state === 'unclaimed')));
  assert.equal(all.claimableCount, 2);
  assert.equal(all.nextCursor, null);
  // A truncated page still reports the full-set count.
  const page = f.service().list({ limit: 1 });
  assert.deepEqual(page.tasks.map(task => task.taskId), ['b-open']);
  assert.equal(page.claimableCount, 2);
  // The single-task read agrees with the list packet.
  assert.equal(f.service().read('b-open').claimable, true);
  assert.equal(f.service().read('a-submitted').claimable, false);
  assert.equal(f.service().read('c-claimed').claimable, false);
});

test('claimable-first ordering paginates consistently: each task exactly once, claimable first', t => {
  const f = mixedFixture(t);
  for (const limit of [1, 2, 3]) {
    const seen = [];
    let after = '';
    for (let guard = 0; guard < 10; guard++) {
      const page = f.service().list({ limit, after });
      seen.push(...page.tasks.map(task => task.taskId));
      if (page.nextCursor === null) break;
      assert.equal(page.nextCursor, page.tasks.at(-1).taskId, 'cursor is the last returned task');
      after = page.nextCursor;
    }
    assert.deepEqual(seen, ['b-open', 'd-open', 'a-submitted', 'c-claimed'], `limit=${limit} walk`);
    assert.equal(new Set(seen).size, seen.length, 'no task repeats across pages');
  }
});

test('claimable filter returns only unclaimed tasks, in order, with consistent paging', t => {
  const f = mixedFixture(t);
  const filtered = f.service().list({ claimable: true });
  assert.deepEqual(filtered.tasks.map(task => task.taskId), ['b-open', 'd-open']);
  assert.ok(filtered.tasks.every(task => task.claimable && task.claim.state === 'unclaimed'));
  assert.equal(filtered.claimableCount, 2);
  const first = f.service().list({ claimable: true, limit: 1 });
  assert.deepEqual(first.tasks.map(task => task.taskId), ['b-open']);
  const rest = f.service().list({ claimable: true, limit: 1, after: first.nextCursor });
  assert.deepEqual(rest.tasks.map(task => task.taskId), ['d-open']);
  assert.equal(rest.nextCursor, null);
});

test('match adds reasonCode no_claimable_tasks only when inspected tasks are all unclaimable', t => {
  const f = fixture(t), [a, b] = f.identities;
  // Nothing to inspect: no reasonCode.
  const empty = f.service().match(null, {});
  assert.equal(empty.inspected, 0);
  assert.deepEqual(empty.recommendations, []);
  assert.equal(Object.hasOwn(empty, 'reasonCode'), false);
  f.enable('only-open');
  // A claimable task exists: recommendations present, no reasonCode.
  const open = f.service().match(null, {});
  assert.equal(open.recommendations.length, 1);
  assert.equal(Object.hasOwn(open, 'reasonCode'), false);
  // Claim and submit everything, then match again.
  f.service().act('only-open', a.secret, 'claim', claim('claim-only'));
  f.service().act('only-open', a.secret, 'finish', owned('finish-only', 1, { artifactText: 'Done', checksReported: [] }));
  f.enable('held-open');
  f.service().act('held-open', b.secret, 'claim', claim('claim-held'));
  const none = f.service().match(null, {});
  assert.deepEqual(none.recommendations, []);
  assert.equal(none.inspected, 2);
  assert.equal(none.reasonCode, 'no_claimable_tasks');
  // Deliberately distinct from the human-readable fields of stale proposals.
  assert.equal(Object.hasOwn(none, 'reason'), false);
  assert.equal(Object.hasOwn(none, 'guidance'), false);
});

// #3649: the board must not advertise claimable work a live claim's path
// fence makes unclaimable. Tasks sharing repository paths with a held task
// are fenced; the claim path's own rule (any declared file overlapping any
// file of a live claim in the namespace) is the only rule the board mirrors.
const code = expected => error => error.code === expected;

function fenceFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-fenced-')), file = join(dir, 'room.sqlite');
  let now = Date.now();
  const store = new RoomStore(file, { now: () => now });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('Fence holder'), store.identities.create('Fence shopper')];
  const service = () => new PublicWorkClaims(store);
  const enable = (id, files, repositoryUrl = 'https://github.com/Example/Project') => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl, reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, identities, enable, advance: ms => { now += ms; } };
}

test('fenced siblings are not advertised claimable: marker on the packet, excluded from claimableCount and the claimable filter', t => {
  const f = fenceFixture(t), [holder, shopper] = f.identities;
  f.enable('held-task', ['docs/shared.md']);
  f.enable('sib-a', ['docs/shared.md']);
  f.enable('sib-b', ['docs/shared.md']);
  f.enable('free-task', ['src/free.js']);
  f.service().act('held-task', holder.secret, 'claim', claim('claim-held'));
  const board = f.service().list();
  const byId = Object.fromEntries(board.tasks.map(task => [task.taskId, task]));
  // The fenced siblings stay listed and unclaimed, but tell the truth.
  for (const id of ['sib-a', 'sib-b']) {
    assert.equal(byId[id].claim.state, 'unclaimed', id);
    assert.equal(byId[id].claimable, false, id);
    assert.equal(byId[id].claim.pathFenced, true, id);
  }
  // The unfenced task carries no marker, and only it counts.
  assert.equal(byId['free-task'].claimable, true);
  assert.equal(Object.hasOwn(byId['free-task'].claim, 'pathFenced'), false);
  assert.equal(byId['held-task'].claimable, false);
  assert.equal(Object.hasOwn(byId['held-task'].claim, 'pathFenced'), false);
  assert.equal(board.claimableCount, 1);
  // The claimable filter and the single-task read agree with the list.
  assert.deepEqual(f.service().list({ claimable: true }).tasks.map(task => task.taskId), ['free-task']);
  assert.equal(f.service().read('sib-a').claimable, false);
  assert.equal(f.service().read('sib-a').claim.pathFenced, true);
  assert.equal(f.service().read('free-task').claimable, true);
  // Enforcement is unchanged: the claim itself still refuses.
  assert.throws(() => f.service().act('sib-a', shopper.secret, 'claim', claim('claim-sib-a')), code('public_work_path_conflict'));
  // match never recommends a fenced task.
  assert.deepEqual(f.service().match(null, {}).recommendations.map(entry => entry.task.taskId), ['free-task']);
});

test('releasing the fencing claim restores sibling claimability', t => {
  const f = fenceFixture(t), [holder, shopper] = f.identities;
  f.enable('held-task', ['docs/shared.md']);
  f.enable('sib-a', ['docs/shared.md']);
  f.service().act('held-task', holder.secret, 'claim', claim('claim-held'));
  assert.equal(f.service().list().claimableCount, 0);
  assert.equal(f.service().match(null, {}).reasonCode, 'no_claimable_tasks');
  f.service().act('held-task', holder.secret, 'release', owned('release-held', 1));
  const board = f.service().list();
  assert.equal(board.claimableCount, 2);
  const sib = board.tasks.find(task => task.taskId === 'sib-a');
  assert.equal(sib.claimable, true);
  assert.equal(Object.hasOwn(sib.claim, 'pathFenced'), false);
  // And the restored advertisement is real: the claim now succeeds.
  const outcome = f.service().act('sib-a', shopper.secret, 'claim', claim('claim-sib-a'));
  assert.equal(outcome.action, 'claimed');
});

test('an expired fencing lease restores sibling claimability without any write', t => {
  const f = fenceFixture(t), [holder, shopper] = f.identities;
  f.enable('held-task', ['docs/shared.md']);
  f.enable('sib-a', ['docs/shared.md']);
  f.service().act('held-task', holder.secret, 'claim', claim('claim-held', { leaseHours: 1 }));
  assert.equal(f.service().list().claimableCount, 0);
  f.advance(61 * 60 * 1000);
  const board = f.service().list();
  assert.equal(board.claimableCount, 2);
  assert.equal(board.tasks.find(task => task.taskId === 'sib-a').claimable, true);
  const outcome = f.service().act('sib-a', shopper.secret, 'claim', claim('claim-sib-a'));
  assert.equal(outcome.action, 'claimed');
});

test('partial overlap follows the claim path rule exactly: any overlapping file fences, disjoint files do not', t => {
  const f = fenceFixture(t), [holder, shopper] = f.identities;
  f.enable('docs-claim', ['docs/guide.md']);
  f.enable('dir-task', ['docs']);
  f.enable('multi-task', ['src/multi.js', 'docs/guide.md']);
  f.enable('sibling-file-task', ['docs/other.md']);
  f.service().act('docs-claim', holder.secret, 'claim', claim('claim-docs'));
  const byId = Object.fromEntries(f.service().list().tasks.map(task => [task.taskId, task]));
  // A declared directory overlapping a claimed file fences (prefix rule).
  assert.equal(byId['dir-task'].claimable, false);
  assert.equal(byId['dir-task'].claim.pathFenced, true);
  // One overlapping file out of several is enough — the claim takes all files.
  assert.equal(byId['multi-task'].claimable, false);
  assert.equal(byId['multi-task'].claim.pathFenced, true);
  // A disjoint file in the same directory is not fenced, and truly claims.
  assert.equal(byId['sibling-file-task'].claimable, true);
  assert.equal(f.service().list().claimableCount, 1);
  const outcome = f.service().act('sibling-file-task', shopper.secret, 'claim', claim('claim-sibling-file'));
  assert.equal(outcome.action, 'claimed');
  assert.throws(() => f.service().act('multi-task', shopper.secret, 'claim', claim('claim-multi')), code('public_work_path_conflict'));
});

test('a claim in another namespace does not fence same-path tasks', t => {
  const f = fenceFixture(t), [holder] = f.identities;
  f.enable('held-task', ['docs/shared.md']);
  f.enable('other-repo-task', ['docs/shared.md'], 'https://github.com/Example/Other');
  f.service().act('held-task', holder.secret, 'claim', claim('claim-held'));
  const other = f.service().read('other-repo-task');
  assert.equal(other.claimable, true);
  assert.equal(Object.hasOwn(other.claim, 'pathFenced'), false);
  assert.equal(f.service().list().claimableCount, 1);
});

async function httpFixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const enable = id => {
    store.projectOffers.create('commons', 'owner', { requestId: `http-create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `http-publish-${id}`, expectedRevision: 1 });
    store.publicWorkClaims.enable('commons', 'owner', id, { requestId: `http-enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`src/${id}.js`] });
  };
  for (const id of ['a-submitted', 'b-open', 'c-claimed']) enable(id);
  const [a, b] = [store.identities.create('HTTP worker one'), store.identities.create('HTTP worker two')];
  store.publicWorkClaims.act('a-submitted', a.secret, 'claim', claim('http-claim-a'));
  store.publicWorkClaims.act('a-submitted', a.secret, 'finish', owned('http-finish-a', 1, { artifactText: 'Done a', checksReported: [] }));
  store.publicWorkClaims.act('c-claimed', b.secret, 'claim', claim('http-claim-c'));
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async path => {
    const response = await fetch(origin + path, { headers: { Origin: origin } });
    return { status: response.status, body: await response.json() };
  };
  return { store, get };
}

test('HTTP list surfaces claimable supply and ?claimable filters it; bad values keep the 422 shape', async t => {
  const f = await httpFixture(t);
  const list = await f.get('/api/public-work/tasks');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.tasks.map(task => task.taskId), ['b-open', 'a-submitted', 'c-claimed']);
  assert.deepEqual(list.body.tasks.map(task => task.claimable), [true, false, false]);
  assert.equal(list.body.claimableCount, 1);
  for (const value of ['1', 'true']) {
    const filtered = await f.get(`/api/public-work/tasks?claimable=${value}`);
    assert.equal(filtered.status, 200, `claimable=${value}`);
    assert.deepEqual(filtered.body.tasks.map(task => task.taskId), ['b-open']);
    assert.equal(filtered.body.claimableCount, 1);
  }
  for (const value of ['0', 'false', 'yes', '']) {
    const rejected = await f.get(`/api/public-work/tasks?claimable=${value}`);
    assert.equal(rejected.status, 422, `claimable=${value} must be rejected`);
    assert.ok(JSON.stringify(rejected.body).includes('invalid_public_work'), `claimable=${value} keeps the invalid_public_work shape`);
  }
  // Unknown parameters are still rejected, and claimable stays list-only.
  const unknown = await f.get('/api/public-work/tasks?state=unclaimed');
  assert.equal(unknown.status, 422);
  const single = await f.get('/api/public-work/tasks/b-open?claimable=1');
  assert.equal(single.status, 422);
});
