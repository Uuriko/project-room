import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { MachineBot } from '../machine/bot/loop.mjs';
import { createRoomApi } from '../machine/bot/room-api.mjs';

// A definitive claim-close rejection (here: distinct_member review policy
// with no attestation, so the done transition 403s) must not hold the
// finished result hostage: the result is published exactly once, the machine
// moves on, and the claim stays open for its reviewer.
test('finished work on a review-gated claim publishes its result and leaves the claim open', async t => {
  const f = createAcceptanceFixture(), home = mkdtempSync(join(tmpdir(), 'machine-delivery-review-'));
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = createRoomApi({ origin, secret: f.keys.owner });
  assert.equal((await api.createClaim('commons', { id: 'review-work', title: 'review-work', reviewPolicy: 'distinct_member' })).ok, true);
  assert.equal((await api.takeClaim('commons', 'review-work', {})).ok, true);
  assert.equal((await api.createClaim('commons', { id: 'review-lease', title: 'review-lease', reviewPolicy: 'self_attested' })).ok, true);
  assert.equal((await api.takeClaim('commons', 'review-lease', {})).ok, true);

  const bot = new MachineBot({ home, env: {} });
  bot.config = { roomOrigin: origin, label: 'Test machine' };
  bot.secret = f.keys.owner;
  bot.api = api;
  bot.provider = { next: async () => { assert.fail('finished work must never run another turn'); } };
  bot.active = { roomId: 'commons', workId: 'review-work', leaseId: 'review-lease', slot: 'desk', messageId: null, observations: [] };

  const result = await bot.finish('The finished result.');
  assert.equal(result.done, true, 'a permanently unclosable claim does not block delivery');
  assert.equal(result.closed, false, 'the receipt reports the review-gated claim was not closed');

  const messages = () => f.store.room('commons').state.messages.filter(m => m.body.startsWith('The finished result.'));
  assert.equal(messages().length, 1, 'the result is published exactly once');

  const work = (await api.claim('commons', 'review-work')).value;
  assert.equal(work.state, 'in_progress', 'the review-gated claim stays open for its reviewer');
  const lease = (await api.claim('commons', 'review-lease')).value;
  assert.equal(lease.state, 'done', 'the self-attested lease claim still closes');
  assert.ok(lease.blobs.length > 0, 'the closed lease carries its receipt');

  assert.equal(bot.active, null, 'the machine is free for the next work');

  // A resumed retry (the loop calling finish again) must not duplicate anything.
  const resumed = new MachineBot({ home, env: {} });
  resumed.config = { roomOrigin: origin, label: 'Test machine' };
  resumed.secret = f.keys.owner;
  resumed.api = api;
  assert.equal(resumed.active, null, 'no delivery remains pending after a skip');
  assert.equal(messages().length, 1, 'retry publishes nothing new');
});
