// Disposable local test only. Never a deployment entrypoint.
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';

// Frozen v7 write behavior from 884d086: an already-constructed adapter does not
// acquire a v8 permit. Keep this independent of the current implementation.
class CachedV7Database {
  constructor(storage) { this.storage = storage; this.isTransaction = false; }
  exec(sql) { this.storage.sql.exec(sql).toArray(); }
  prepare(sql) {
    const all = (...args) => this.storage.sql.exec(sql, ...args).toArray();
    return { all, get: (...args) => all(...args)[0], run: (...args) => {
      all(...args); return { changes: this.storage.sql.exec('SELECT changes() AS n').one().n };
    } };
  }
  transaction(fn) {
    if (this.isTransaction) return fn();
    return this.storage.transactionSync(() => {
      this.isTransaction = true;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('Room transactions must remain synchronous');
        return result;
      } finally { this.isTransaction = false; }
    });
  }
}

export class ReminderUpgradeRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.old = new CachedV7Database(ctx.storage);
    this.cachedWrite = this.old.prepare("UPDATE accounts SET revision=revision WHERE id=?");
  }
  async fetch(request) {
    const path = new URL(request.url).pathname, sql = this.ctx.storage.sql;
    const fresh = () => new RoomStore(null, { database: new DurableDatabase(this.ctx.storage), storagePlatform: durableStorage });
    const marker = () => sql.exec('SELECT version FROM room_runtime_version').one().version;
    const permit = () => sql.exec('SELECT version FROM room_writer_permit').one().version;
    const legacyWrite = () => this.old.transaction(() => this.cachedWrite.run(this.env.ACCOUNT));
    if (path === '/initialize') {
      this.ctx.storage.transactionSync(() => {
        sql.exec('CREATE TABLE room_runtime_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)');
        sql.exec('INSERT INTO room_runtime_version VALUES(1,7)');
        for (const statement of JSON.parse(this.env.SCHEMA)) sql.exec(statement);
        for (const { table, columns, values } of JSON.parse(this.env.ROWS)) sql.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values);
      });
      assert.equal(legacyWrite().changes, 1); return Response.json({ version: marker() });
    }
    if (path === '/failed-upgrade') {
      const oldSchema = sql.exec("SELECT name,sql FROM sqlite_master WHERE name NOT GLOB '_cf_*' ORDER BY name").toArray();
      const verify = RoomStore.prototype.verifyInvitationAudit;
      RoomStore.prototype.verifyInvitationAudit = () => { throw new Error('synthetic final validation failure'); };
      try { assert.throws(fresh, /synthetic final validation failure/); }
      finally { RoomStore.prototype.verifyInvitationAudit = verify; }
      assert.equal(marker(), 7);
      assert.deepEqual(sql.exec("SELECT name,sql FROM sqlite_master WHERE name NOT GLOB '_cf_*' ORDER BY name").toArray(), oldSchema);
      assert.equal(legacyWrite().changes, 1);
      return Response.json({ rolledBack: true });
    }
    if (path === '/upgrade') {
      const tables = JSON.parse(this.env.TABLES);
      const rows = () => Object.fromEntries(tables.map(table => [table, sql.exec(`SELECT * FROM ${table}`).toArray()]));
      const before = rows(), store = fresh();
      assert.equal(marker(), 17); assert.equal(permit(), 0);
      assert.deepEqual(rows(), before);
      assert.throws(legacyWrite, /unsupported database writer/);
      assert.equal(sql.exec("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v7_*'").one().n, 0);
      assert.equal(store.readTransaction(() => permit()), 0, 'read-only snapshots never open the gate');
      assert.throws(() => store.readTransaction(() => store.createAccount('nested-write')), /read-only/);
      assert.throws(() => store.transaction(() => { store.createAccount('rolled-back'); throw new Error('synthetic rollback'); }), /synthetic rollback/);
      assert.equal(sql.exec("SELECT count(*) n FROM accounts WHERE id='rolled-back'").one().n, 0); assert.equal(permit(), 0);
      assert.equal(store.db.prepare("UPDATE accounts SET revision=revision WHERE id='missing'").run().changes, 0);
      assert.equal(store.db.prepare('UPDATE accounts SET revision=revision WHERE id=?').run(this.env.ACCOUNT).changes, 1);
      const snapshot = store.snapshot(this.env.TOKEN, 'commons');
      const command = { requestId: 'worker-reminder', workItemId: 'test-handoff', expectedRevision: 0, action: 'schedule', dueAt: Date.now() + 3600000 };
      assert.equal(store.reminders.mutate(this.env.TOKEN, 'commons', command).duplicate, false);
      assert.equal(store.reminders.mutate(this.env.TOKEN, 'commons', command).duplicate, true);
      assert.deepEqual(store.snapshot(this.env.TOKEN, 'commons'), snapshot);
      assert.equal(permit(), 0);
      return Response.json({ migrated: true, legacyRejected: true, reminders: 1 });
    }
    if (path === '/restart') {
      const store = fresh();
      assert.equal(permit(), 0); assert.throws(legacyWrite, /unsupported database writer/);
      assert.equal(store.reminders.list(this.env.TOKEN, 'commons').reminders[0].state, 'active');
      return Response.json({ recovered: true });
    }
    if (path === '/corrupt') {
      this.old.exec('DROP TRIGGER writer_v7_accounts_update');
      assert.throws(fresh, /reconciliation/); assert.equal(marker(), 7);
      assert.equal(sql.exec("SELECT count(*) n FROM sqlite_master WHERE name='private_reminders'").one().n, 0);
      return Response.json({ rejected: true });
    }
    return new Response('Not found', { status: 404 });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName(new URL(request.url).searchParams.get('case') ?? 'upgrade').fetch(request); } };
