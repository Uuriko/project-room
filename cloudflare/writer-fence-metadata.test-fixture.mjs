// Local-only actual full-schema fence validation and SQL-cost fixture.
import assert from 'node:assert/strict';
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage, durableFenceDefinitions } from './storage.mjs';
import { STORE_SCHEMA_VERSION, writerFenceDefinitions } from '../server/writer-fence.mjs';
export class FenceMetadataRoom extends DurableObject {
  fetch(request) {
    const db = new DurableDatabase(this.ctx.storage);
    const store = new RoomStore(null, { database: db, storagePlatform: durableStorage, integrity: 'deferred' });
    store.createAccount('fence-fixture');
    const scenario = new URL(request.url).pathname;
    const name = writerFenceDefinitions[0].name;
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql;
    if (scenario === '/cost') {
      const measure = fn => { db.rowsRead = 0; fn(); return db.rowsRead; };
      const install = measure(() => durableStorage.transaction(db, () => durableStorage.installWriterFence(db)));
      const verify = measure(() => durableStorage.verifyWriterFence(db));
      assert.equal(durableStorage.version(db), STORE_SCHEMA_VERSION);
      assert.throws(() => db.storage.sql.exec("UPDATE accounts SET revision=revision+1 WHERE id='fence-fixture'"), /unsupported database writer/);
      return Response.json({ install, verify, triggers: writerFenceDefinitions.length });
    }
    assert.throws(() => durableStorage.installWriterFence(db), /migration transaction/);
    if (scenario === '/historical') {
      const historical = durableFenceDefinitions(41)[0];
      db.exec(historical.sql);
      durableStorage.transaction(db, () => durableStorage.installWriterFence(db));
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(historical.name), undefined);
      durableStorage.verifyWriterFence(db);
      return Response.json({ scenario, protected: true });
    }
    if (scenario === '/unknown') db.exec('CREATE TRIGGER writer_v999_unknown_insert BEFORE INSERT ON accounts BEGIN SELECT 1; END');
    if (scenario === '/missing' || scenario === '/drift') db.exec(`DROP TRIGGER ${name}`);
    if (scenario === '/drift') db.exec(original.replace("unsupported database writer", "changed fence"));
    if (scenario === '/permit') {
      // Invalidate the adapter cache through its existing rollback path, then
      // corrupt only the permit value using the fixture's raw storage handle.
      assert.throws(() => durableStorage.transaction(db, () => { throw new Error('invalidate'); }), /invalidate/);
      db.storage.sql.exec(`UPDATE room_writer_permit SET version=${STORE_SCHEMA_VERSION} WHERE singleton=1`);
    }
    assert.throws(() => durableStorage.verifyWriterFence(db), /operator reconciliation/);
    if (scenario === '/missing') {
      durableStorage.transaction(db, () => durableStorage.installWriterFence(db));
      durableStorage.verifyWriterFence(db);
      assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql, original);
    } else if (scenario !== '/permit') {
      assert.throws(() => durableStorage.transaction(db, () => durableStorage.installWriterFence(db)), /operator reconciliation/);
    }
    return Response.json({ scenario, protected: true });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName(new URL(request.url).pathname).fetch(request); } };
