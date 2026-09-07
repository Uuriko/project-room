import { STORE_SCHEMA_VERSION, WRITER_FUNCTION, writerFenceDefinitions } from '../server/writer-fence.mjs';

const marker = 'room_runtime_version';
const fences = writerFenceDefinitions.map(({ name, sql }) => ({ name,
  sql: sql.replace(`${WRITER_FUNCTION}()`, `(SELECT version FROM ${marker} WHERE singleton=1)`) }));

// A narrow adapter for the methods RoomStore actually uses. No SQL parsing,
// arbitrary rewrites, filesystem emulation, or pretend user-defined functions.
export class DurableDatabase {
  constructor(storage) { this.storage = storage; this.isTransaction = false; }
  exec(sql) { this.storage.sql.exec(sql).toArray(); }
  prepare(sql) {
    const all = (...args) => this.storage.sql.exec(sql, ...args).toArray();
    return {
      all,
      get: (...args) => all(...args)[0],
      run: (...args) => {
        all(...args);
        // rowsWritten includes trigger/index work; changes() matches Node's
        // affected-row semantics used by invitation compare-and-swap checks.
        return { changes: this.storage.sql.exec('SELECT changes() AS n').one().n };
      }
    };
  }
  close() { /* Durable Object owns the storage lifetime. */ }
}

export const durableStorage = {
  version(db) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(marker);
    if (!exists) return 0;
    const row = db.prepare(`SELECT version FROM ${marker} WHERE singleton=1`).get();
    if (!row || !Number.isSafeInteger(row.version)) throw new Error('Missing database version marker');
    return row.version;
  },
  setVersion(db, version) {
    if (!db.isTransaction || !Number.isSafeInteger(version) || version < 1) throw new Error('Version changes require a migration transaction');
    db.exec(`CREATE TABLE IF NOT EXISTS ${marker} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO ${marker} VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version`).run(version);
  },
  hasSchema: db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' LIMIT 1").get()),
  configure(db, readOnly) {
    if (readOnly) throw new Error('Read-only connection mode is not supported by Durable Objects');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Foreign key enforcement required');
  },
  registerWriter() { /* SQL triggers check the durable version marker instead. */ },
  installWriterFence(db) {
    if (!db.isTransaction) throw new Error('Writer fence installation requires the migration transaction');
    for (const { name, sql } of fences) {
      const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
      if (!existing) db.exec(sql);
      else if (existing.sql !== sql) throw new Error('Database writer fence requires operator reconciliation');
    }
    this.setVersion(db, STORE_SCHEMA_VERSION);
  },
  verifyWriterFence(db) {
    for (const { name, sql } of fences) {
      if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql !== sql) {
        throw new Error('Database writer fence requires operator reconciliation');
      }
    }
  },
  transaction(db, fn) {
    if (db.isTransaction) return fn();
    return db.storage.transactionSync(() => {
      db.isTransaction = true;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('Room transactions must remain synchronous');
        return result;
      } finally { db.isTransaction = false; }
    });
  }
};
