// claim-prs FAILING on prod 86fc24a1 (2026-10-19, room 15509): from 10:42:59Z
// every tick ended "unsupported public claim writer: SQLITE_CONSTRAINT_TRIGGER".
// The public-work claim fence (public-work-claim-fence.mjs) aborts any
// work_claims write in a public_work_tasks namespace outside
// withPublicWorkClaimWriter. The claim/PR reconcilers (claim-pr-sync,
// claim-autolink) walk every room's claims and wrote bare rows, so one
// public-work claim with a lapsed lease or a PR link aborted the whole tick
// for every room. Reconcilers skip public-work namespaces (Fo 15510): they
// must not mutate public-work mirrors, and they keep working for every
// private room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';
import { createDurableWorkClaimRegistry } from '../server/work-claim-sqlite.mjs';
import { withPublicWorkClaimWriter } from '../server/public-work-claim-fence.mjs';
import { syncClaimPullRequests, sweepStaleUnclaimedClaims, applyPullRequestWebhook } from '../server/claim-pr-sync.mjs';
import { autoLinkPullRequest, linkDeployToSettledClaims } from '../server/claim-autolink.mjs';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 19, 10, 43, 0);
const PR = 'https://github.com/Uuriko/project-room/pull/4999';
const REV = '86fc24a18a8c2e207a2a2b1de37eb31213f67215';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claim-sync-public-'));
  const store = new RoomStore(join(dir, 'room.sqlite')); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const offerId = 'public-sync';
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId, reviewerMemberIds: ['owner'],
    terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'project', title: 'Sync proof',
      summary: 'Disposable public task', acceptanceCriteria: ['Return an artifact'], reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: 'publish', expectedRevision: 1 });
  const registry = createDurableWorkClaimRegistry(store.db);
  const task = store.publicWorkClaims.enable('commons', 'owner', offerId, {
    requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/public-proof.js'] });
  const ns = task.namespaceId;
  // A public-work claim whose lease lapsed and which carries a PR link: the
  // shape every reconciler phase touches. Written the only legal way.
  const lapsed = claimWork(createWork({ id: 'pub-lapsed', title: 'Public lapsed' }, { now: NOW - 3 * HOUR, agentId: 'alice' }),
    'alice', { now: NOW - 3 * HOUR, leaseHours: 1 });
  const live = claimWork(createWork({ id: 'pub-live', title: 'Public live' }, { now: NOW, agentId: 'alice' }), 'alice', { now: NOW, leaseHours: 6 });
  const done = { ...claimWork(createWork({ id: 'pub-done', title: 'Public done' }, { now: NOW - HOUR, agentId: 'alice' }), 'alice', { now: NOW - HOUR, leaseHours: 6 }),
    state: 'done', revision: REV };
  withPublicWorkClaimWriter(store, () => {
    registry.set(ns, { ...lapsed, pullRequests: [{ url: PR }] });
    registry.set(ns, live);
    registry.set(ns, done);
  });
  // The same shape in a private room must still be reconciled.
  const priv = claimWork(createWork({ id: 'priv-lapsed', title: 'Private lapsed' }, { now: NOW - 3 * HOUR, agentId: 'alice' }),
    'alice', { now: NOW - 3 * HOUR, leaseHours: 1 });
  store.workClaims.set('commons', { ...priv, pullRequests: [{ url: PR }] });
  const snapshot = () => store.db.prepare('SELECT * FROM work_claims WHERE room_id=? ORDER BY claim_id').all(ns);
  return { store, ns, snapshot };
}

const noFetch = async () => { throw new Error('no network in this test'); };

test('a claim-prs tick with a lapsed public-work claim does not abort, and still releases private rooms', async t => {
  const { store, snapshot } = fixture(t);
  const before = snapshot();
  const result = await syncClaimPullRequests(store, { token: null, fetchImpl: noFetch, nowMs: NOW });
  assert.ok(!result.housekeepingStarved, 'housekeeping finished');
  assert.equal(store.workClaims.get('commons', 'priv-lapsed').state, 'unclaimed', 'the private lapsed lease is released');
  assert.deepEqual(snapshot(), before, 'the public-work mirror is untouched');
});

test('stale sweep, PR webhook and autolink skip public-work namespaces instead of throwing', t => {
  const { store, ns, snapshot } = fixture(t);
  const before = snapshot();
  assert.doesNotThrow(() => sweepStaleUnclaimedClaims(store, NOW + 400 * 24 * HOUR, { force: true }));
  assert.doesNotThrow(() => applyPullRequestWebhook(store, {
    action: 'closed', pull_request: { html_url: PR, merged: true, merged_at: new Date(NOW).toISOString() } }, { nowMs: NOW }));
  assert.doesNotThrow(() => autoLinkPullRequest(store, ns, 'pub-live', { url: 'https://github.com/Uuriko/project-room/pull/5000', source: 'test' }, { nowMs: NOW }));
  assert.doesNotThrow(() => linkDeployToSettledClaims(store, { revision: REV, nowMs: NOW }));
  assert.deepEqual(snapshot(), before, 'the public-work mirror is untouched');
});
