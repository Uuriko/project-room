import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { bootstrapRoom } from './bootstrap.mjs';

test('operator bootstrap is explicit, atomic, one-time, hash-only and expires', () => {
  const now = Date.now(), store = new RoomStore(':memory:', { now: () => now });
  const key = randomBytes(32).toString('base64url');
  const env = { ROOM_BOOTSTRAP_OWNER_HASH: createHash('sha256').update(key).digest('hex'),
    ROOM_BOOTSTRAP_EXPIRES_AT: String(now + 86400000) };
  try {
    assert.equal(bootstrapRoom(store, {}), false);
    for (const invalid of [ { ...env, ROOM_BOOTSTRAP_OWNER_HASH: key },
      { ...env, ROOM_BOOTSTRAP_EXPIRES_AT: now }, { ...env, ROOM_BOOTSTRAP_EXPIRES_AT: now + 8 * 86400000 } ]) {
      assert.throws(() => bootstrapRoom(store, invalid), /Invalid or expired/);
      assert.equal(store.db.prepare('SELECT count(*) n FROM rooms').get().n, 0);
    }
    const bind = store.bindHumanAccount;
    store.bindHumanAccount = () => { throw new Error('Synthetic bootstrap failure'); };
    assert.throws(() => bootstrapRoom(store, env), /Synthetic bootstrap failure/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM rooms').get().n, 0);
    store.bindHumanAccount = bind;
    assert.equal(bootstrapRoom(store, env), true);
    assert.equal(store.authenticate(key).member.id, 'owner');
    assert.equal(bootstrapRoom(store, { ...env, ROOM_BOOTSTRAP_OWNER_HASH: 'b'.repeat(64) }), false);
    assert.equal(store.authenticate(key).account.id, 'pilot-owner');
    assert.equal(store.db.prepare('SELECT count(*) n FROM credentials').get().n, 1);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM credentials').all()).includes(key), false);
    store.now = () => now + 86400001;
    assert.throws(() => store.authenticate(key), { code: 'unauthenticated' });
  } finally { store.close(); }
});
