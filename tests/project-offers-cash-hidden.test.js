import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { offerInput } from './project-offers-http.test.js';

test('public offer list leaves out cash-reward offers and keeps credit and unpaid ones', t => {
  const dir = mkdtempSync(join(tmpdir(), 'project-offer-cash-'));
  const store = new RoomStore(join(dir, 'room.sqlite')); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const rewards = [
    ['cash-usd', { kind: 'cash', unit: 'USD', amountMinor: '10000' }],
    ['cash-usdc', { kind: 'cash', unit: 'USDC', amountMinor: '100000000' }],
    ['credit', { kind: 'work_trade', unit: 'credit', amountMinor: '1000' }],
    ['unpaid', { kind: 'unpaid' }],
  ];
  for (const [id, reward] of rewards) {
    const input = offerInput(id); input.terms.reward = reward;
    store.projectOffers.create('commons', 'owner', input);
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
  }
  const { offers, nextCursor } = store.projectOffers.list({ limit: 100 });
  assert.deepEqual(offers.map(offer => offer.id), ['credit', 'unpaid']);
  assert.equal(nextCursor, null);
  assert.ok(offers.every(offer => offer.reward.kind !== 'cash'));
  const page = store.projectOffers.list({ limit: 1 });
  assert.deepEqual(page.offers.map(offer => offer.id), ['credit']);
  assert.equal(page.nextCursor, 'credit');
});
