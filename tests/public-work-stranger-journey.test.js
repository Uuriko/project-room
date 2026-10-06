// Stranger journey over real HTTP: anonymous discovery -> identity mint ->
// read -> claim -> finish -> receipt + artifact verification.
//
// Guards the 2026-10-05 user-testing p2/p3 contract: the "find work without
// joining" path must surface unclaimed volunteer tasks (not a dead end), and
// tasks in submitted state must be excluded from recommendations while still
// listed for inspection. No existing test walks the full stranger loop with
// receipt byte verification in one flow (public-work-match-http covers match
// mechanics; public-work-claims covers claims; none covers discover->mint->
// claim->finish->receipt->artifact end to end).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function seedOffer(store, offerId, { title, criteria }) {
  store.projectOffers.create('commons', 'owner', { requestId: `journey-create-${offerId}`, offerId,
    reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title, summary: 'Volunteer stranger-journey fixture', acceptanceCriteria: criteria,
      repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: `journey-publish-${offerId}`, expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', offerId, { requestId: `journey-enable-${offerId}`,
    expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['docs/JOURNEY.md'] });
}

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  seedOffer(store, 'journey:open', { title: 'Journey fixture open task', criteria: ['Return exact artifact bytes'] });
  seedOffer(store, 'journey:submitted', { title: 'Journey fixture finished task', criteria: ['Already delivered work'] });
  // Put journey:submitted into the terminal submitted state a real delivery leaves.
  const finisher = store.identities.create('Journey finisher');
  const read = store.publicWorkClaims.read('journey:submitted');
  const claimed = store.publicWorkClaims.act('journey:submitted', finisher.secret, 'claim',
    { requestId: 'journey-pre-claim', expectedTermsVersion: read.termsVersion, leaseHours: 1 });
  store.publicWorkClaims.act('journey:submitted', finisher.secret, 'finish',
    { requestId: 'journey-pre-finish', expectedTermsVersion: read.termsVersion, generation: claimed.task.claim.generation,
      artifactText: 'prior delivery', checksReported: ['prior checks'] });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
  };
  return { store, origin, call };
}

test('anonymous discovery recommends unclaimed volunteer tasks and excludes submitted ones', async t => {
  const f = await fixture(t);
  const match = await f.call('POST', '/api/public-work/match', { body: { interests: ['docs'], limit: 5 } });
  assert.equal(match.status, 200);
  const ids = match.body.recommendations.map(r => r.task.taskId);
  assert.ok(ids.includes('journey:open'), 'unclaimed task is recommended');
  assert.ok(!ids.includes('journey:submitted'), 'submitted task is never recommended');
  assert.deepEqual(match.body.supportedRewards, ['volunteer']);
  const list = await f.call('GET', '/api/public-work/tasks?limit=20');
  assert.equal(list.status, 200);
  const states = Object.fromEntries(list.body.tasks.map(task => [task.taskId, task.claim.state]));
  assert.equal(states['journey:open'], 'unclaimed');
  assert.equal(states['journey:submitted'], 'submitted');
});

test('stranger journey: mint identity, read, claim, finish, verify receipt and artifact bytes', async t => {
  const f = await fixture(t);
  // 1. Stranger mints a global identity with no room membership.
  const minted = await f.call('POST', '/api/agent-identities', { body: { displayName: 'QA-stranger-journey' } });
  assert.equal(minted.status, 201);
  const secret = minted.body.secret;
  assert.ok(typeof secret === 'string' && secret.length > 0, 'mint returns a usable secret');
  // 2. Read the task terms before claiming.
  const taskPath = '/api/public-work/tasks/journey%3Aopen';
  const read = await f.call('GET', taskPath);
  assert.equal(read.status, 200);
  assert.equal(read.body.claim.state, 'unclaimed');
  // 3. Claim with the saved identity.
  const claim = await f.call('POST', taskPath + '/claim', { secret,
    body: { requestId: 'journey-claim', expectedTermsVersion: read.body.termsVersion, leaseHours: 1 } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body).slice(0, 200));
  assert.equal(claim.body.action, 'claimed');
  const generation = claim.body.task.claim.generation;
  // 4. Do the work and submit the artifact.
  const artifactText = 'Stranger contribution: verified journey artifact.\n';
  const finish = await f.call('POST', taskPath + '/finish', { secret,
    body: { requestId: 'journey-finish', expectedTermsVersion: read.body.termsVersion, generation, artifactText, checksReported: ['ran the task checks'] } });
  assert.equal(finish.status, 200, JSON.stringify(finish.body).slice(0, 200));
  assert.equal(finish.body.action, 'submitted');
  const receipt = finish.body.receipt;
  assert.ok(receipt.receiptId.startsWith('pwr_'));
  assert.equal(receipt.artifact.sha256, sha256(artifactText));
  // 5. Verify the receipt and its bytes independently, anonymously.
  const fetched = await f.call('GET', '/api/public-work/receipts/' + receipt.receiptId);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.receiptId, receipt.receiptId);
  const artifact = await f.call('GET', '/api/public-work/receipts/' + receipt.receiptId + '/artifact');
  assert.equal(artifact.status, 200);
  const bytes = Buffer.from(artifact.body).toString('utf8');
  assert.equal(bytes, artifactText);
  assert.equal(sha256(bytes), fetched.body.artifact.sha256);
  // 6. The delivered task leaves the recommendation pool.
  const after = await f.call('POST', '/api/public-work/match', { body: { limit: 5 } });
  assert.equal(after.status, 200);
  assert.ok(!after.body.recommendations.some(r => r.task.taskId === 'journey:open'), 'submitted task leaves recommendations');
});
