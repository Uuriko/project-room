// FIX-6: client retry discipline for work-claim mutations.
// Fail-first coverage for the three blind-retry failure modes:
//   E5 — a stale duplicate release must not destroy a fresh re-claim;
//   E2 — a release retry loop must terminate on 422/403 (every 4xx terminal);
//   W5 — an ambiguous update outcome must resolve via read-before-retry to exactly one effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createAgentIdentity } from '../client/room-agent.mjs';
import { PublicWorkClaimsClient, withClaimRetryDiscipline } from '../client/public-work-claims.mjs';

async function fixture(t) {
  const clock = Date.now(); const store = new RoomStore(':memory:', { now: () => clock });
  store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const terms = { kind: 'task', title: 'Retry discipline fixture', summary: 'A disposable useful work task', acceptanceCriteria: ['Return exact artifact bytes'], exclusions: [], repositoryUrl: 'https://github.com/Uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'discipline-offer-create', offerId: 'discipline:task', terms, reviewerMemberIds: ['owner'] });
  store.projectOffers.transition('commons', 'owner', 'discipline:task', 'publish', { requestId: 'discipline-offer-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'discipline:task', { requestId: 'discipline-task-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/discipline.js'] });
  const first = await createAgentIdentity(origin, 'Discipline agent one');
  const second = await createAgentIdentity(origin, 'Discipline agent two');
  return { store, origin, first, second,
    publicClient: new PublicWorkClaimsClient({ origin }),
    firstClient: new PublicWorkClaimsClient({ origin, identitySecret: first.secret }),
    secondClient: new PublicWorkClaimsClient({ origin, identitySecret: second.secret }) };
}

// A fetch double in front of the real server. Per action path it can:
//  - { drops: n }: forward the next n POSTs to the server (the mutation lands),
//    drain the response, then throw — the client sees an ambiguous outcome.
//    Later POSTs forward normally.
//  - 'canned-422' / 'canned-403' / 'canned-409': answer the POST without a server.
function interceptingFetch(origin, hooks = {}) {
  const counts = { post: 0, get: 0, postsByPath: {} };
  const canned = status => new Response(JSON.stringify({ error: { code: 'canned_refusal' } }),
    { status, headers: { 'Content-Type': 'application/json' } });
  const impl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const raw = String(url).startsWith(origin) ? String(url).slice(origin.length) : String(url);
    let path = raw; try { path = decodeURIComponent(raw); } catch { /* match on the raw form */ }
    if (method === 'POST') {
      counts.post++; counts.postsByPath[path] = (counts.postsByPath[path] || 0) + 1;
      const hook = hooks[path];
      if (hook && typeof hook === 'object' && hook.drops > 0) {
        hook.drops--;
        const applied = await fetch(url, init); await applied.arrayBuffer().catch(() => {});
        throw new Error('simulated dropped response: outcome ambiguous');
      }
      if (hook === 'canned-422') return canned(422);
      if (hook === 'canned-403') return canned(403);
      if (hook === 'canned-409') return canned(409);
    } else { counts.get++; }
    return fetch(url, init);
  };
  return { impl, counts };
}
const releasePath = '/api/public-work/tasks/discipline:task/release';
const renewPath = '/api/public-work/tasks/discipline:task/renew';

test('E5: stale duplicate release against a fresh re-claim does not destroy it', async t => {
  const f = await fixture(t);
  const claimed = await f.firstClient.claim('discipline:task', { requestId: 'e5-claim', expectedTermsVersion: 1, leaseHours: 1 });
  const generation = claimed.task.claim.generation;
  // Agent A's release applies server-side, but the response never arrives: ambiguous.
  const flaky = interceptingFetch(f.origin, { [releasePath]: { drops: 2 } });
  const releasing = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.first.secret, fetchImpl: flaky.impl });
  await assert.rejects(
    releasing.release('discipline:task', { requestId: 'e5-release', expectedTermsVersion: 1, generation }),
    error => error.code === 'service_unavailable',
    'raw client leaves the caller with an ambiguous outcome and no safe retry');
  // Agent B re-claims the freed task: generation advances, ownership moves.
  const reclaimed = await f.secondClient.claim('discipline:task', { requestId: 'e5-reclaim', expectedTermsVersion: 1 });
  assert.ok(reclaimed.task.claim.generation > generation);
  assert.equal(reclaimed.task.claim.identityId, f.second.identityId);
  // The disciplined retry of A's release: read first, see B's fresh claim,
  // recognize the release already landed, and re-send nothing.
  const outcome = await withClaimRetryDiscipline(releasing, 'discipline:task', 'release',
    { requestId: 'e5-release', expectedTermsVersion: 1, generation }, { identityId: f.first.identityId });
  assert.equal(outcome.action, 'released');
  assert.equal(outcome.replayed, true, 'outcome reconciled from the read, not a fresh 200');
  assert.equal(outcome.attempts, 1, 'no second release POST was issued after the read');
  assert.equal(outcome.task.claim.identityId, f.second.identityId);
  assert.equal(outcome.task.claim.generation, reclaimed.task.claim.generation);
  const current = await f.publicClient.read('discipline:task');
  assert.equal(current.claim.identityId, f.second.identityId, "B's fresh re-claim survives the stale duplicate release");
  assert.equal(current.claim.generation, reclaimed.task.claim.generation);
  assert.equal(flaky.counts.postsByPath[releasePath], 2,
    'one mutating release POST plus one idempotent journal replay; nothing sent after the read decided');
});

test('E2: release retry terminates on 422/403 — every 4xx is terminal', async t => {
  const f = await fixture(t);
  for (const [hook, status] of [['canned-422', 422], ['canned-403', 403], ['canned-409', 409]]) {
    const canned = interceptingFetch(f.origin, { [releasePath]: hook });
    const client = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.first.secret, fetchImpl: canned.impl });
    const failure = await withClaimRetryDiscipline(client, 'discipline:task', 'release',
      { requestId: `e2-release-${status}`, expectedTermsVersion: 1, generation: 1 },
      { identityId: f.first.identityId }).then(
        () => { throw new Error(`expected a terminal ${status}`); },
        error => error);
    assert.equal(failure.status, status, `${status} surfaces to the caller`);
    assert.equal(canned.counts.postsByPath[releasePath], 1, `${status} is terminal: exactly one attempt, no read, no retry`);
    assert.equal(canned.counts.get, 0, `${status} never triggers a confirming read`);
  }
});

test('W5: ambiguous renew + read-before-retry retries the same requestId exactly once', async t => {
  const f = await fixture(t);
  const claimed = await f.firstClient.claim('discipline:task', { requestId: 'w5-claim', expectedTermsVersion: 1, leaseHours: 1 });
  const generation = claimed.task.claim.generation;
  const namespaceId = claimed.task.namespaceId;
  const renewedStamps = () => f.store.workClaims.get(namespaceId, 'discipline:task').history.filter(stamp => stamp.action === 'renewed').length;
  // Document the bug: a blind retry with a FRESH requestId double-applies —
  // the server journals by requestId, so a new id is a new mutation.
  await f.firstClient.renew('discipline:task', { requestId: 'w5-renew-naive-1', expectedTermsVersion: 1, generation, leaseHours: 1 });
  await f.firstClient.renew('discipline:task', { requestId: 'w5-renew-naive-2', expectedTermsVersion: 1, generation, leaseHours: 1 });
  assert.equal(renewedStamps(), 2, 'naive fresh-requestId retry applies the renew twice');
  // The fix: first attempt applies but the response is dropped (ambiguous);
  // the helper reads, sees the claim still held, and retries the SAME request
  // id — the server journal replays the stored outcome instead of re-applying.
  const flaky = interceptingFetch(f.origin, { [renewPath]: { drops: 1 } });
  const renewing = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.first.secret, fetchImpl: flaky.impl });
  const outcome = await withClaimRetryDiscipline(renewing, 'discipline:task', 'renew',
    { requestId: 'w5-renew-disciplined', expectedTermsVersion: 1, generation, leaseHours: 1 },
    { identityId: f.first.identityId });
  assert.equal(outcome.action, 'renewed');
  assert.equal(outcome.attempts, 2, 'one ambiguous attempt plus one same-requestId retry');
  assert.equal(outcome.replayed, false, 'the retry returned the journaled outcome, not a reconciled read');
  assert.equal(flaky.counts.postsByPath[renewPath], 2);
  assert.equal(renewedStamps(), 3, 'exactly one new renew effect across the ambiguous attempt and its retry');
  assert.ok(flaky.counts.get >= 1, 'the retry was preceded by a confirming read');
});
