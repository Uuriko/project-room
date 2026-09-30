import { request as httpRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

export const offerInput = (offerId = 'software-review') => ({ requestId: `create-${offerId}`, offerId,
  reviewerMemberIds: ['owner'], terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'task', title: 'Review a small patch', summary: 'Fix one reproducible bug.',
    acceptanceCriteria: ['A'.repeat(750), 'Include a regression test'], reward: { kind: 'cash', unit: 'USD', amountMinor: '10000', terms: 'Subject to separately agreed payment setup.' }, approvalPolicy: { mode: 'human' } } });

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'project-offer-'));
  const path = join(dir, 'room.sqlite');
  const store = new RoomStore(path); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-peer', type: 'member.added', data: { memberId: 'peer', displayName: 'Peer', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'peer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (route, data, key = ownerKey, method = data ? 'POST' : 'GET') => fetch(origin + route, { method,
    headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { store, path, call, origin, ownerKey, peerKey };
}
const privatePath = '/api/rooms/commons/project-offers';
const publicPath = '/api/project-offers';
const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };

test('real HTTP draft/publish/full public brief/withdraw and stable replay never move credits', async t => {
  const { store, call } = await fixture(t);
  const before = store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n;
  const input = offerInput();
  const draft = await json(await call(privatePath, input), 201);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(await json(await call(publicPath, undefined, null)), { offers: [], nextCursor: null });
  assert.equal((await call(`${publicPath}/${input.offerId}`, undefined, null)).status, 404);
  assert.deepEqual(await json(await call(privatePath, input), 201), draft);
  const publishInput = { requestId: 'publish-1', expectedRevision: 1 };
  const published = await json(await call(`${privatePath}/${input.offerId}/publish`, publishInput));
  assert.deepEqual(await json(await call(`${privatePath}/${input.offerId}/publish`, publishInput)), published);
  assert.equal(published.revision, 2); assert.equal(published.version, 1);
  const publicOffer = await json(await call(`${publicPath}/${input.offerId}`, undefined, null));
  assert.equal(publicOffer.acceptanceCriteria[0].length, 750);
  assert.equal(publicOffer.paymentStatus, 'not_configured'); assert.equal(publicOffer.reward.decimals, 2);
  for (const key of ['roomId', 'workItemId', 'reviewerMemberIds', 'ownerId']) assert.equal(Object.hasOwn(publicOffer, key), false);
  const brief = await call(`${publicPath}/${input.offerId}/brief.md`, undefined, null);
  assert.equal(brief.status, 200); const skillText = await brief.text(); assert.match(skillText, /^---\nname: [a-z0-9-]+\ndescription:/); assert.ok(skillText.includes(publicOffer.acceptanceCriteria[0])); assert.ok(skillText.includes(publicOffer.repositoryUrl));
  assert.equal((await call(`${publicPath}/${input.offerId}/brief.md`, undefined, null, 'HEAD')).status, 200);
  assert.equal(await (await call(`${publicPath}/${input.offerId}`, undefined, null, 'HEAD')).text(), '');
  await json(await call(`${privatePath}/${input.offerId}/withdraw`, { requestId: 'withdraw-1', expectedRevision: 2 }));
  assert.equal((await call(`${publicPath}/${input.offerId}/brief.md`, undefined, null)).status, 404);
  assert.deepEqual(await json(await call(publicPath, undefined, null)), { offers: [], nextCursor: null });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n, before);
});

test('real HTTP rejects non-owner, secret-shaped/unknown fields, invalid review standing and stale revisions', async t => {
  const { call, peerKey } = await fixture(t);
  assert.equal((await call(privatePath, offerInput(), peerKey)).status, 403);
  assert.equal((await call(privatePath, undefined, peerKey)).status, 403);
  assert.equal((await call(privatePath, offerInput(), null)).status, 401);
  for (const alter of [input => { input.terms.paymentStatus = 'paid'; }, input => { input.terms.summary = 'Bearer ' + 'private-value'; }, input => { input.terms.repositoryUrl = 'https://example.test/?token=value'; }, input => { input.reviewerMemberIds = ['missing']; }, input => { input.terms.approvalPolicy.mode = 'agent'; }, input => { input.workItemId = 'missing'; }, input => { input.terms.reward.unit = 'credit'; }]) {
    const input = offerInput(); alter(input); assert.equal((await call(privatePath, input)).status, 422);
  }
  await json(await call(privatePath, offerInput()), 201);
  assert.equal((await call(privatePath, { ...offerInput(), terms: { ...offerInput().terms, title: 'Changed' } })).status, 409);
  assert.equal((await call(`${privatePath}/software-review/publish`, { requestId: 'stale', expectedRevision: 9 })).status, 409);
  assert.equal((await call(publicPath, {}, null)).status, 405);
  assert.equal((await call(publicPath + '?limit=101', undefined, null)).status, 422);
});

test('persisted terms survive reopen; credit and unpaid units remain distinct and bounded public paging works', async t => {
  const { store, path } = await fixture(t);
  for (const [id, reward] of [['a', { kind: 'work_trade', unit: 'credit', amountMinor: '1000' }], ['b', { kind: 'unpaid' }]]) {
    const input = offerInput(id); input.terms.reward = reward;
    store.projectOffers.create('commons', 'owner', input);
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
  }
  const reopened = new RoomStore(path, { readOnly: true });
  try {
    const first = reopened.projectOffers.list({ limit: 1 });
    assert.equal(first.nextCursor, 'a'); assert.equal(first.offers[0].reward.decimals, 3); assert.equal(first.offers[0].paymentStatus, 'ledger_only');
    const second = reopened.projectOffers.list({ limit: 1, after: first.nextCursor });
    assert.equal(second.nextCursor, null); assert.deepEqual(second.offers[0].reward, { kind: 'unpaid' });
  } finally { reopened.close(); }
});

test('held owner upload cannot create after the actual credential is revoked', { timeout: 5000 }, async t => {
  const { store, origin, ownerKey } = await fixture(t);
  const original = store.authenticate.bind(store); let notify;
  const authenticated = new Promise(resolve => { notify = resolve; }); let armed = true;
  store.authenticate = (...args) => { const value = original(...args); if (armed && args[0] === ownerKey) { armed = false; notify(); } return value; };
  const payload = JSON.stringify(offerInput('held'));
  let held;
  const outcome = new Promise((resolve, reject) => {
    held = httpRequest(origin + privatePath, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    held.on('error', reject); held.write(payload.slice(0, 1));
  });
  t.after(() => held.destroy()); await authenticated;
  store.revoke(ownerKey); held.end(payload.slice(1));
  assert.equal(await outcome, 401);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_offers').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_offer_requests').get().n, 0);
});

test('lost committed publish response retries the same intent and preserves one publication', async t => {
  const { call, store } = await fixture(t); const input = offerInput('lost-response');
  await json(await call(privatePath, input), 201);
  const intent = { requestId: 'stable-publish', expectedRevision: 1 };
  await assert.rejects(async () => { const response = await call(`${privatePath}/${input.offerId}/publish`, intent); await json(response); throw new TypeError('Synthetic response lost after real commit'); }, TypeError);
  const replay = await json(await call(`${privatePath}/${input.offerId}/publish`, intent));
  assert.equal(replay.revision, 2);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_offer_requests WHERE request_id=?').get(intent.requestId).n, 1);
  assert.equal((await json(await call(publicPath, undefined, null))).offers.length, 1);
});
