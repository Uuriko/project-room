import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual Worker HTTP persists opted-in public offers, keeps drafts private and withdraws briefs without touching credits', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin } });
  const call = (path, data, key) => mf.dispatchFetch(origin + path, { method: data ? 'POST' : 'GET', headers: { Host: 'room.example.test', ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const json = async (response, expected = 200) => { assert.equal(response.status, expected, await response.clone().text()); return response.json(); };
  try {
    const { ownerKey } = await json(await call('/__test-provision'));
    const balancesBefore = await json(await call('/api/rooms/commons/credits/balances/owner', undefined, ownerKey));
    const input = { requestId: 'worker-create', offerId: 'worker-offer', reviewerMemberIds: ['owner'], terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'project', title: 'Worker contribution', summary: 'Deliver a reviewable result.', acceptanceCriteria: ['Complete criteria with reproducible evidence'], reward: { kind: 'work_trade', unit: 'credit', amountMinor: '1000' }, approvalPolicy: { mode: 'human' } } };
    const privatePath = '/api/rooms/commons/project-offers';
    const draft = await json(await call(privatePath, input, ownerKey), 201);
    assert.equal(draft.status, 'draft');
    assert.deepEqual(await json(await call('/api/project-offers')), { offers: [], nextCursor: null });
    assert.equal((await call('/api/project-offers/worker-offer')).status, 404);
    const publish = { requestId: 'worker-publish', expectedRevision: 1 };
    const published = await json(await call(privatePath + '/worker-offer/publish', publish, ownerKey));
    assert.deepEqual(await json(await call(privatePath + '/worker-offer/publish', publish, ownerKey)), published);
    const offer = await json(await call('/api/project-offers/worker-offer'));
    assert.equal(offer.reward.decimals, 3); assert.equal(offer.paymentStatus, 'ledger_only');
    assert.equal(Object.hasOwn(offer, 'reviewerMemberIds'), false); assert.equal(Object.hasOwn(offer, 'roomId'), false);
    const brief = await call('/api/project-offers/worker-offer/brief.md');
    assert.equal(brief.status, 200); const skillText = await brief.text(); assert.match(skillText, /^---\nname: [a-z0-9-]+\ndescription:/); assert.ok(skillText.includes(offer.acceptanceCriteria[0])); assert.ok(skillText.includes(offer.repositoryUrl));
    await json(await call(privatePath + '/worker-offer/withdraw', { requestId: 'worker-withdraw', expectedRevision: 2 }, ownerKey));
    assert.equal((await call('/api/project-offers/worker-offer/brief.md')).status, 404);
    assert.deepEqual(await json(await call('/api/project-offers')), { offers: [], nextCursor: null });
    assert.deepEqual(await json(await call('/api/rooms/commons/credits/balances/owner', undefined, ownerKey)), balancesBefore);
  } finally { await mf.dispose(); }
});
