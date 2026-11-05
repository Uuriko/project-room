import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Native storage preserves issued prefix-collision credentials across cold restart and revocation', { timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'credential-prefix-native-'));
  const fixture = `
    import { DurableObject } from 'cloudflare:workers';
    import { createHash } from 'node:crypto';
    import { RoomStore } from '../server/store.mjs';
    import { initialRoom } from '../server/bootstrap.mjs';
    import { DurableDatabase, durableStorage } from './storage.mjs';
    const hash = value => createHash('sha256').update(value).digest('hex');
    const tokens = ['oat_', 'iat_', 'rak_'].map(prefix => prefix + 'A'.repeat(39));
    export class PrefixRoom extends DurableObject {
      fetch(request) {
        const store = new RoomStore(null, { database: new DurableDatabase(this.ctx.storage), storagePlatform: durableStorage, integrity: 'deferred' });
        const action = new URL(request.url).pathname;
        if (action === '/seed') {
          store.initialize(initialRoom());
          for (const token of tokens) {
            const issued = store.mintAccessKey('commons', 'owner');
            store.transaction(() => store.db.prepare('UPDATE credentials SET hash=? WHERE hash=?').run(hash(token), hash(issued)));
          }
        }
        if (action === '/revoke') store.transaction(() => {
          for (const token of tokens) store.db.prepare('UPDATE credentials SET revoked=1 WHERE hash=?').run(hash(token));
        });
        return Response.json(tokens.map(token => {
          try { const auth = store.authenticate(token, 'commons'); return { member: auth.member.id, kind: auth.kind }; }
          catch (error) { return { status: error.status, code: error.code }; }
        }));
      }
    }
    export default { fetch(request, env) { return env.ROOM.getByName('same-storage').fetch(request); } };
  `;
  const bundled = await build({ stdin: { contents: fixture,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'prefix-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const options = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjectsPersist: join(temp, 'persist'), durableObjects: { ROOM: { className: 'PrefixRoom', useSQLite: true } } };
  let worker;
  try {
    worker = new Miniflare(options);
    const check = async (path, expected) => {
      const response = await worker.dispatchFetch('https://room.example.test' + path);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), Array.from({ length: 3 }, () => expected));
    };
    await check('/seed', { member: 'owner', kind: 'access' });
    await worker.dispose(); worker = new Miniflare(options);
    await check('/read', { member: 'owner', kind: 'access' });
    await check('/revoke', { status: 401, code: 'unauthenticated' });
    await worker.dispose(); worker = new Miniflare(options);
    await check('/read', { status: 401, code: 'unauthenticated' });
  } finally {
    await worker?.dispose(); await rm(temp, { recursive: true, force: true });
  }
});
