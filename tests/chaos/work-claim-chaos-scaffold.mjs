// Shared harness for the PRODUCT-200 reliability chaos properties
// (worker C3: torn writes + history monotonicity).
//
// The frame follows C1's chaos-drill pattern (tests/chaos-drill.test.js): a
// killable fake of the Durable Object storage surface (`storage.sql.exec` +
// `storage.transactionSync`) under the REAL production `DurableDatabase` and
// `durableStorage.transaction` (cloudflare/storage.mjs), driving the REAL
// `createDurableWorkClaimRegistry` (server/work-claim-sqlite.mjs) and the
// REAL work-claim state machine (server/work-claims.mjs). No real network,
// no miniflare.
//
// Failure model: `storage.armKillBeforeMutatingOp(n)` throws a ChaosFault
// before the nth mutating statement. Inside `durableStorage.transaction`
// that models the DO isolate dying mid-write: the transaction journal is
// discarded and only committed state survives — exactly the contract the
// room's claim write path relies on (every route-level claim op runs inside
// `registry.transaction(...)`; see server/work-claim-routes.mjs and
// server/land-queue.mjs).
//
// The fault-injection hook lives HERE, in the test scaffold — production
// code is untouched. `armKillBeforeMutatingOp` is the test-only hook the
// task calls for; it is inherited from C1's harness frame, extended below
// with the work_claims / work_claim_config SQL surface.

import { DurableDatabase, durableStorage } from '../../cloudflare/storage.mjs';
import { STORE_SCHEMA_VERSION } from '../../server/writer-fence.mjs';
import {
  createDurableWorkClaimRegistry,
  workClaimSchema,
  WORK_CLAIM_ROW_KIND,
} from '../../server/work-claim-sqlite.mjs';
import { encodeRow } from '../../server/persisted-row.mjs';
import {
  createWork,
  claimWork,
  renewWork,
  updateWork,
  closeWork,
  reassignWork,
  attestWork,
  recordReview,
  appendWorkPullRequest,
  stampClaimHistory,
  releaseExpired,
  claimHistoryLength,
} from '../../server/work-claims.mjs';

export const ROOM_ID = 'chaos-room';
const KILL_MESSAGE = 'Durable Object isolate terminated mid-write (simulated kill)';

// The injected fault. Distinct class (not a message match) so the property
// can tell "the chaos hook fired" apart from domain refusals (ClaimError)
// and service errors. cloudflare/storage.mjs's tooBig() passes non-matching
// errors through unwrapped, so identity survives the wrapper.
export class ChaosFault extends Error {
  constructor(detail) {
    super(`${KILL_MESSAGE}${detail ? ` — ${detail}` : ''}`);
    this.name = 'ChaosFault';
    this.isChaosFault = true;
  }
}

const norm = sql => String(sql).replace(/\s+/g, ' ').trim().toUpperCase();
const claimKey = (roomId, claimId) => `${roomId}` + "\0" + `${claimId}`;
// Storage key for one claim row (exported for tests that address rows directly).
export const rowKey = (roomId, claimId) => claimKey(roomId, claimId);

// Exact copy of the permitSchema template in cloudflare/storage.mjs. If
// this drifts from production, durableStorage.transaction's verifyPermit
// throws "Database writer fence requires operator reconciliation" and every
// test here fails loudly — a deliberate canary, same as C1's drill.
const permitSchema = version =>
  `CREATE TABLE room_writer_permit (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version IN (0,${version})))`;

// Killable fake DO storage with the work-claim SQL surface. Durable state
// lives in Maps (the "SQLite file"); the active transaction journal is
// discarded on any throw, exactly like a killed isolate. Reads merge the
// journal (read-your-writes inside a transaction).
export class WorkClaimDoStorage {
  constructor() {
    const [claimsSchema, configSchema] = workClaimSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
    this.claimsSchema = claimsSchema.trim();
    this.schemas = {
      room_runtime_version:
        'CREATE TABLE room_runtime_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)',
      room_writer_permit: permitSchema(STORE_SCHEMA_VERSION),
      work_claims: this.claimsSchema,
      work_claim_config: configSchema.trim(),
    };
    this.state = {
      room_runtime_version: new Map([[1, { version: STORE_SCHEMA_VERSION }]]),
      room_writer_permit: new Map([[1, { version: 0 }]]), // 0 = idle, no writer holds it
      work_claims: new Map(), // claimKey -> { room_id, claim_id, item_json, updated_at }
      work_claim_config: new Map(), // roomId -> { room_id, config_json, updated_at }
    };
    this.journal = null; // null when no transaction is active
    this.mutatingOps = 0; // INSERT/UPDATE/DELETE counter (kill targeting)
    this.killBeforeOp = Infinity; // throw before this mutating op number
    this.lastChanges = 0;
    this.sql = { exec: (sql, ...args) => this.#exec(sql, args) };
  }

  // Test-only fault hook: fail the op at a chosen internal step by throwing
  // before the nth mutating statement. Absolute numbering: arm with
  // `storage.mutatingOps + k` to target the k-th mutating statement of the
  // next op. Arming beyond the op's last mutating statement = no fault.
  armKillBeforeMutatingOp(n) { this.killBeforeOp = n; }
  disarmKill() { this.killBeforeOp = Infinity; }

  transactionSync(fn) {
    const outer = this.journal;
    this.journal = [];
    try {
      const result = fn();
      for (const entry of this.journal) entry.apply(); // atomic: one synchronous step
      this.journal = outer;
      return result;
    } catch (error) {
      this.journal = outer; // discard: nothing committed
      throw error;
    }
  }

  #checkKillPoint(sql, mutating) {
    if (mutating) {
      this.mutatingOps += 1;
      if (this.mutatingOps >= this.killBeforeOp) {
        throw new ChaosFault(`before mutating op #${this.mutatingOps}: ${norm(sql).slice(0, 90)}`);
      }
    }
  }

  #journalize(entry) {
    if (!this.journal) throw new Error('chaos fake: mutating statement outside a transaction');
    this.journal.push(entry);
  }

  // Durable rows overlaid with journaled upserts/deletes.
  #liveRows(table) {
    const merged = new Map(this.state[table]);
    if (this.journal) {
      for (const entry of this.journal) {
        if (entry.table !== table) continue;
        if (entry.kind === 'delete') merged.delete(entry.key);
        else merged.set(entry.key, entry.row);
      }
    }
    return merged;
  }

  #exec(sql, args) {
    const q = norm(sql);
    const isMutating = /^(INSERT|UPDATE|DELETE)\b/.test(q);
    this.#checkKillPoint(sql, isMutating);
    const rows = this.#query(q, args);
    return { toArray: () => rows, one: () => rows[0] };
  }

  #query(q, args) {
    // sqlite_master probes (durableStorage.version / verifyPermit / registry.verifySchema)
    if (q === "SELECT 1 FROM SQLITE_MASTER WHERE TYPE='TABLE' AND NAME=?") {
      return this.schemas[args[0]] ? [{ 1: 1 }] : [];
    }
    if (q === 'SELECT SQL FROM SQLITE_MASTER WHERE NAME=?'
      || q === "SELECT SQL FROM SQLITE_MASTER WHERE NAME=? AND TYPE='TABLE'") {
      return [{ sql: this.schemas[args[0]] ?? null }];
    }
    if (q === 'SELECT VERSION FROM ROOM_RUNTIME_VERSION WHERE SINGLETON=1') {
      return [{ version: this.state.room_runtime_version.get(1).version }];
    }
    if (q === 'SELECT VERSION FROM ROOM_WRITER_PERMIT WHERE SINGLETON=1') {
      return [{ version: this.#liveRows('room_writer_permit').get(1).version }];
    }
    if (q === 'SELECT COUNT(*) N FROM ROOM_WRITER_PERMIT') {
      return [{ n: this.#liveRows('room_writer_permit').size }];
    }
    if (q === 'SELECT CHANGES() AS N') return [{ n: this.lastChanges }];
    const permitUpdate = q.match(/^UPDATE ROOM_WRITER_PERMIT SET VERSION=(\d+) WHERE SINGLETON=1$/);
    if (permitUpdate) {
      const version = Number(permitUpdate[1]);
      this.lastChanges = 1;
      this.#journalize({ kind: 'upsert', table: 'room_writer_permit', key: 1,
        row: { version }, sql: 'UPDATE room_writer_permit',
        apply: () => this.state.room_writer_permit.set(1, { version }) });
      return [];
    }
    // work_claims reads
    if (q === 'SELECT ITEM_JSON FROM WORK_CLAIMS WHERE ROOM_ID=? AND CLAIM_ID=?') {
      const row = this.#liveRows('work_claims').get(claimKey(args[0], args[1]));
      return row ? [{ item_json: row.item_json }] : [];
    }
    if (q === 'SELECT ITEM_JSON FROM WORK_CLAIMS WHERE ROOM_ID=? ORDER BY ROWID ASC') {
      const out = [];
      for (const row of this.#liveRows('work_claims').values()) {
        if (row.room_id === args[0]) out.push({ item_json: row.item_json });
      }
      return out;
    }
    // work_claims writes (journaled)
    if (q.startsWith('INSERT INTO WORK_CLAIMS')) {
      const [room_id, claim_id, item_json, updated_at] = args;
      this.lastChanges = 1;
      const key = claimKey(room_id, claim_id);
      const row = { room_id, claim_id, item_json, updated_at };
      this.#journalize({ kind: 'upsert', table: 'work_claims', key, row,
        sql: `INSERT INTO work_claims(${claim_id})`,
        apply: () => this.state.work_claims.set(key, row) });
      return [];
    }
    if (q === 'DELETE FROM WORK_CLAIMS WHERE ROOM_ID=? AND CLAIM_ID=?') {
      const key = claimKey(args[0], args[1]);
      this.lastChanges = this.#liveRows('work_claims').has(key) ? 1 : 0;
      this.#journalize({ kind: 'delete', table: 'work_claims', key,
        sql: `DELETE FROM work_claims(${args[1]})`,
        apply: () => this.state.work_claims.delete(key) });
      return [];
    }
    // work_claim_config
    if (q === 'SELECT CONFIG_JSON FROM WORK_CLAIM_CONFIG WHERE ROOM_ID=?') {
      const row = this.#liveRows('work_claim_config').get(args[0]);
      return row ? [{ config_json: row.config_json }] : [];
    }
    if (q.startsWith('INSERT INTO WORK_CLAIM_CONFIG')) {
      const [room_id, config_json, updated_at] = args;
      this.lastChanges = 1;
      const row = { room_id, config_json, updated_at };
      this.#journalize({ kind: 'upsert', table: 'work_claim_config', key: room_id, row,
        sql: 'INSERT INTO work_claim_config',
        apply: () => this.state.work_claim_config.set(room_id, row) });
      return [];
    }
    throw new Error(`work-claim chaos fake: unsupported SQL: ${q}`);
  }
}

// Build a claim room: real registry + real transaction wrapper over the
// killable fake. `clock` supplies the registry's `now` (updated_at).
// verifySchema() runs as a canary: the fake's work_claims DDL must match
// production's workClaimSchema exactly.
export function makeClaimRoom(clock) {
  const storage = new WorkClaimDoStorage();
  const db = new DurableDatabase(storage);
  const registry = createDurableWorkClaimRegistry(db, {
    now: () => clock.now(),
    transaction: fn => durableStorage.transaction(db, fn),
  });
  registry.verifySchema();
  return { storage, db, registry };
}

// Deterministic logical clock: strictly increasing ms, so every history
// stamp's `at` is unique and ordered across the whole test.
export function makeClock(startMs = 1784000000000) {
  let t = startMs;
  return {
    now: () => t,
    tick: (ms = 1000) => (t += ms),
    advance: ms => { t += ms; },
  };
}

// Seeded PRNG (mulberry32) so every interleaving is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Durable snapshot: every claim row's raw item_json plus config rows.
export function snapshotState(storage) {
  const claims = new Map();
  for (const [k, row] of storage.state.work_claims) claims.set(k, row.item_json);
  const config = new Map();
  for (const [k, row] of storage.state.work_claim_config) config.set(k, row.config_json);
  return { claims, config };
}

// The pure state-machine transition for one op — shared by the registry
// runner (after registry.get) and the independent model (on a detached
// item). `item` is null for create and for missing rows (workOf throws,
// mirroring the registry path's refusal).
export function transitionForOp(op, item, nowMs) {
  switch (op.kind) {
    case 'create':
      return createWork({ id: op.id, title: op.id }, { now: nowMs, agentId: op.agent });
    case 'claim':
      return claimWork(item, op.agent, { now: nowMs, leaseHours: op.leaseHours });
    case 'progress':
      return updateWork(item, op.agent, { state: op.state, now: nowMs, authority: !!op.authority });
    case 'note':
      return stampClaimHistory(item, op.agent, { action: 'note', note: op.text, now: nowMs });
    case 'renew':
      return renewWork(item, op.agent, { now: nowMs });
    case 'reassign':
      return reassignWork(item, op.agent, op.newOwner, { now: nowMs, authority: true });
    case 'release':
      return updateWork(item, op.agent, { state: 'unclaimed', now: nowMs, authority: true });
    case 'close':
      return closeWork(item, op.agent, { verb: op.verb, now: nowMs, authority: true });
    case 'attest':
      return attestWork(item, op.agent, { note: op.text, now: nowMs });
    case 'review':
      return recordReview(item, op.agent, { verdict: op.verdict, summary: 'chaos review', now: nowMs });
    case 'prlink':
      return appendWorkPullRequest(item, op.agent, {
        pullRequest: op.url,
        expectedClaimedAt: op.stale ? '1970-01-01T00:00:00.000Z' : item?.claimedAt,
        expectedHistoryLength: op.stale
          ? Math.max(0, claimHistoryLength(item) - 1)
          : claimHistoryLength(item),
        now: nowMs,
      });
    default:
      throw new Error(`unknown op kind: ${op.kind}`);
  }
}

// Run one op through the production-shaped path: read, pure transition,
// write, all inside a single registry transaction (the contract every
// route-level claim op honors). Multi-statement ops (delete's waive +
// delete, sweep's N sets) share that one transaction.
export function applyClaimOp(registry, roomId, op, nowMs) {
  const tx = registry.transaction ?? (fn => fn());
  return tx(() => {
    if (op.kind === 'create') return registry.set(roomId, transitionForOp(op, null, nowMs));
    if (op.kind === 'delete') { registry.delete(roomId, op.id); return null; }
    if (op.kind === 'sweep') {
      const items = registry.list(roomId);
      const next = releaseExpired(items, nowMs);
      for (const item of next) registry.set(roomId, item);
      return next;
    }
    const item = registry.get(roomId, op.id);
    return registry.set(roomId, transitionForOp(op, item, nowMs));
  });
}

// Random-op world. `ids` accumulates every id ever targeted (deleted ids
// stay targetable — a delete-then-touch exercises refusal paths).
export function makeWorld(roomId, rand) {
  return { roomId, rand, nextSeq: 0, ids: [],
    agents: ['agent-a', 'agent-b', 'agent-c', 'agent-d'] };
}

export function randomClaimOp(world) {
  const rand = world.rand;
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const r = rand();
  const freshId = () => `claim-${world.nextSeq++}`;
  if (world.ids.length === 0 || r < 0.16) {
    const id = freshId();
    world.ids.push(id);
    return { kind: 'create', id, agent: pick(world.agents) };
  }
  const id = pick(world.ids);
  const agent = pick(world.agents);
  if (r < 0.28) return { kind: 'claim', id, agent, leaseHours: rand() < 0.25 ? 0.002 : 24 };
  if (r < 0.40) return { kind: 'progress', id, agent, state: pick(['in_progress', 'blocked', 'done', 'claimed']), authority: rand() < 0.35 };
  if (r < 0.50) return { kind: 'note', id, agent, text: `chaos note ${Math.floor(rand() * 1e6)}` };
  if (r < 0.56) return { kind: 'renew', id, agent };
  if (r < 0.62) return { kind: 'reassign', id, agent, newOwner: pick(world.agents) };
  if (r < 0.68) return { kind: 'release', id, agent };
  if (r < 0.74) return { kind: 'close', id, agent, verb: pick(['close', 'cancel']) };
  if (r < 0.80) return { kind: 'attest', id, agent, text: `attest ${Math.floor(rand() * 1e6)}` };
  if (r < 0.84) return { kind: 'review', id, agent, verdict: pick(['approve', 'request_changes']) };
  if (r < 0.88) return { kind: 'prlink', id, agent,
    url: `https://github.com/uuriko/project-room/pull/${1 + Math.floor(rand() * 3000)}`, stale: rand() < 0.35 };
  if (r < 0.94) return { kind: 'delete', id };
  return { kind: 'sweep' };
}

// Seed two harnesses identically: several claims, the last depending on the
// rest (so delete() exercises the multi-statement waive + delete path),
// some claimed, one progressed. All clean — no faults during seeding.
export function seedRoom(registries, world, clock, rand) {
  const n = 2 + Math.floor(rand() * 4);
  const ids = [];
  for (let i = 0; i < n; i++) { const id = `seed-${world.nextSeq++}`; ids.push(id); world.ids.push(id); }
  for (const registry of registries) {
    registry.transaction(() => {
      ids.forEach((id, i) => {
        const dependsOn = i === ids.length - 1 ? ids.slice(0, -1) : [];
        registry.set(world.roomId,
          createWork({ id, title: id, dependsOn }, { now: clock.now(), agentId: 'seeder' }));
      });
    });
  }
  const claimed = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
  for (const id of claimed) {
    const nowMs = clock.tick();
    for (const registry of registries) {
      applyClaimOp(registry, world.roomId, { kind: 'claim', id, agent: 'agent-a', leaseHours: 24 }, nowMs);
    }
  }
  if (claimed.length > 0) {
    const nowMs = clock.tick();
    const id = claimed[0];
    for (const registry of registries) {
      applyClaimOp(registry, world.roomId, { kind: 'progress', id, agent: 'agent-a', state: 'in_progress' }, nowMs);
    }
  }
}

// What the registry should have stored for one model item: the persisted-row
// envelope bytes. Comparing parsed envelopes keeps the model independent of
// the registry's read path while tolerating JSON key order.
export function expectedRowData(item) {
  return JSON.parse(JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, item))).data;
}

export function storedRowData(itemJson) {
  return JSON.parse(itemJson).data;
}
