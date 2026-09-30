// Owner/public HTTP boundary: disposable global identities never join a Room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createAgentIdentity } from '../client/room-agent.mjs';
import { PublicWorkClaimsClient } from '../client/public-work-claims.mjs';
async function fixture(t) {
  let clock = Date.now(); const store = new RoomStore(':memory:', { now: () => clock });
  store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const terms = { kind: 'task', title: 'Public contribution', summary: 'A disposable useful work task', acceptanceCriteria: ['Return exact artifact bytes'], exclusions: [], repositoryUrl: 'https://github.com/Uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'client-offer-create', offerId: 'client:task', terms, reviewerMemberIds: ['owner'] });
  store.projectOffers.transition('commons', 'owner', 'client:task', 'publish', { requestId: 'client-offer-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'client:task', { requestId: 'client-task-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/public-contribution.js'] });
  const first = await createAgentIdentity(origin, 'Synthetic outside contributor one');
  const second = await createAgentIdentity(origin, 'Synthetic outside contributor two');
  return { store, origin, first, second, advance: ms => { clock += ms; }, publicClient: new PublicWorkClaimsClient({ origin }),
    firstClient: new PublicWorkClaimsClient({ origin, identitySecret: first.secret }), secondClient: new PublicWorkClaimsClient({ origin, identitySecret: second.secret }) };
}
test('cold public task to leased outside claim, reclaim and independently fetched hash-only artifact', async t => {
  const f = await fixture(t);
  const initial = await f.publicClient.read('client:task');
  assert.equal(initial.claim.state, 'unclaimed'); assert.deepEqual(initial.files, ['src/public-contribution.js']);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE identity_id IN (?,?)').get(f.first.identityId, f.second.identityId).n, 0);
  const input = { requestId: 'outside-one-claim', expectedTermsVersion: 1, leaseHours: 1 };
  const claimed = await f.firstClient.claim('client:task', input);
  assert.equal(claimed.task.claim.identityId, f.first.identityId); assert.equal(claimed.task.claim.state, 'claimed');
  assert.deepEqual(await f.firstClient.claim('client:task', input), claimed, 'unknown-response replay retains exact receipt');
  await assert.rejects(f.secondClient.claim('client:task', { ...input, requestId: 'outside-two-conflict' }), error => error.status === 409);
  const generation = claimed.task.claim.generation;
  const renewed = await f.firstClient.renew('client:task', { requestId: 'outside-one-renew', expectedTermsVersion: 1, generation, leaseHours: 1 });
  assert.equal(renewed.action, 'renewed');
  await assert.rejects(f.secondClient.release('client:task', { requestId: 'wrong-release', expectedTermsVersion: 1, generation }), error => [403, 409].includes(error.status));
  f.advance(3600001);
  const reclaimed = await f.secondClient.claim('client:task', { requestId: 'outside-two-reclaim', expectedTermsVersion: 1 });
  assert.ok(reclaimed.task.claim.generation > generation);
  const prefix = 'A real UTF-8 contribution: 雪 🧪\n';
  const artifactText = prefix + '\0'.repeat(65536 - Buffer.byteLength(prefix, 'utf8'));
  const finish = { requestId: 'outside-two-finish', expectedTermsVersion: 1, generation: reclaimed.task.claim.generation, artifactText, checksReported: ['Synthetic check reported, not independently verified'] };
  await assert.rejects(f.firstClient.finish('client:task', { ...finish, requestId: 'stale-finish', generation }), error => [403, 409].includes(error.status));
  const submitted = await f.secondClient.finish('client:task', finish);
  assert.equal(submitted.action, 'submitted'); assert.equal(submitted.receipt.verification, 'hash_only');
  assert.deepEqual(await f.secondClient.finish('client:task', finish), submitted);
  const publicReceipt = await f.publicClient.readReceipt(submitted.receipt.receiptId);
  assert.deepEqual(publicReceipt, submitted.receipt);
  const artifact = await f.publicClient.readArtifact(publicReceipt);
  assert.equal(artifact.text, artifactText); assert.equal(artifact.bytes, Buffer.byteLength(artifactText, 'utf8'));
  assert.equal(artifact.sha256, createHash('sha256').update(artifactText, 'utf8').digest('hex'));
  // A real HTTP intermediary changes one artifact byte after publication.
  let forwardedAuthorization;
  const proxy = createServer(async (request, response) => {
    forwardedAuthorization = request.headers.authorization;
    const upstream = await fetch(f.origin + request.url, { redirect: 'error', credentials: 'omit' });
    const changed = Buffer.from(await upstream.arrayBuffer()); changed[0] ^= 1;
    response.writeHead(upstream.status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(changed);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const intermediary = new PublicWorkClaimsClient({ origin: `http://127.0.0.1:${proxy.address().port}`, identitySecret: f.first.secret });
  await assert.rejects(intermediary.readArtifact(publicReceipt), error => error.code === 'artifact_mismatch');
  assert.equal(forwardedAuthorization, undefined, 'public artifact reads never carry the saved credential');
  const serialized = JSON.stringify({ initial, submitted, publicReceipt, artifact });
  for (const secret of [f.first.secret, f.second.secret, 'reviewerMemberIds', 'roomId']) assert.equal(serialized.includes(secret), false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE identity_id IN (?,?)').get(f.first.identityId, f.second.identityId).n, 0);
});

test('explicit release returns task to another outside identity without granting room membership', async t => {
  const f = await fixture(t);
  const first = await f.firstClient.claim('client:task', { requestId: 'release-claim', expectedTermsVersion: 1 });
  const input = { requestId: 'release-own', expectedTermsVersion: 1, generation: first.task.claim.generation };
  const released = await f.firstClient.release('client:task', input);
  assert.equal(released.task.claim.state, 'unclaimed'); assert.deepEqual(await f.firstClient.release('client:task', input), released);
  const next = await f.secondClient.claim('client:task', { requestId: 'claim-after-release', expectedTermsVersion: 1 });
  assert.ok(next.task.claim.generation > first.task.claim.generation);
});


test('a claim response redirect cannot forward credentials or invoke a second path', async t => {
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url.endsWith('/claim')) { response.writeHead(307, { Location: '/unexpected-action' }); response.end(); }
    else { redirected++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = new PublicWorkClaimsClient({ origin: `http://127.0.0.1:${server.address().port}`, identitySecret: 'pri_' + 'synthetic'.repeat(8) });
  let failure;
  await assert.rejects(client.claim('task-one', { requestId: 'redirect-claim', expectedTermsVersion: 1 }), error => { failure = error; return true; });
  assert.equal(redirected, 0, 'never resend the authenticated mutation to a redirect target');
  assert.equal(failure.code, 'service_unavailable');
});


test('anonymous recommendations and explicitly atomic find-and-claim preserve server replay choice', async t => {
  const f = await fixture(t);
  const suggestions = await f.publicClient.match({ skills: ['artifact'], limit: 1 });
  assert.equal(suggestions.claim, null); assert.equal(suggestions.recommendations[0].task.taskId, 'client:task');
  assert.equal((await f.publicClient.read('client:task')).claim.state, 'unclaimed');
  const input = { requestId: 'explicit-match-one', skills: ['artifact'], autoClaim: true, limit: 1 };
  const result = await f.firstClient.match(input);
  assert.equal(result.claim.task.claim.identityId, f.first.identityId);
  assert.deepEqual(await f.firstClient.match(input), result);
  await assert.rejects(f.firstClient.match({ ...input, reward: 'cash' }), error => error.status === 409);
  assert.deepEqual((await f.publicClient.match({ reward: 'cash' })).recommendations, []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE identity_id=?').get(f.first.identityId).n, 0);
});

test('maximum legal matching packets remain readable within a bounded response', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const id = `a-wide-${i}`;
    const terms = { kind: 'task', title: `Maximum public packet ${i}`, summary: 'A bounded public contribution', acceptanceCriteria: Array.from({ length: 20 }, () => '雪'.repeat(1000)), repositoryUrl: 'https://github.com/Uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
    f.store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, terms, reviewerMemberIds: ['owner'] });
    f.store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    f.store.publicWorkClaims.enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: Array.from({ length: 64 }, (_, j) => `scope-${i}/file-${j}-` + '雪'.repeat(490)) });
  }
  const result = await f.publicClient.match({ limit: 5 });
  assert.equal(result.recommendations.length, 5);
  const maximum = result.recommendations.find(item => item.task.acceptanceCriteria.length === 20).task;
  assert.equal(maximum.files.length, 64);
  assert.equal(maximum.acceptanceCriteria[19], '雪'.repeat(1000));
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') > 262144);
});

test('saved-identity feedback rejects malformed or private follow-up pointers from an HTTP intermediary', async t => {
  const f = await fixture(t);
  const claim = await f.firstClient.claim('client:task', { requestId: 'pointer-claim', expectedTermsVersion: 1 });
  const { receipt } = await f.firstClient.finish('client:task', { requestId: 'pointer-finish', expectedTermsVersion: 1, generation: claim.task.claim.generation, artifactText: 'Original pointer fixture', checksReported: [] });
  const binding = { taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256 };
  f.store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, { ...binding, requestId: 'pointer-revision', expectedReviewRevision: 0, decision: 'revision_requested', reason: 'Original contributor feedback' });
  f.store.publicWorkSuccessors.create('commons', 'owner', receipt.receiptId, { ...binding, requestId: 'pointer-follow-up', expectedReviewRevision: 1, successorTaskId: 'client:follow-up', terms: { kind: 'task', title: 'Explicit follow-up', summary: 'Public instructions', acceptanceCriteria: ['Return new bytes'], repositoryUrl: 'https://github.com/Uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } }, repositoryRef: 'main', files: ['src/public-contribution.js'] });
  assert.deepEqual((await f.firstClient.readReview(receipt)).followUp, { taskId: 'client:follow-up', termsVersion: 1, available: true });
  let pointer;
  const proxy = createServer(async (request, response) => {
    const upstream = await fetch(f.origin + request.url, { headers: { Authorization: request.headers.authorization }, redirect: 'error', credentials: 'omit' });
    const feedback = await upstream.json(); feedback.followUp = pointer;
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(feedback));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const intercepted = new PublicWorkClaimsClient({ origin: `http://127.0.0.1:${proxy.address().port}`, identitySecret: f.first.secret });
  for (pointer of [null, {}, { taskId: 'child', termsVersion: 1 }, { taskId: 'child', termsVersion: 0, available: true }, { taskId: 'child', termsVersion: 1, available: 'true' }, { taskId: 'child', termsVersion: 1, available: true, roomId: 'private' }]) {
    await assert.rejects(intercepted.readReview(receipt), error => error.code === 'invalid_response');
  }
});
