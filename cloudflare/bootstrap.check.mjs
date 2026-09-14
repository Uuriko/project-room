import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { RoomStore } from '../server/store.mjs';
import { bootstrapRoom, bootstrapConfigurationProblem, resetBootstrapWarning } from './bootstrap.mjs';

test('operator bootstrap is explicit, atomic, one-time, hash-only and expires', () => {
  const now = Date.now(), store = new RoomStore(':memory:', { now: () => now });
  const key = randomBytes(32).toString('base64url');
  const env = { ROOM_BOOTSTRAP_OWNER_HASH: createHash('sha256').update(key).digest('hex'),
    ROOM_BOOTSTRAP_EXPIRES_AT: String(now + 86400000) };
  const logged = [];
  const log = message => logged.push(message);
  try {
    assert.equal(bootstrapRoom(store, {}), false);
    // Invalid, expired, far-future or malformed windows are skipped, not fatal:
    // nothing is written and the reason is logged once per isolate.
    for (const [invalid, reason] of [
      [{ ...env, ROOM_BOOTSTRAP_OWNER_HASH: key }, /not a 64-character/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: now }, /in the past/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: String(now - 30 * 86400000) }, /in the past/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: now + 8 * 86400000 }, /more than seven days/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: 'tomorrow' }, /not an integer/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: '' }, /not an integer/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: String(now + 1000.5) }, /not an integer/],
      [{ ...env, ROOM_BOOTSTRAP_EXPIRES_AT: undefined }, /not an integer/] ]) {
      resetBootstrapWarning(); logged.length = 0;
      assert.match(bootstrapConfigurationProblem(invalid, now), reason);
      assert.equal(bootstrapRoom(store, invalid, { log }), false);
      assert.equal(bootstrapRoom(store, invalid, { log }), false);
      assert.equal(logged.length, 1, 'skip reason is logged exactly once per isolate');
      assert.match(logged[0], /Operator bootstrap skipped/); assert.match(logged[0], reason);
      assert.equal(logged[0].includes(env.ROOM_BOOTSTRAP_OWNER_HASH), false);
      if (String(invalid.ROOM_BOOTSTRAP_EXPIRES_AT ?? '').length > 3) assert.equal(logged[0].includes(String(invalid.ROOM_BOOTSTRAP_EXPIRES_AT)), false, 'values stay out of logs');
      assert.equal(store.db.prepare('SELECT count(*) n FROM rooms').get().n, 0);
    }
    assert.equal(bootstrapConfigurationProblem(env, now), null);
    const bind = store.bindHumanAccount;
    store.bindHumanAccount = () => { throw new Error('Synthetic bootstrap failure'); };
    assert.throws(() => bootstrapRoom(store, env), /Synthetic bootstrap failure/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM rooms').get().n, 0);
    store.bindHumanAccount = bind;
    logged.length = 0;
    assert.equal(bootstrapRoom(store, env, { log }), true);
    assert.equal(logged.length, 0);
    assert.equal(store.authenticate(key).member.id, 'owner');
    assert.equal(bootstrapRoom(store, { ...env, ROOM_BOOTSTRAP_OWNER_HASH: 'b'.repeat(64) }), false);
    assert.equal(store.authenticate(key).account.id, 'pilot-owner');
    assert.equal(store.db.prepare('SELECT count(*) n FROM credentials').get().n, 1);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM credentials').all()).includes(key), false);
    store.now = () => now + 86400001;
    assert.throws(() => store.authenticate(key), { code: 'unauthenticated' });
  } finally { store.close(); }
});

test('real Workers runtime keeps serving when the operator bootstrap window is expired or malformed', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./bootstrap.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
  for (const expiresAt of [String(Date.now() - 86400000), 'not-a-timestamp', String(Date.now() + 30 * 86400000)]) {
    const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'BootstrapTestRoom', useSQLite: true } },
      bindings: { ROOM_ORIGIN: origin, ROOM_BOOTSTRAP_OWNER_HASH: hash, ROOM_BOOTSTRAP_EXPIRES_AT: expiresAt } });
    try {
      const call = path => mf.dispatchFetch(origin + path, { headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.1' } });
      // Before this change the Durable Object constructor threw here and every request 500'd.
      const health = await call('/api/health');
      assert.equal(health.status, 200, await health.clone().text());
      assert.equal((await health.json()).mode, 'cloudflare-staging');
      assert.equal((await call('/api/rooms/commons')).status, 401, 'signed-out reads stay denied on the empty workspace');
      const state = await (await call('/__test-bootstrap-state')).json();
      assert.deepEqual(state, { rooms: 0, credentials: 0, warnings: 1 }, `expiresAt=${expiresAt}: nothing provisioned, skip logged once`);
    } finally { await mf.dispose(); }
  }
});
