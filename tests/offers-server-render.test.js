// DOOR-CURE-3: GET /offers server-renders the published set into the
// served HTML (the receipts-wall pattern), so a no-JS reader sees actual
// offers. The client script remains an enhancement over the same data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { renderOffersHtml, offerRewardLabel } from '../server/offers-page.mjs';

const offerInput = (offerId = 'software-review') => ({ requestId: `create-${offerId}`, offerId,
  reviewerMemberIds: ['owner'], terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'task', title: 'Review a small patch', summary: 'Fix one reproducible bug.',
    acceptanceCriteria: ['A'.repeat(750), 'Include a regression test'], reward: { kind: 'cash', unit: 'USD', amountMinor: '10000', terms: 'Subject to separately agreed payment setup.' }, approvalPolicy: { mode: 'human' } } });

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  return { store, origin: `http://127.0.0.1:${server.address().port}` };
}

function publish(store, id, alter) {
  const input = offerInput(id); if (alter) alter(input);
  store.projectOffers.create('commons', 'owner', input);
  store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
}

test('served /offers HTML contains the published offers without JS', async t => {
  const { store, origin } = await fixture(t);
  publish(store, 'alpha-task');
  publish(store, 'beta-task', input => { input.terms.title = 'Beta <script>alert(1)</script> task'; input.terms.reward = { kind: 'unpaid' }; });
  // A draft must never reach the public shelf.
  store.projectOffers.create('commons', 'owner', offerInput('draft-only'));

  const response = await fetch(origin + '/offers');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('x-robots-tag'), 'all');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /Review a small patch/);
  assert.match(html, /Fix one reproducible bug\./);
  assert.match(html, /\$100/);
  assert.match(html, /href="\/api\/project-offers\/alpha-task\/brief\.md"/);
  assert.match(html, /href="\/offers\?offer=alpha-task"/);
  assert.match(html, /2 open offers shown/);
  assert.doesNotMatch(html, /draft-only/);
  // Owner-authored text is escaped, never raw markup.
  assert.match(html, /Beta &lt;script&gt;alert\(1\)&lt;\/script&gt; task/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script> task/);
  // The JS enhancement is still shipped and still owns the same list.
  assert.match(html, /src="\/src\/project-offers-ui\.js"|src=\/src\/project-offers-ui\.js|\/src\/project-offers-ui\.js/);
  assert.match(html, /id="offer-list"/);
  const head = await fetch(origin + '/offers', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(origin + '/offers', { method: 'POST' })).status, 405);
});

test('empty shelf renders the honest empty state, and paging links forward', async t => {
  const { store, origin } = await fixture(t);
  const empty = await (await fetch(origin + '/offers')).text();
  assert.match(empty, /No open tasks right now/);
  assert.match(empty, /href="\/receipts"/);
  publish(store, 'a-one'); publish(store, 'b-two');
  const first = await (await fetch(origin + '/offers?limit=1')).text();
  assert.match(first, /a-one|Review a small patch/);
  assert.match(first, /href="\/offers\?after=a-one"/);
  const second = await (await fetch(origin + '/offers?after=a-one')).text();
  assert.match(second, /href="\/offers\?offer=b-two"/);
  // A malformed cursor from a typed link still gets a page, not an error.
  const bad = await fetch(origin + '/offers?after=%3Cbad%3E&limit=9999');
  assert.equal(bad.status, 200);
  assert.match(await bad.text(), /open offers shown|open offer shown/);
});

test('renderer leaves a shell without the list marker unchanged', () => {
  assert.equal(renderOffersHtml('newly available package bytes', { offers: [], nextCursor: null }), 'newly available package bytes');
  assert.equal(offerRewardLabel({ kind: 'unpaid' }), 'Unpaid');
  assert.equal(offerRewardLabel({ kind: 'cash', unit: 'USD', amountMinor: '10000', decimals: 2 }), 'Proposed $100');
  assert.equal(offerRewardLabel({ kind: 'work_trade', unit: 'credit', amountMinor: '1500', decimals: 3, basis: 'pool' }), 'Proposed 1.5 credits pool');
});
