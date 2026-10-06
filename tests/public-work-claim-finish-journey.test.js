// Seeded public-work claim/finish journey over real HTTP: a fresh agent
// identity claims a public work item, does the work, finishes it, and the
// receipt is published to the public receipts listing.
//
// Guards the lifecycle contract the stranger journey does not: claim puts
// the work item in_progress (not merely claimed at the task surface), finish
// leaves the work item done, and the receipt becomes visible on the PUBLIC
// listing surfaces (/api/public/receipts and /receipts) — anonymously, with
// no room membership. A finish that succeeds but fails to project the
// receipt publicly must fail this test; so must a claim that never moves
// past unclaimed, or a finish that leaves the item unfinished.
//
// All data is seeded: in-memory RoomStore, one offer published and enabled
// for public claims, one minted identity. No dependence on live room state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const TASK_ID = 'pwj:open';

function seedOffer(store) {
  store.projectOffers.create('commons', 'owner', { requestId: 'pwj-create', offerId: TASK_ID,
    reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'Journey fixture: write the one-paragraph history', summary: 'Seeded volunteer task for the claim/finish journey test', acceptanceCriteria: ['One truthful paragraph about the repository'],
      repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', TASK_ID, 'publish', { requestId: 'pwj-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', TASK_ID, { requestId: 'pwj-enable',
    expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['docs/HISTORY.md'] });
}

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  seedOffer(store);
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const isJson = response.headers.get('content-type')?.includes('json');
    return { status: response.status, body: isJson ? await response.json() : await response.text() };
  };
  return { store, origin, call };
}

test('seeded journey: fresh identity claims, works, finishes, receipt goes public', async t => {
  const f = await fixture(t);
  const taskPath = `/api/public-work/tasks/${encodeURIComponent(TASK_ID)}`;

  // 1. A fresh agent identity mints itself; nothing exists for it anywhere.
  const minted = await f.call('POST', '/api/agent-identities', { body: { displayName: 'qa-pwj-agent' } });
  assert.equal(minted.status, 201, JSON.stringify(minted.body).slice(0, 200));
  const secret = minted.body.secret;
  assert.ok(typeof secret === 'string' && secret.length > 0, 'mint returns a usable secret');

  // 2. The seeded task is unclaimed, and its receipt is not yet on the public listing.
  const read = await f.call('GET', taskPath);
  assert.equal(read.status, 200);
  assert.equal(read.body.claim.state, 'unclaimed');
  const termsVersion = read.body.termsVersion;
  const namespaceId = read.body.namespaceId;
  const before = await f.call('GET', '/api/public/receipts?limit=20');
  assert.equal(before.status, 200);
  assert.ok(!before.body.receipts.some(r => r.title === read.body.title), 'no receipt before the work is done');

  // 3. Claim: the agent holds the task and the work item moves in_progress.
  const claim = await f.call('POST', taskPath + '/claim', { secret,
    body: { requestId: 'pwj-claim', expectedTermsVersion: termsVersion, leaseHours: 1 } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body).slice(0, 200));
  assert.equal(claim.body.action, 'claimed');
  const generation = claim.body.task.claim.generation;
  const inProgress = f.store.workClaims.get(namespaceId, TASK_ID);
  assert.equal(inProgress.state, 'in_progress', 'claimed work item is in_progress while the agent works');
  assert.equal(inProgress.owner, minted.body.identityId);
  const midClaim = await f.call('GET', taskPath);
  assert.equal(midClaim.status, 200);
  assert.equal(midClaim.body.claim.state, 'claimed');
  assert.ok(midClaim.body.claim.leaseExpiresAt, 'claim carries a lease expiry');

  // 4. The agent does the work and finishes: artifact bytes + reported checks.
  const artifactText = 'The repository began as a sketch on a whiteboard.\n';
  const finish = await f.call('POST', taskPath + '/finish', { secret,
    body: { requestId: 'pwj-finish', expectedTermsVersion: termsVersion, generation, artifactText, checksReported: ['proofread the paragraph'] } });
  assert.equal(finish.status, 200, JSON.stringify(finish.body).slice(0, 200));
  assert.equal(finish.body.action, 'submitted');
  const receipt = finish.body.receipt;
  assert.ok(receipt.receiptId.startsWith('pwr_'));
  assert.equal(receipt.artifact.sha256, sha256(artifactText));
  assert.equal(finish.body.task.claim.state, 'submitted');
  assert.equal(finish.body.task.claim.submittedReceiptId, receipt.receiptId);
  const done = f.store.workClaims.get(namespaceId, TASK_ID);
  assert.equal(done.state, 'done', 'finished work item is done');

  // 5. The receipt is published: visible anonymously on the public receipts
  // listing, the HTML receipts page, and the public receipt detail page.
  const listed = await f.call('GET', '/api/public/receipts?limit=20');
  assert.equal(listed.status, 200);
  const entry = listed.body.receipts.find(r => r.id === receipt.receiptId);
  assert.ok(entry, 'submitted receipt appears on the public receipts listing');
  assert.equal(entry.source, 'public-work');
  assert.ok((entry.agents ?? []).some(a => String(a).includes('qa-pwj-agent')), 'receipt credits the finishing agent');
  const page = await f.call('GET', '/receipts');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(receipt.receiptId) || page.body.includes('Journey fixture: write the one-paragraph history'),
    'receipt is visible on the public /receipts page');
  const detail = await f.call('GET', `/receipts/${receipt.receiptId}.json`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, receipt.receiptId);

  // 6. The artifact bytes verify against the receipt hash.
  const artifact = await f.call('GET', '/api/public-work/receipts/' + receipt.receiptId + '/artifact');
  assert.equal(artifact.status, 200);
  assert.equal(sha256(artifact.body), receipt.artifact.sha256);

  // 7. A second claim on the finished task is refused: the journey is terminal.
  const second = await f.call('POST', taskPath + '/claim', { secret,
    body: { requestId: 'pwj-claim-2', expectedTermsVersion: termsVersion, leaseHours: 1 } });
  assert.equal(second.status, 409);
});
