import { STORE_SCHEMA_VERSION, fenceDefinitions } from '../server/writer-fence.mjs';

const marker = 'room_runtime_version';
const permit = 'room_writer_permit';
export const durableFenceDefinitions = version => fenceDefinitions(version).map(({ name, sql }) => ({ name,
  sql: sql.replace(`project_room_writer_v${version}()`, version < 8 ? `(SELECT version FROM ${marker} WHERE singleton=1)`
    : `(CASE WHEN (SELECT version FROM ${marker} WHERE singleton=1) IS ${version} AND (SELECT version FROM ${permit} WHERE singleton=1) IS ${version} THEN ${version} ELSE NULL END)`) }));
const fences = durableFenceDefinitions(STORE_SCHEMA_VERSION);
const reconciliation = () => { throw new Error('Database writer fence requires operator reconciliation'); };
const hasPermit = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(permit));
const permitValue = db => hasPermit(db) ? db.prepare(`SELECT version FROM ${permit} WHERE singleton=1`).get()?.version : null;
const permitSchema = version => `CREATE TABLE ${permit} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version IN (0,${version})))`;
const verifyPermit = (db, version, value) => {
  if (db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(permit)?.sql !== permitSchema(version)
    || db.prepare(`SELECT count(*) n FROM ${permit}`).get().n !== 1 || permitValue(db) !== value) reconciliation();
};

// A narrow adapter for the methods RoomStore actually uses. No SQL parsing,
// arbitrary rewrites, filesystem emulation, or pretend user-defined functions.
export class DurableDatabase {
  constructor(storage) { this.storage = storage; this.isTransaction = false; }
  exec(sql) { return durableStorage.transaction(this, () => this.storage.sql.exec(sql).toArray()); }
  prepare(sql) {
    const all = (...args) => this.storage.sql.exec(sql, ...args).toArray();
    return {
      all,
      get: (...args) => all(...args)[0],
      run: (...args) => durableStorage.transaction(this, () => {
        all(...args);
        // rowsWritten includes trigger/index work; changes() matches Node's
        // affected-row semantics used by invitation compare-and-swap checks.
        return { changes: this.storage.sql.exec('SELECT changes() AS n').one().n };
      })
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
  registerWriter(db) { db.migrationSource = this.version(db) < STORE_SCHEMA_VERSION ? this.version(db) : null; },
  installWriterFence(db) {
    if (!db.isTransaction) throw new Error('Writer fence installation requires the migration transaction');
    // Marker-based old guards must be removed before moving the shared marker.
    // Only exact, previously verified historical definitions may be removed.
    const known = new Map([6, 7, 8].flatMap(durableFenceDefinitions).map(def => [def.name, def.sql]));
    for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all()) {
      if (known.get(row.name) !== row.sql) reconciliation();
      db.exec(`DROP TRIGGER ${row.name}`);
    }
    if (hasPermit(db)) {
      if (db.migrationSource !== 8) reconciliation();
      verifyPermit(db, 8, 8);
      db.exec(`DROP TABLE ${permit}`);
    }
    db.exec(permitSchema(STORE_SCHEMA_VERSION));
    db.storage.sql.exec(`INSERT INTO ${permit} VALUES(1,${STORE_SCHEMA_VERSION})`);
    for (const { name, sql } of fences) {
      const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
      if (!existing) db.exec(sql);
      else if (existing.sql !== sql) throw new Error('Database writer fence requires operator reconciliation');
    }
    this.setVersion(db, STORE_SCHEMA_VERSION);
  },
  verifyWriterFence(db, version = STORE_SCHEMA_VERSION) {
    const expected = new Map([6, 7, 8, 9].filter(v => version < 8 ? v <= version : v === version).flatMap(durableFenceDefinitions).map(def => [def.name, def.sql]));
    for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all()) {
      if (expected.get(row.name) !== row.sql) reconciliation();
    }
    if (version >= 8) verifyPermit(db, version, db.isTransaction && !db.readOnlyTransaction ? version : 0);
    for (const { name, sql } of durableFenceDefinitions(version)) {
      if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql !== sql) {
        throw new Error('Database writer fence requires operator reconciliation');
      }
    }
  },
  transaction(db, fn, readOnly = false) {
    const run = () => {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('Room transactions must remain synchronous');
      return result;
    };
    if (db.isTransaction) {
      if (db.readOnlyTransaction && !readOnly) throw new Error('Cannot write inside a read-only Room transaction');
      return run();
    }
    return db.storage.transactionSync(() => {
      const version = this.version(db);
      if (version !== STORE_SCHEMA_VERSION && version !== db.migrationSource) reconciliation();
      if (version >= 8) verifyPermit(db, version, 0);
      db.isTransaction = true;
      db.readOnlyTransaction = readOnly;
      try {
        if (!readOnly && version >= 8) db.storage.sql.exec(`UPDATE ${permit} SET version=${version} WHERE singleton=1`);
        const result = run();
        if (!readOnly && hasPermit(db)) db.storage.sql.exec(`UPDATE ${permit} SET version=0 WHERE singleton=1`);
        if (this.version(db) === STORE_SCHEMA_VERSION) db.migrationSource = null;
        return result;
      } finally { db.isTransaction = false; db.readOnlyTransaction = false; }
    });
  }
};
