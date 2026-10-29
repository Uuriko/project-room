import { STORE_SCHEMA_VERSION, fenceDefinitions, writerVersions } from '../server/writer-fence.mjs';
import { ServiceError } from '../server/service-error.mjs';

const marker = 'room_runtime_version';
const permit = 'room_writer_permit';
// Version and permit checks read sqlite_master. Cache them once per
// isolate on the underlying storage, so every wrapper sees a write made
// by another. A version write drops the cache. A transaction that throws
// drops it too: transactionSync rolls the SQL back, and a cached version
// or permit check would still describe the uncommitted write. The permit
// flip inside a committed transaction ends at 0, so a passed check for
// that value stays valid until the schema version changes.
const runtimeCache = new WeakMap();
const cacheKey = db => db.storage ?? db;
const cacheOf = db => {
  const key = cacheKey(db);
  let hit = runtimeCache.get(key);
  if (!hit) { hit = {}; runtimeCache.set(key, hit); }
  return hit;
};
const forgetRuntime = db => { runtimeCache.delete(cacheKey(db)); };
export const durableFenceDefinitions = version => fenceDefinitions(version).map(({ name, sql }) => ({ name,
  sql: sql.replace(`project_room_writer_v${version}()`, version < 8 ? `(SELECT version FROM ${marker} WHERE singleton=1)`
    : `(CASE WHEN (SELECT version FROM ${marker} WHERE singleton=1) IS ${version} AND (SELECT version FROM ${permit} WHERE singleton=1) IS ${version} THEN ${version} ELSE NULL END)`) }));
const fences = durableFenceDefinitions(STORE_SCHEMA_VERSION);
const reconciliation = (why = '') => { throw new Error('Database writer fence requires operator reconciliation' + (why ? ` [diag: ${why}]` : '')); };
const hasPermit = db => {
  const hit = cacheOf(db);
  if (hit.permitExists === true) return true;
  const exists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(permit));
  if (exists) hit.permitExists = true;
  return exists;
};
const permitValue = db => hasPermit(db) ? db.prepare(`SELECT version FROM ${permit} WHERE singleton=1`).get()?.version : null;
const permitSchema = version => `CREATE TABLE ${permit} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version IN (0,${version})))`;
const verifyPermit = (db, version, value) => {
  const hit = cacheOf(db);
  if (hit.permitOk && hit.permitVersion === version && hit.permitValue === value) return;
  const psql = db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(permit)?.sql;
  if (psql !== permitSchema(version)) reconciliation(`permit schema want v${version} got ${String(psql).slice(0, 160)}`);
  const pn = db.prepare(`SELECT count(*) n FROM ${permit}`).get().n;
  if (pn !== 1) reconciliation(`permit rows ${pn}`);
  const pv = permitValue(db);
  if (pv !== value) reconciliation(`permit value ${pv} want ${value} v${version}`);
  hit.permitOk = true;
  hit.permitVersion = version;
  hit.permitValue = value;
};

// A narrow adapter for the methods RoomStore actually uses. No SQL parsing,
// arbitrary rewrites, filesystem emulation, or pretend user-defined functions.
// G11b (2026-10-06): SQLite-backed Durable Objects refuse any string, BLOB
// or row past the platform ceiling with SQLITE_TOOBIG (local workerd: 2 MB;
// production holds a larger muse-room projection today, so the real ceiling
// is above 3.48 MB and undocumented). Map it to the same typed 409 the
// app-level PILOT_LIMITS checks return, so a write past the platform limit
// is a clean "no data was changed" refusal, never an opaque 500. The
// statement throws inside the write transaction, so nothing persists.
export const isTooBig = error => /SQLITE_TOOBIG|string or blob too big/i.test(String(error?.message ?? error));
const tooBig = error => isTooBig(error)
  ? new ServiceError(409, "pilot_limit", "Room storage limit reached (platform row limit); no data was changed")
  : error;

// Over-counting is harmless (an extra alarm re-arm); missing a write is not.
// So the rule is an allowlist of reads: after leading comments, one SELECT, or
// one WITH ... SELECT with no write keyword anywhere. Everything else counts as
// a write: INSERT/UPDATE/DELETE/REPLACE, WITH ... INSERT, PRAGMA, DDL, a write
// behind a leading comment, and any multi-statement exec ("SELECT 1; DELETE").
// A ";" inside a string literal also counts as multi-statement (over-count).
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
function readOnlySql(text) {
  const body = text.replace(LEADING_COMMENTS, "").replace(/[\s;]+$/, "");
  if (body.includes(";")) return false;
  if (/^SELECT\b/i.test(body)) return true;
  return /^WITH\b/i.test(body) && !WRITE_WORD.test(body);
}
const writeSqlCache = new Map();
export function isWriteSql(sql) {
  let hit = writeSqlCache.get(sql);
  if (hit === undefined) {
    hit = !readOnlySql(String(sql));
    if (writeSqlCache.size < 4096) writeSqlCache.set(sql, hit);
  }
  return hit;
}

export class DurableDatabase {
  constructor(storage, { observeStatement } = {}) {
    this.storage = storage; this.isTransaction = false; this.rowsRead = 0;
    // Write statements that changed rows. ProjectRoom.fetch compares it before
    // and after a request to skip re-arming the job alarm when nothing changed.
    this.writeStatements = 0;
    this.observeStatement = observeStatement;
  }
  // Observers receive only counters, never SQL, bindings or errors. Capture
  // ownership at execution, not prepare(): statements are reused across requests.
  #countRead(cursor) {
    try { const n = Number(cursor?.rowsRead ?? 0); if (n) this.rowsRead += n; }
    catch { /* unavailable diagnostic counters must not change SQL results */ }
  }
  // Only write-shaped SQL ever touches cursor.rowsWritten, so plain reads keep
  // the counter-free fast path. A write that changed no rows (a guarded no-op
  // UPDATE) does not count; an unknown or failed count does, to stay safe.
  #countWrite(sql, cursor) {
    if (!isWriteSql(sql)) return;
    let n;
    try { n = cursor?.rowsWritten; } catch { n = undefined; }
    if (!Number.isFinite(n) || n > 0) this.writeStatements += 1;
  }
  #observation() {
    let finish;
    try { finish = this.observeStatement?.(); } catch { /* diagnostics cannot break SQL */ }
    return (cursor, failed) => {
      let rowsRead = null, rowsWritten = null;
      try {
        if (Number.isSafeInteger(cursor?.rowsRead) && cursor.rowsRead >= 0) rowsRead = cursor.rowsRead;
        if (Number.isSafeInteger(cursor?.rowsWritten) && cursor.rowsWritten >= 0) rowsWritten = cursor.rowsWritten;
      } catch { /* unavailable counters remain unknown */ }
      this.#countRead(cursor);
      try { finish?.({ rowsRead, rowsWritten, failed }); } catch { /* diagnostics cannot break SQL */ }
    };
  }
  #all(sql, args) {
    const finish = this.observeStatement ? this.#observation() : null;
    let cursor, failed = false;
    try { cursor = this.storage.sql.exec(sql, ...args); return cursor.toArray(); }
    catch (error) { failed = true; throw tooBig(error); }
    finally { if (finish) finish(cursor, failed); else this.#countRead(cursor); this.#countWrite(sql, cursor); }
  }
  exec(sql) {
    return durableStorage.transaction(this, () => this.#all(sql, []));
  }
  prepare(sql) {
    const db = this;
    function* iterate(...args) {
      // Generator body starts on first next(), including observation capture.
      if (!db.observeStatement) {
        let cursor;
        try { cursor = db.storage.sql.exec(sql, ...args); yield* cursor; }
        catch (error) { throw tooBig(error); }
        finally { db.#countRead(cursor); db.#countWrite(sql, cursor); }
        return;
      }
      const finish = db.#observation();
      let cursor, failed = false;
      try {
        let iterator;
        try { cursor = db.storage.sql.exec(sql, ...args); iterator = cursor[Symbol.iterator](); }
        catch (error) { failed = true; throw error; }
        const observed = {
          [Symbol.iterator]() { return this; },
          next(...values) {
            try { return iterator.next(...values); }
            catch (error) { failed = true; throw error; }
          }
        };
        if (iterator.return) observed.return = (...values) => {
          try { return iterator.return(...values); }
          catch (error) { failed = true; throw error; }
        };
        // Consumer-injected throw/cancellation is not a proven SQL error.
        if (iterator.throw) observed.throw = (...values) => iterator.throw(...values);
        yield* observed;
      } catch (error) { throw tooBig(error); }
      finally { finish(cursor, failed); db.#countWrite(sql, cursor); }
    }
    const all = (...args) => this.#all(sql, args);
    return {
      all,
      iterate,
      get: (...args) => all(...args)[0],
      run: (...args) => durableStorage.transaction(this, () => {
        all(...args);
        // These raw calls and writer-permit maintenance are deliberately outside
        // the initial adapter-observed diagnostic, not claimed as total SQL cost.
        return { changes: this.storage.sql.exec('SELECT changes() AS n').one().n };
      })
    };
  }
  close() { /* Durable Object owns the storage lifetime. */ }
}

export const durableStorage = {
  clockSemantics: 'io-bound',
  version(db) {
    const hit = cacheOf(db);
    if (hit.versionKnown) return hit.version;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(marker);
    if (!exists) { hit.versionKnown = true; hit.version = 0; return 0; }
    const row = db.prepare(`SELECT version FROM ${marker} WHERE singleton=1`).get();
    if (!row || !Number.isSafeInteger(row.version)) throw new Error('Missing database version marker');
    hit.versionKnown = true;
    hit.version = row.version;
    return row.version;
  },
  setVersion(db, version) {
    forgetRuntime(db);
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
    // Current-version triggers are already correct; an idempotent re-run keeps
    // them (and only recreates the ones a repaired additive table is missing).
    const known = new Map(writerVersions.filter(v => v < STORE_SCHEMA_VERSION).flatMap(durableFenceDefinitions).map(def => [def.name, def.sql]));
    const current = new Map(fences.map(def => [def.name, def.sql]));
    // This synchronous invocation owns its snapshot; never cache it across
    // migrations or repairs. Deletions below update the install snapshot.
    const triggers = new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all().map(row => [row.name, row.sql]));
    for (const [name, sql] of triggers) {
      if (current.get(name) === sql) continue;
      if (known.get(name) !== sql) reconciliation();
      // 2026-09-30 (phase-3 audit LOW-1): validate the trigger name against
      // the expected pattern before interpolating into SQL. The name comes
      // from sqlite_master (not user input) and is already GLOB-filtered,
      // but defense-in-depth demands an explicit allowlist.
      if (!/^writer_v\d+_[A-Za-z0-9_]+_(insert|update|delete)$/.test(name)) reconciliation();
      db.exec(`DROP TRIGGER ${name}`);
      triggers.delete(name);
    }
    if (hasPermit(db) && permitValue(db) !== STORE_SCHEMA_VERSION) {
      if (!writerVersions.includes(db.migrationSource) || db.migrationSource < 8) reconciliation();
      verifyPermit(db, db.migrationSource, db.migrationSource);
      db.exec(`DROP TABLE ${permit}`);
      forgetRuntime(db);
    }
    if (!hasPermit(db)) {
      db.exec(permitSchema(STORE_SCHEMA_VERSION));
      db.storage.sql.exec(`INSERT INTO ${permit} VALUES(1,${STORE_SCHEMA_VERSION})`);
    }
    for (const { name, sql } of fences) {
      if (!triggers.has(name)) db.exec(sql);
      else if (triggers.get(name) !== sql) throw new Error('Database writer fence requires operator reconciliation');
    }
    this.setVersion(db, STORE_SCHEMA_VERSION);
  },
  verifyWriterFence(db, version = STORE_SCHEMA_VERSION) {
    const expected = new Map(writerVersions.filter(v => version < 8 ? v <= version : v === version).flatMap(durableFenceDefinitions).map(def => [def.name, def.sql]));
    const triggers = new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all().map(row => [row.name, row.sql]));
    for (const [name, sql] of triggers) {
      if (expected.get(name) !== sql) reconciliation(`trigger ${name} ${expected.has(name) ? 'drifted' : 'unknown'}`);
    }
    if (version >= 8) verifyPermit(db, version, db.isTransaction && !db.readOnlyTransaction ? version : 0);
    for (const { name, sql } of durableFenceDefinitions(version)) {
      if (triggers.get(name) !== sql) {
        reconciliation(`trigger ${name} missing or drifted`);
      }
    }
  },
  transaction(db, fn, readOnly = false, { isolated = false } = {}) {
    const run = () => {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('Room transactions must remain synchronous');
      return result;
    };
    if (db.isTransaction) {
      if (db.readOnlyTransaction && !readOnly) throw new Error('Cannot write inside a read-only Room transaction');
      // The native API supplies nested rollback; SQL SAVEPOINT is forbidden.
      // Critical storage faults can still abort the enclosing transaction.
      if (isolated) {
        try { return db.storage.transactionSync(run); }
        catch (error) { forgetRuntime(db); throw error; }
      }
      return run();
    }
    return db.storage.transactionSync(() => {
      const version = this.version(db);
      if (version !== STORE_SCHEMA_VERSION && version !== db.migrationSource) reconciliation(`version ${version} want ${STORE_SCHEMA_VERSION} src ${db.migrationSource}`);
      // A committed permit left at the writer version means an earlier write
      // transaction's closing flip was lost. The Durable Object is single
      // threaded, so no write is in flight at an outermost transaction start:
      // restore the invariant (permit 0) once, loudly, instead of refusing
      // every request until an operator edits the row.
      if (version >= 8 && hasPermit(db) && permitValue(db) === version) {
        console.error(JSON.stringify({ event: 'room.writer_permit_stale_reset', version }));
        db.storage.sql.exec(`UPDATE ${permit} SET version=0 WHERE singleton=1`);
        forgetRuntime(db);
      }
      if (version >= 8) verifyPermit(db, version, 0);
      db.isTransaction = true;
      db.readOnlyTransaction = readOnly;
      try {
        if (!readOnly && version >= 8) db.storage.sql.exec(`UPDATE ${permit} SET version=${version} WHERE singleton=1`);
        const result = run();
        if (!readOnly && hasPermit(db)) db.storage.sql.exec(`UPDATE ${permit} SET version=0 WHERE singleton=1`);
        if (this.version(db) === STORE_SCHEMA_VERSION) db.migrationSource = null;
        return result;
      } catch (error) {
        forgetRuntime(db);
        throw error;
      } finally { db.isTransaction = false; db.readOnlyTransaction = false; }
    });
  }
};
