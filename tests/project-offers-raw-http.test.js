// m10 regression guard (Crew D Lane 3): raw HTTP consumers of the public
// offer-detail endpoint must always receive the full JSON body, regardless
// of Accept-Encoding. The 2026-10-05 user-testing wave reported "200 with
// 0-byte body without --compressed, full JSON with --compressed" on
// GET /api/project-offers/{id} — raw-HTTP consumers silently getting
// nothing. This test locks the invariant: the server never compresses
// responses and never varies the body on Accept-Encoding.
import { request as rawRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const offerInput = (offerId = 'raw-http-offer') => ({ requestId: `create-${offerId}`, offerId,
  reviewerMemberIds: ['owner'], terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'task', title: 'Review a small patch', summary: 'Fix one reproducible bug.',
    acceptanceCriteria: ['Include a regression test'], reward: { kind: 'cash', unit: 'USD', amountMinor: '10000', terms: 'Subject to separately agreed payment setup.' }, approvalPolicy: { mode: 'human' } } });

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'project-offer-raw-'));
  const path = join(dir, 'room.sqlite');
  const store = new RoomStore(path); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-peer', type: 'member.added', data: { memberId: 'peer', displayName: 'Peer', kind: 'human', permissions: [] } });
  const input = offerInput('raw-http-offer');
  store.projectOffers.create('commons', 'owner', input);
  store.projectOffers.transition('commons', 'owner', 'raw-http-offer', 'publish', { requestId: 'publish-raw', expectedRevision: 1 });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  // Deliberately bypasses fetch: no implicit Accept-Encoding, no
  // decompression — exactly what a raw-HTTP consumer sends.
  const rawGet = (route, headers = {}) => new Promise((resolve, reject) => {
    const req = rawRequest({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  return { rawGet, offerId: 'raw-http-offer' };
}

test('m10: offer detail returns the full JSON body with no Accept-Encoding (raw HTTP)', async t => {
  const { rawGet, offerId } = await fixture(t);
  const res = await rawGet(`/api/project-offers/${offerId}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(res.headers['content-encoding'], undefined, 'server must not compress an unrequested body');
  assert.ok(res.body.length > 0, 'raw-HTTP consumer got a 0-byte body (m10)');
  const parsed = JSON.parse(res.body.toString('utf8'));
  assert.equal(parsed.id, offerId);
  assert.ok(parsed.title, 'detail body must carry the offer payload');
});

test('m10: offer detail body is identical with and without Accept-Encoding: gzip', async t => {
  const { rawGet, offerId } = await fixture(t);
  const plain = await rawGet(`/api/project-offers/${offerId}`);
  const gzipped = await rawGet(`/api/project-offers/${offerId}`, { 'Accept-Encoding': 'gzip, deflate' });
  assert.equal(plain.status, 200);
  assert.equal(gzipped.status, 200);
  assert.equal(gzipped.headers['content-encoding'], undefined, 'server never compresses; no variant bodies');
  assert.deepEqual(gzipped.body, plain.body, 'body must not vary on Accept-Encoding');
});

test('m10: offer list also returns a non-empty body with no Accept-Encoding', async t => {
  const { rawGet } = await fixture(t);
  const res = await rawGet('/api/project-offers');
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, 'list body must be non-empty');
  assert.ok(JSON.parse(res.body.toString('utf8')).offers.length >= 1);
});
