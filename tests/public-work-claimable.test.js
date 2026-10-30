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
      assert.equal(page.restarted, undefined, 'a stable board never restarts the walk');
      if (page.nextCursor === null) break;
      // #3606: the browse cursor is an opaque versioned walk cursor whose
      // final segment is the last returned task.
      assert.equal(typeof page.nextCursor, 'string');
      assert.ok(page.nextCursor.endsWith(`:${page.tasks.at(-1).taskId}`), 'cursor carries the last returned task');
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
