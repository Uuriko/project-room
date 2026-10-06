import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

// Authoring gate (test-audit): this file owns ONE contract the module tests
// cannot reach — the HTTP wiring. It proves the routes are actually mounted
// in server/http.mjs (the "defined but never mounted" regression class),
// that auth is enforced at the transport boundary, and that the
// buyer-presentable document and buyer-visible status endpoints serve over
// real HTTP. All domain behavior stays in the module suites.

const SHA = 'b'.repeat(64);

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'buyer-offer-http-'));
  const path = join(dir, 'room.sqlite');
  const store = new RoomStore(path);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (route, data, key = ownerKey, method = data ? 'POST' : 'GET') => fetch(origin + route, { method,
    headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { store, call };
}
const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const base = '/api/rooms/commons';

const seedOffer = call => call(`${base}/project-offers`, {
  requestId: 'seed-offer', offerId: 'seed-1', reviewerMemberIds: ['owner'],
  terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'project',
    title: 'Seed offer', summary: 'Seed', acceptanceCriteria: ['Done'],
    reward: { kind: 'cash', unit: 'USD', amountMinor: '1000' }, approvalPolicy: { mode: 'human' } },
});

test('offer profile lifecycle over HTTP: create, document, present, accept', async t => {
  const { call } = await fixture(t);
  await json(await seedOffer(call), 201);
  const profile = await json(await call(`${base}/demigod-offers`, {
    requestId: 'p1', profileId: 'http-1', offerRef: 'seed-1', demigodReqId: 'req-1', buyerId: 'owner',
    trialScope: { hours: '20', deliverableShape: 'markdown-report' },
    vettingRubric: [{ criterionId: 'c1', description: 'Clear', maxScore: '5.00' }],
    priceType: 'fixed', priceMilli: '2000000',
    timeline: { estimateDays: '7', deadline: '2026-11-01T00:00:00.000Z' },
    revisionTerms: { maxRounds: 2, turnaroundDays: '2' },
  }), 201);
  assert.equal(profile.status, 'draft');
  assert.equal(profile.recordOnly, true);

  const docRes = await call(`${base}/demigod-offers/http-1/document`, undefined, undefined, 'GET');
  assert.equal(docRes.status, 200);
  assert.match(docRes.headers.get('content-type'), /text\/markdown/);
  const doc = await docRes.text();
  assert.match(doc, /Seed offer/);
  assert.match(doc, /record-only/i);

  await json(await call(`${base}/demigod-offers/http-1/present`, { requestId: 'pr1', expectedRevision: 1 }));
  const accepted = await json(await call(`${base}/demigod-offers/http-1/accept`, { requestId: 'a1', expectedRevision: 2 }));
  assert.equal(accepted.status, 'accepted');

  // Unauthenticated reads are refused at the transport boundary.
  assert.equal((await call(`${base}/demigod-offers/http-1`, undefined, null)).status, 401);
});

test('contract mints from the accepted offer and the sign-off loop closes over HTTP', async t => {
  const { call } = await fixture(t);
  await json(await seedOffer(call), 201);
  await json(await call(`${base}/demigod-offers`, {
    requestId: 'p1', profileId: 'http-2', offerRef: 'seed-1', demigodReqId: 'req-2', buyerId: 'owner',
    trialScope: { hours: '20', deliverableShape: 'markdown-report' },
    vettingRubric: [{ criterionId: 'c1', description: 'Clear', maxScore: '5.00' }],
    priceType: 'fixed', priceMilli: '2000000',
    timeline: { estimateDays: '7', deadline: '2026-11-01T00:00:00.000Z' },
    revisionTerms: { maxRounds: 2, turnaroundDays: '2' },
  }), 201);
  await json(await call(`${base}/demigod-offers/http-2/present`, { requestId: 'pr1', expectedRevision: 1 }));
  await json(await call(`${base}/demigod-offers/http-2/accept`, { requestId: 'a1', expectedRevision: 2 }));
  const contract = await json(await call(`${base}/demigod-contracts`, {
    requestId: 'c1', contractId: 'http-c1', offerProfileId: 'http-2', expectedRevision: 3,
  }), 201);
  assert.equal(contract.status, 'pending');
  assert.equal(contract.termsSnapshot.id, 'http-2');

  const loop = await json(await call(`${base}/signoff-loops`, {
    requestId: 's1', loopId: 'http-s1', trialTaskId: 'trial-x1', buyerId: 'owner', contractId: 'http-c1',
  }), 201);
  assert.equal(loop.status, 'open');
  assert.equal(loop.maxRounds, 2); // inherited from the contract's revision terms
  await json(await call(`${base}/signoff-loops/http-s1/submit`, {
    requestId: 'sub1', deliverableRef: 'https://example.com/d/1', sha256: SHA, summary: 'First delivery', candidateId: 'owner',
  }));
  const status = await json(await call(`${base}/signoff-loops/http-s1/status`));
  assert.equal(status.state, 'submitted');
  assert.equal(status.currentDeliverable.summary, 'First delivery');
  const done = await json(await call(`${base}/signoff-loops/http-s1/review`, {
    requestId: 'rev1', decision: 'accept', note: 'Signed off',
  }));
  assert.equal(done.status, 'accepted');
});
