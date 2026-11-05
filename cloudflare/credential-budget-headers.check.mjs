import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual Worker bridge preserves credential budget headers across overlapping requests', async t => {
  const fixture = `
    import entry, { ProjectRoom } from './room.mjs';
    import { initialRoom } from '../server/bootstrap.mjs';
    export class BudgetRoom extends ProjectRoom {
      async fetch(request) {
        if (new URL(request.url).pathname === '/__fixture/budget') {
          this.store.initialize(initialRoom());
          const first = this.store.issueAccessKey('commons', 'owner');
          this.store.command(first, 'commons', { id: 'budget-bot', type: 'member.added',
            data: { memberId: 'bot', displayName: 'Bot', kind: 'agent', permissions: [] } });
          return Response.json({ first, second: this.store.issueAccessKey('commons', 'bot') });
        }
        return super.fetch(request);
      }
    }
    export default entry;
  `;
  const bundled = await build({ stdin: { contents: fixture,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'budget-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const worker = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'BudgetRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin } });
  t.after(() => worker.dispose());
  const setup = await worker.dispatchFetch(origin + '/__fixture/budget');
  assert.equal(setup.status, 200);
  const keys = await setup.json();
  const read = credential => worker.dispatchFetch(origin + '/api/rooms/commons/events?after=0', {
    headers: { Authorization: 'Bearer ' + credential } });
  const initial = await read(keys.first);
  assert.equal(initial.status, 200, await initial.clone().text());
  const limit = Number(initial.headers.get('x-ratelimit-limit'));
  assert.ok(limit > 1);
  assert.equal(Number(initial.headers.get('x-ratelimit-remaining')), limit - 1);
  const [first, second] = await Promise.all([read(keys.first), read(keys.second)]);
  for (const response of [first, second]) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-ratelimit-bucket'), 'read');
    assert.equal(Number(response.headers.get('x-ratelimit-limit')), limit);
    assert.ok(Number(response.headers.get('x-ratelimit-reset')) * 1000 >= Date.now() - 1000);
  }
  assert.equal(Number(second.headers.get('x-ratelimit-remaining')), limit - 1,
    'the second credential has its own untouched budget');
  const write = await worker.dispatchFetch(origin + '/api/rooms/commons/commands', {
    method: 'POST', headers: { Authorization: 'Bearer ' + keys.first,
      Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'budget-write', type: 'message.posted',
      data: { messageId: 'budget-message', body: 'Synthetic budget check' } }) });
  assert.equal(write.status, 201, await write.clone().text());
  assert.equal(write.headers.get('x-ratelimit-bucket'), 'write');
  assert.equal(Number(write.headers.get('x-ratelimit-remaining')),
    Number(write.headers.get('x-ratelimit-limit')) - 1);
  const unauthenticated = await worker.dispatchFetch(origin + '/api/health');
  assert.equal(unauthenticated.status, 200);
  assert.equal(unauthenticated.headers.get('x-ratelimit-bucket'), null);
});
