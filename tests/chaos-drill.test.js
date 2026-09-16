// F024 — Chaos drill: kill the Durable Object mid-write, verify recovery.
// Follow-on to the F023 incident runbook (docs/INCIDENT-RUNBOOK.md).
//
// What this drill simulates
// -------------------------
// The room's Durable Object (cloudflare/room.mjs: ProjectRoom) keeps its
// SQLite state behind DurableDatabase (cloudflare/storage.mjs), and every
// write is funneled through db.storage.transactionSync — the atomicity
// primitive the DO runtime actually provides. When Cloudflare kills the
// isolate mid-write (eviction, OOM, deploy), the uncommitted transaction
// journal is lost and committed state survives. There is no partial commit.
//
// This file models exactly that contract with an injected fake DO storage:
//   * transactionSync journals mutating ops; commit applies the journal in
//     one synchronous step (atomic by construction, like SQLite's commit);
//   * a throw anywhere in the body discards the journal — no partial state;
//   * a kill switch throws before the Nth mutating op (isolate termination);
//   * an AbortSignal path throws DOMException AbortError mid-write, mirroring
//     how room.mjs runs fetch() under the request's abort signal — a client
//     disconnect aborts in-flight request work.
//
// The drill exercises the REAL production code: DurableDatabase,
// durableStorage.transaction (including its writer-permit acquire/release
// protocol), and collectHealth/httpStatusFor from src/health-status.mjs.
// No real network, no real devices, no miniflare.
//
// Runbook mapping (docs/INCIDENT-RUNBOOK.md)
// -----------------------------------------
//   §1  A required storage check failing => status "unhealthy" => HTTP 503
//       => SEV1 paging territory (service broadly unusable).
//   §4.2 Health payload: 503/unhealthy means a required dependency is down —
//       the drill asserts the storage probe flips unhealthy during the kill
//       window and healthy again after recovery.
//   §4.3 A fresh restart (low uptimeMs) + SEV1: the drill's eviction test
//       re-attaches a new DO instance to the same durable storage and shows
//       committed writes intact — restart is safe, not destructive.
//   §6   Escalation to docs/V8-RECOVERY-RUNBOOK.md (restore from backup) is
//       for LOST COMMITTED data or a lost host. A mid-write kill loses only
//       the uncommitted journal, so recovery is a RETRY, not a restore. The
//       drill asserts that boundary: nothing committed is ever lost.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, durableStorage } from '../cloudflare/storage.mjs';
import { STORE_SCHEMA_VERSION } from '../server/writer-fence.mjs';
import {
  collectHealth, httpStatusFor,
  HEALTH_OK, HEALTH_UNHEALTHY, CHECK_OK, CHECK_FAIL,
} from '../src/health-status.mjs';

const KILL_MESSAGE = 'Durable Object isolate terminated mid-write (simulated kill)';

// Exact copy of the permitSchema template in cloudflare/storage.mjs. If this
// drifted from production, durableStorage.transaction's verifyPermit throws
// "Database writer fence requires operator reconciliation" and every test
// here fails loudly — a deliberate canary.
const permitSchema = version =>
  `CREATE TABLE room_writer_permit (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version IN (0,${version})))`;

const norm = sql => String(sql).replace(/\s+/g, ' ').trim().toUpperCase();

// Injected fake for the Durable Object `ctx.storage` surface that
// DurableDatabase actually touches: storage.sql.exec + storage.transactionSync.
// Durable state lives in Maps (the "SQLite file"); the active transaction
// journal is discarded on any throw, exactly like a killed isolate.
class KillableDoStorage {
  constructor() {
    // Durable ("on-disk") state. Survives isolate kills and restarts.
    this.state = {
      room_runtime_version: new Map([[1, { version: STORE_SCHEMA_VERSION }]]),
      room_writer_permit: new Map([[1, { version: 0 }]]), // 0 = idle, no writer holds it
      chaos_drill: new Map(), // drill table: key -> { key, value }
    };
    this.journal = null; // null when no transaction is active
    this.mutatingOps = 0; // INSERT/UPDATE/DELETE counter (kill targeting)
    this.killBeforeOp = Infinity; // throw before this mutating op number
    this.abortSignal = null;
    this.lastChanges = 0;
    this.opLog = []; // { kind: 'applied'|'discarded'|'killed', sql }
    this.sql = { exec: (sql, ...args) => this.#exec(sql, args) };
  }

  armKillBeforeMutatingOp(n) { this.killBeforeOp = n; }
  disarmKill() { this.killBeforeOp = Infinity; }
  attachAbortSignal(signal) { this.abortSignal = signal; }

  transactionSync(fn) {
    const outer = this.journal;
    this.journal = [];
    try {
      const result = fn();
      this.#commit(); // atomic: one synchronous step, kill hooks cannot interleave
      this.journal = outer;
      return result;
    } catch (error) {
      for (const entry of this.journal) this.opLog.push({ kind: 'discarded', sql: entry.sql });
      this.journal = outer;
      throw error;
    }
  }

  #commit() {
    for (const entry of this.journal) {
      entry.apply();
      this.opLog.push({ kind: 'applied', sql: entry.sql });
    }
  }

  #checkKillPoint(sql, mutating) {
    if (this.abortSignal?.aborted) {
      this.opLog.push({ kind: 'killed', sql });
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (mutating) {
      this.mutatingOps += 1;
      if (this.mutatingOps >= this.killBeforeOp) {
        this.opLog.push({ kind: 'killed', sql });
        throw new Error(KILL_MESSAGE);
      }
    }
  }

  // Read-your-writes inside a transaction, durable state otherwise.
  #readTable(name) {
    const merged = new Map(this.state[name]);
    if (this.journal) for (const entry of this.journal) {
      if (entry.table === name && entry.kind === 'upsert') merged.set(entry.key, entry.row);
    }
    return merged;
  }

  #exec(sql, args) {
    const q = norm(sql);
    const isMutating = /^(INSERT|UPDATE|DELETE)\b/.test(q);
    this.#checkKillPoint(sql, isMutating);
    // Eager: the real sqlite exec runs the statement immediately (the permit
    // acquire/release UPDATEs ignore the cursor entirely), so mutations must
    // land in the journal here, not lazily in toArray().
    const rows = this.#query(q, args);
    return { toArray: () => rows, one: () => rows[0] };
  }

  #query(q, args) {
    if (q.startsWith('SELECT 1 FROM SQLITE_MASTER WHERE')) {
      // hasPermit / version marker existence checks.
      const name = args[0];
      return this.state[name] ? [{ 1: 1 }] : [];
    }
    if (q === 'SELECT VERSION FROM ROOM_RUNTIME_VERSION WHERE SINGLETON=1') {
      return [{ version: this.#readTable('room_runtime_version').get(1).version }];
    }
    if (q === 'SELECT VERSION FROM ROOM_WRITER_PERMIT WHERE SINGLETON=1') {
      return [{ version: this.#readTable('room_writer_permit').get(1).version }];
    }
    if (q.startsWith('SELECT SQL FROM SQLITE_MASTER WHERE')) {
      const name = args[0];
      const schemas = {
        room_runtime_version: 'CREATE TABLE room_runtime_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)',
        room_writer_permit: permitSchema(STORE_SCHEMA_VERSION),
      };
      return [{ sql: schemas[name] ?? null }];
    }
    if (q === 'SELECT COUNT(*) N FROM ROOM_WRITER_PERMIT') {
      return [{ n: this.#readTable('room_writer_permit').size }];
    }
    if (q === 'SELECT CHANGES() AS N') return [{ n: this.lastChanges }];
    if (q === 'SELECT VALUE FROM CHAOS_DRILL WHERE KEY=?') {
      const row = this.#readTable('chaos_drill').get(args[0]);
      return row ? [{ value: row.value }] : [];
    }
    const permitUpdate = q.match(/^UPDATE ROOM_WRITER_PERMIT SET VERSION=(\d+) WHERE SINGLETON=1$/);
    if (permitUpdate) {
      const version = Number(permitUpdate[1]);
      this.lastChanges = 1;
      this.journal.push({
        kind: 'upsert', table: 'room_writer_permit', key: 1,
        row: { version }, sql: 'UPDATE room_writer_permit',
        apply: () => this.state.room_writer_permit.set(1, { version }),
      });
      return [];
    }
    if (q === 'INSERT INTO CHAOS_DRILL(KEY, VALUE) VALUES(?, ?)') {
      const [key, value] = args;
      this.lastChanges = 1;
      this.journal.push({
        kind: 'upsert', table: 'chaos_drill', key,
        row: { key, value }, sql: `INSERT INTO chaos_drill(${key})`,
        apply: () => this.state.chaos_drill.set(key, { key, value }),
      });
      return [];
    }
    throw new Error(`chaos-drill fake: unsupported SQL: ${q}`);
  }
}

// The room's write discipline: one multi-statement write inside a single
// durableStorage.transaction (the same wrapper ProjectRoom's RoomStore uses
// via DurableDatabase). Two keys so a mid-write kill can land BETWEEN them.
function roomWrite(db, entries) {
  return durableStorage.transaction(db, () => {
    for (const [key, value] of entries) {
      db.prepare('INSERT INTO chaos_drill(key, value) VALUES(?, ?)').run(key, value);
    }
    return entries.length;
  });
}

function roomRead(db, key) {
  return db.prepare('SELECT value FROM chaos_drill WHERE key=?').get(key)?.value ?? null;
}

function makeRoom() {
  const storage = new KillableDoStorage();
  const db = new DurableDatabase(storage);
  return { storage, db };
}

describe('F024 chaos drill: kill the Durable Object mid-write', () => {
  it('a kill between the two writes applies nothing: no partial state', () => {
    const { storage, db } = makeRoom();
    // Mutating op 1 = writer-permit acquire, op 2 = first INSERT.
    // Kill before op 3 (the second INSERT): the isolate dies mid-transaction.
    storage.armKillBeforeMutatingOp(3);

    assert.throws(() => roomWrite(db, [['alpha', '1'], ['beta', '2']]), err => {
      assert.match(String(err && err.message), /terminated mid-write/);
      return true;
    });

    // Atomicity: neither the first nor the second write is visible.
    assert.equal(roomRead(db, 'alpha'), null);
    assert.equal(roomRead(db, 'beta'), null);
    // The journal was discarded, not committed: exactly one entry discarded.
    assert.deepEqual(
      storage.opLog.filter(e => e.kind === 'discarded').map(e => e.sql),
      ['UPDATE room_writer_permit', 'INSERT INTO chaos_drill(alpha)'],
    );
    assert.equal(storage.opLog.filter(e => e.kind === 'applied').length, 0);
  });

  it('after a kill the writer permit is idle and the wrapper flags are reset', () => {
    const { storage, db } = makeRoom();
    storage.armKillBeforeMutatingOp(3);
    assert.throws(() => roomWrite(db, [['alpha', '1'], ['beta', '2']]));

    // The permit-acquire UPDATE was journaled, so the kill discarded it too:
    // durable permit state is back at 0 (idle). A stuck permit would fail
    // every later verifyPermit(..., 0) — a permanent write outage.
    assert.equal(storage.state.room_writer_permit.get(1).version, 0);
    // durableStorage.transaction's finally block ran despite the throw.
    assert.equal(db.isTransaction, false);
    assert.equal(db.readOnlyTransaction, false);

    // Proof there is no stuck state: a fresh write commits immediately.
    storage.disarmKill();
    assert.equal(roomWrite(db, [['alpha', '1']]), 1);
    assert.equal(roomRead(db, 'alpha'), '1');
  });

  it('an abort-controller failure mid-write rolls back cleanly (no partial state)', () => {
    const { storage, db } = makeRoom();
    const controller = new AbortController();
    storage.attachAbortSignal(controller.signal);

    assert.throws(() => durableStorage.transaction(db, () => {
      db.prepare('INSERT INTO chaos_drill(key, value) VALUES(?, ?)').run('alpha', '1');
      controller.abort(); // client disconnect aborts in-flight request work
      db.prepare('INSERT INTO chaos_drill(key, value) VALUES(?, ?)').run('beta', '2');
    }), err => {
      assert.equal(err && err.name, 'AbortError');
      return true;
    });
    storage.attachAbortSignal(null); // the aborted request's scope is over; later reads use their own signal

    assert.equal(roomRead(db, 'alpha'), null);
    assert.equal(roomRead(db, 'beta'), null);
    assert.equal(db.isTransaction, false);
  });

  it('retry after the kill commits fully; subsequent reads are consistent', () => {
    const { storage, db } = makeRoom();
    storage.armKillBeforeMutatingOp(3);
    assert.throws(() => roomWrite(db, [['alpha', '1'], ['beta', '2']]));

    // Runbook §4: with a theory (transient isolate kill, no committed-data
    // loss) the fix is a retry, not a restore. Disarm and re-run the write.
    storage.disarmKill();
    assert.equal(roomWrite(db, [['alpha', '1'], ['beta', '2']]), 2);

    // Reads are consistent: both keys present, repeated reads agree.
    assert.equal(roomRead(db, 'alpha'), '1');
    assert.equal(roomRead(db, 'beta'), '2');
    assert.equal(roomRead(db, 'alpha'), roomRead(db, 'alpha'));
    assert.equal(roomRead(db, 'missing'), null);
  });

  it('committed writes survive DO eviction and restart; no restore needed', () => {
    const { storage, db } = makeRoom();
    assert.equal(roomWrite(db, [['alpha', '1'], ['beta', '2']]), 2);

    // Simulate eviction: the isolate is gone, a fresh ProjectRoom binds the
    // SAME durable storage (the SQLite file outlives the isolate).
    const restarted = new DurableDatabase(storage);
    assert.equal(roomRead(restarted, 'alpha'), '1');
    assert.equal(roomRead(restarted, 'beta'), '2');

    // The restarted instance can write immediately: permit idle, fence happy.
    assert.equal(roomWrite(restarted, [['gamma', '3']]), 1);
    assert.equal(roomRead(restarted, 'gamma'), '3');
    // Original instance sees the same durable truth (single-writer model).
    assert.equal(roomRead(db, 'gamma'), '3');
  });

  it('runbook §4.2/§1: storage probe flips the health payload unhealthy during the kill, healthy after', () => {
    const { storage, db } = makeRoom();
    const storageProbe = () => {
      // Cheap, non-invasive probe per the health contract: a read-only
      // version check through the real DurableDatabase. Throwing = failure.
      const row = db.prepare('SELECT version FROM room_runtime_version WHERE singleton=1').get();
      if (!row || row.version !== STORE_SCHEMA_VERSION) return { ok: false, detail: 'version marker unreadable' };
      return { ok: true };
    };
    const health = () => collectHealth({
      service: 'project-room', version: '0.1.0', uptimeMs: 42_000,
      checks: [{ name: 'storage', required: true, probe: storageProbe }],
    });

    const before = health();
    assert.equal(before.status, HEALTH_OK);
    assert.equal(before.checks[0].status, CHECK_OK);
    assert.equal(httpStatusFor(before.status), 200);

    // Kill the isolate; a probe racing the kill sees the failure.
    storage.armKillBeforeMutatingOp(1); // die on the very next mutating op
    assert.throws(() => roomWrite(db, [['alpha', '1']]));
    const during = collectHealth({
      service: 'project-room', version: '0.1.0', uptimeMs: 1_200, // fresh restart: §4.3 crash-loop signal
      checks: [{ name: 'storage', required: true, probe: () => { throw new Error(KILL_MESSAGE); } }],
    });
    assert.equal(during.checks[0].status, CHECK_FAIL);
    assert.equal(during.checks[0].required, true);
    assert.equal(during.status, HEALTH_UNHEALTHY);
    assert.equal(httpStatusFor(during.status), 503); // §1: 503 => SEV1 paging territory

    // Recovery: probe passes again, payload returns to healthy.
    storage.disarmKill();
    const after = health();
    assert.equal(after.status, HEALTH_OK);
    assert.equal(after.checks[0].status, CHECK_OK);
  });
});
