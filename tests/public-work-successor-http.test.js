import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { PublicWorkClaimsClient } from '../client/public-work-claims.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'follow-peer', type: 'member.added', data: { memberId: 'peer', displayName: 'Peer', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'peer');
  const terms = { kind: 'task', title: 'Original public task', summary: 'Explicit public instructions', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'parent-create', offerId: 'follow:parent', terms, reviewerMemberIds: ['owner'] });
  store.projectOffers.transition('commons', 'owner', 'follow:parent', 'publish', { requestId: 'parent-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'follow:parent', { requestId: 'parent-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/result.js'] });
  const producer = store.identities.create('Original contributor'), other = store.identities.create('Follow-up contributor');
  const claimed = store.publicWorkClaims.act('follow:parent', producer.secret, 'claim', { requestId: 'parent-claim', expectedTermsVersion: 1 });
  const { receipt } = store.publicWorkClaims.act('follow:parent', producer.secret, 'finish', { requestId: 'parent-finish', expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText: 'Immutable original artifact', checksReported: [] });
  const binding = { taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256 };
  store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, { ...binding, requestId: 'ask-revision', expectedReviewRevision: 0, decision: 'revision_requested', reason: 'Private feedback must not become public instructions' });
  const input = { ...binding, requestId: 'publish-follow-up', expectedReviewRevision: 1, successorTaskId: 'follow:child', terms: { ...terms, title: 'Owner-authored follow-up' }, repositoryRef: 'main', files: ['src/result.js'] };
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = `/api/rooms/commons/public-work/receipts/${receipt.receiptId}/follow-up`;
  const call = (data = input, key = ownerKey, method = 'POST', suffix = '') => fetch(origin + path + suffix, { method, headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(data) } : {}) });
  const snapshot = () => Object.fromEntries(['project_offers', 'project_offer_requests', 'public_work_successors', 'public_work_successor_requests', 'public_work_reviews', 'public_work_review_requests', 'identity_links', 'bounty_journal'].map(name => [name, store.db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all()]));
  return { store, ownerKey, peerKey, producer, other, receipt, input, server, origin, path, call, snapshot };
}
async function json(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }

test('owner HTTP publication leads to saved-identity follow-up claim and a fresh review without altering the parent', async t => {
  const f = await fixture(t), before = f.snapshot();
  const created = await json(await f.call());
  assert.equal(created.task.claim.state, 'unclaimed');
  assert.equal(JSON.stringify(created.task).includes('Private feedback'), false);
  assert.deepEqual(await json(await f.call()), created);
  const client = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.producer.secret });
  assert.deepEqual((await client.readReview(f.receipt)).followUp, created.followUp);
  const other = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.other.secret });
  const child = await other.claim(created.task.taskId, { requestId: 'child-claim', expectedTermsVersion: 1 });
  const finished = await other.finish(created.task.taskId, { requestId: 'child-finish', expectedTermsVersion: 1, generation: child.task.claim.generation, artifactText: 'New independent artifact', checksReported: [] });
  assert.equal((await other.readReview(finished.receipt)).review.state, 'pending');
  assert.deepEqual(await client.readReceipt(f.receipt.receiptId), f.receipt);
  assert.equal((await client.readArtifact(f.receipt)).text, 'Immutable original artifact');
  for (const table of ['public_work_reviews', 'public_work_review_requests', 'identity_links', 'bounty_journal']) assert.deepEqual(f.snapshot()[table], before[table], table);
  await assert.rejects(other.readReview(f.receipt), error => error.status === 404);
  f.store.projectOffers.transition('commons', 'owner', 'follow:child', 'withdraw', { requestId: 'withdraw-child', expectedRevision: 2 });
  assert.equal((await client.readReview(f.receipt)).followUp.available, false);
  assert.deepEqual(await json(await f.call()), created, 'exact retry records original creation, not current availability');
});

test('owner follow-up HTTP rejects unauthorized, stale and ambiguous requests without writes', async t => {
  const f = await fixture(t), before = f.snapshot();
  for (const [data, key, status, suffix] of [[f.input, null, 401, ''], [f.input, f.peerKey, 403, ''], [{ ...f.input, expectedReviewRevision: 2 }, f.ownerKey, 409, ''], [{ ...f.input, extra: true }, f.ownerKey, 422, ''], [f.input, f.ownerKey, 422, '?auth=room&auth=room']]) {
    await json(await f.call(data, key, 'POST', suffix), status); assert.deepEqual(f.snapshot(), before);
  }
  const get = await f.call(undefined, f.ownerKey, 'GET'); assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  await json(await f.call());
  const created = f.snapshot();
  await json(await f.call({ ...f.input, terms: { ...f.input.terms, title: 'Changed replay' } }), 409);
  await json(await f.call({ ...f.input, requestId: 'rival-follow-up', successorTaskId: 'follow:rival' }), 409);
  assert.deepEqual(f.snapshot(), created);
});

test('revocation during an uploaded follow-up body blocks publication and journal insertion', async t => {
  const f = await fixture(t), before = f.snapshot(), payload = JSON.stringify(f.input);
  let arrive; const arrived = new Promise(resolve => { arrive = resolve; }); f.server.once('request', arrive);
  let connection;
  const result = new Promise((resolve, reject) => {
    connection = request(f.origin + f.path, { method: 'POST', headers: { Origin: f.origin, Authorization: `Bearer ${f.ownerKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    connection.on('error', reject); connection.write(payload.slice(0, 1));
  });
  await arrived; f.store.revoke(f.ownerKey); connection.end(payload.slice(1));
  assert.equal(await result, 401); assert.deepEqual(f.snapshot(), before);
});
