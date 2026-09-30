// Matching recommendations and atomic assignment exercised over actual HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  store.projectOffers.create('commons', 'owner', { requestId: 'match-create', offerId: 'http:match', reviewerMemberIds: ['owner'], terms: {
    kind: 'task', title: 'JavaScript improvement', summary: 'Small scoped work', acceptanceCriteria: ['Return exact artifact bytes'], repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' },
  } });
  store.projectOffers.transition('commons', 'owner', 'http:match', 'publish', { requestId: 'match-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'http:match', { requestId: 'match-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/result.js'] });
  const first = store.identities.create('Outside match one'), second = store.identities.create('Outside match two');
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (input, secret) => {
    const response = await fetch(origin + '/api/public-work/match', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  return { store, server, origin, first, second, post };
}

test('anonymous recommendations do not assign; concurrent explicit matches assign at most one and replay the same choice', async t => {
  const f = await fixture(t);
  const snapshot = () => JSON.stringify(['work_claims', 'public_work_requests', 'public_work_claim_writer_permit', 'identity_links'].map(name => f.store.db.prepare(`SELECT * FROM ${name}`).all()));
  const before = snapshot();
  const preview = await f.post({ skills: ['JavaScript'] });
  assert.equal(preview.status, 200); assert.equal(preview.body.claim, null); assert.equal(preview.body.recommendations[0].task.taskId, 'http:match');
  assert.equal(preview.body.nextCursor, null); assert.deepEqual(preview.body.supportedRewards, ['volunteer']); assert.equal(snapshot(), before);
  const unauthorized = await f.post({ autoClaim: true, requestId: 'unauthorized' }); assert.equal(unauthorized.status, 401); assert.equal(snapshot(), before);
  const input = { autoClaim: true, requestId: 'take-one', skills: ['JavaScript'] };
  const pair = await Promise.all([f.post(input, f.first.secret), f.post({ ...input, requestId: 'take-two' }, f.second.secret)]);
  assert.ok(pair.every(result => result.status === 200)); assert.equal(pair.filter(result => result.body.claim).length, 1);
  const index = pair.findIndex(result => result.body.claim), identity = index ? f.second : f.first;
  const used = index ? { ...input, requestId: 'take-two' } : input;
  assert.deepEqual((await f.post(used, identity.secret)).body, pair[index].body);
  assert.equal(f.store.publicWorkClaims.read('http:match').claim.identityId, identity.identityId);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled, 0);
  const changed = await f.post({ ...used, leaseHours: 2 }, identity.secret); assert.equal(changed.status, 409);
});

test('a saved credential revoked while its match body uploads cannot assign work', async t => {
  const f = await fixture(t), payload = JSON.stringify({ requestId: 'revoke-upload', autoClaim: true });
  let arrival;
  const arrived = new Promise(resolve => { arrival = resolve; });
  f.server.once('request', arrival);
  let connection;
  const result = new Promise((resolve, reject) => {
    connection = request(f.origin + '/api/public-work/match', { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${f.first.secret}` } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    connection.on('error', reject); connection.write(payload.slice(0, 10));
  });
  await arrived;
  f.store.identities.revoke(f.first.identityId, f.first.secret);
  connection.end(payload.slice(10));
  assert.equal((await result).status, 401);
  assert.equal(f.store.publicWorkClaims.read('http:match').claim.state, 'unclaimed');
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM public_work_requests WHERE offer_id='@match'").get().n, 0);
  assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled, 0);
});

test('finish accepts the maximum legal escaped artifact plus maximum reported checks', async t => {
  const f = await fixture(t);
  const matched = await f.post({ autoClaim: true, requestId: 'max-artifact-claim' }, f.first.secret);
  const task = matched.body.claim.task;
  const artifactText = '\0'.repeat(65536), checksReported = Array.from({ length: 20 }, () => '\0'.repeat(1000));
  const payload = { requestId: 'max-artifact-finish', expectedTermsVersion: task.termsVersion, generation: task.claim.generation, artifactText, checksReported };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 450560, 'legal escaped input exceeds the earlier transport cap');
  const response = await fetch(f.origin + '/api/public-work/tasks/http%3Amatch/finish', { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${f.first.secret}` }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.receipt.artifact.bytes, 65536); assert.deepEqual(result.receipt.checksReported, checksReported);
  const raw = await fetch(f.origin + '/api/public-work/receipts/' + result.receipt.receiptId + '/artifact');
  assert.equal(Buffer.from(await raw.arrayBuffer()).toString('utf8'), artifactText);
});
