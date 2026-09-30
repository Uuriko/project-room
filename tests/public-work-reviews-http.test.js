// Receipt-bound review uses actual Room credentials, global identities and HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { PublicWorkClaimsClient } from '../client/public-work-claims.mjs';

const root = '/api/rooms/commons/public-work';
async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'review-add-peer', type: 'member.added', data: { memberId: 'review-peer', displayName: 'Peer', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'review-peer');
  const terms = { kind: 'task', title: 'Review an actual contribution', summary: 'One scoped change', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'review-create', offerId: 'review:offer', terms, reviewerMemberIds: ['owner'] });
  store.projectOffers.transition('commons', 'owner', 'review:offer', 'publish', { requestId: 'review-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'review:offer', { requestId: 'review-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/review.js'] });
  const identity = store.identities.create('Contributor');
  const other = store.identities.create('Other contributor');
  const claimed = store.publicWorkClaims.act('review:offer', identity.secret, 'claim', { requestId: 'review-claim', expectedTermsVersion: 1 });
  const artifactText = '<script>never execute</script>\nactual contribution';
  const { receipt } = store.publicWorkClaims.act('review:offer', identity.secret, 'finish', { requestId: 'review-finish', expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText, checksReported: ['Author-reported check'] });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, data, key = ownerKey, method = data ? 'POST' : 'GET') => fetch(origin + path, { method, headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const decision = (requestId = 'review-decision', decision = 'accepted') => ({ requestId, expectedReviewRevision: 0, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256, decision, reason: 'Feedback for contributor' });
  return { store, ownerKey, peerKey, identity, other, receipt, artifactText, server, origin, call, decision };
}
const read = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };

test('owner retains withdrawn submissions and records one explicit decision without moving rewards or bytes', async t => {
  const f = await fixture(t), before = f.store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n;
  f.store.projectOffers.transition('commons', 'owner', 'review:offer', 'withdraw', { requestId: 'review-withdraw', expectedRevision: 2 });
  const listed = await read(await f.call(root + '/results'));
  assert.equal(listed.results.length, 1); assert.equal(listed.results[0].offer.status, 'withdrawn');
  assert.deepEqual(listed.results[0].receipt, f.receipt);
  const path = root + '/receipts/' + f.receipt.receiptId;
  assert.equal((await read(await f.call(path))).review.revision, 0);
  const input = f.decision(), outcome = await read(await f.call(path + '/decide', input));
  assert.equal(outcome.review.state, 'accepted');
  assert.deepEqual(await read(await f.call(path + '/decide', input)), outcome);
  assert.equal((await f.call(path + '/decide', { ...input, reason: 'Different retry' })).status, 409);
  assert.equal((await f.call(path + '/decide', f.decision('second-decision', 'rejected'))).status, 409);
  assert.deepEqual(await read(await f.call('/api/public-work/receipts/' + f.receipt.receiptId, undefined, null)), f.receipt);
  assert.equal(await (await f.call('/api/public-work/receipts/' + f.receipt.receiptId + '/artifact', undefined, null)).text(), f.artifactText);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n, before);
});

test('only submitting global identity reads sanitized feedback with no room admission or writes', async t => {
  const f = await fixture(t), path = '/api/public-work/receipts/' + f.receipt.receiptId + '/review';
  assert.equal((await f.call(path, undefined, null)).status, 401);
  assert.equal((await f.call(path, undefined, f.other.secret)).status, 404);
  await read(await f.call(root + '/receipts/' + f.receipt.receiptId + '/decide', f.decision()));
  const before = f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n;
  const feedback = await read(await f.call(path, undefined, f.identity.secret));
  assert.equal(feedback.review.state, 'accepted'); assert.equal(feedback.review.reason, 'Feedback for contributor');
  const text = JSON.stringify(feedback);
  for (const name of ['roomId', 'memberId', 'actorId', 'reviewerMemberIds', 'private_links', 'policyFingerprint']) assert.ok(!text.includes('"' + name + '"'), name);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n, before);
  assert.equal(await (await f.call(path, undefined, f.identity.secret, 'HEAD')).text(), '');
  f.store.identities.revoke(f.identity.identityId, f.identity.secret);
  assert.equal((await f.call(path, undefined, f.identity.secret)).status, 401);
});

test('HTTP isolates owner results, review methods and strict query parameters', async t => {
  const f = await fixture(t), path = root + '/receipts/' + f.receipt.receiptId;
  assert.equal((await f.call(root + '/results', undefined, null)).status, 401);
  assert.equal((await f.call(root + '/results', undefined, f.peerKey)).status, 403);
  assert.equal((await f.call(path, undefined, f.peerKey)).status, 403);
  assert.equal((await f.call(path + '/decide', f.decision(), f.peerKey)).status, 403);
  assert.equal((await f.call(path + '/decide')).status, 405);
  assert.equal((await f.call(root + '/results', {}, f.ownerKey)).status, 405);
  assert.equal((await f.call(root + '/results?limit=1&limit=2')).status, 422);
  assert.equal((await f.call(root + '/results?auth=room')).status, 200);
  assert.equal((await f.call(root + '/results?auth=account&auth=room')).status, 422);
  assert.equal((await f.call(path + '?after=x')).status, 422);
  assert.equal(await (await f.call(root + '/results', undefined, f.ownerKey, 'HEAD')).text(), '');
});

test('two exact-version review decisions race through one persisted authority', async t => {
  const f = await fixture(t), path = root + '/receipts/' + f.receipt.receiptId + '/decide';
  const responses = await Promise.all([f.call(path, f.decision('race-a')), f.call(path, f.decision('race-b', 'rejected'))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_reviews').get().n, 1);
});

test('revoked Room credential during an uploaded decision cannot commit review or journal', async t => {
  const f = await fixture(t), payload = JSON.stringify(f.decision());
  let arrive; const arrived = new Promise(resolve => { arrive = resolve; }); f.server.once('request', arrive);
  let connection;
  const result = new Promise((resolve, reject) => {
    connection = request(f.origin + root + '/receipts/' + f.receipt.receiptId + '/decide', { method: 'POST', headers: { Origin: f.origin, Authorization: `Bearer ${f.ownerKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    connection.on('error', reject); connection.write(payload.slice(0, 1));
  });
  await arrived; f.store.revoke(f.ownerKey); connection.end(payload.slice(1));
  assert.equal(await result, 401);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_reviews').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n, 0);
});


test('saved-identity client reads its receipt-bound review and refuses a different contributor', async t => {
  const f = await fixture(t);
  const client = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.identity.secret });
  assert.equal((await client.readReview(f.receipt)).review.state, 'pending');
  await read(await f.call(root + '/receipts/' + f.receipt.receiptId + '/decide', f.decision()));
  const feedback = await client.readReview(f.receipt);
  assert.equal(feedback.review.state, 'accepted'); assert.equal(feedback.artifactSha256, f.receipt.artifact.sha256);
  const other = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.other.secret });
  await assert.rejects(other.readReview(f.receipt), error => error.status === 404);
  const anonymous = new PublicWorkClaimsClient({ origin: f.origin });
  await assert.rejects(anonymous.readReview(f.receipt), error => error.code === 'identity_required');
});
