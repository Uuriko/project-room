// chaos-kit.mjs — the chaos harness core: seeded PRNG, fault-injecting
// ChaosContext, and error types. Imported by both the runner
// (chaos-runner.mjs) and the scenarios. Kept in its own module so scenarios
// can import the kit without creating a circular import with the runner's
// top-level-await CLI entry point.

// A scenario is an async function against a scratch SQLite DB with seeded
// fault injection (delay / faulty fsync / order reversal / kill
// mid-transaction) and invariant checkers. The runner executes every
// scenario in tests/chaos/scenarios/*.mjs with a fixed seed and writes one
// JSONL line per scenario: {scenario, seed, faults, outcome, checks}.
//
// Determinism contract: the ONLY source of randomness is the seeded PRNG
// (mulberry32). No Math.random, no Date.now() in any decision path. Same
// seed + same scenario + same code => byte-identical report line (except
// the wall-clock `at` field, which the determinism check strips).
//

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32). The single allowed randomness source.
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive a per-scenario stream so scenario execution order cannot affect a
// scenario's draws: rng(stream) is a pure function of (seed, scenarioName).
export function streamRng(seed, streamName) {
  let h = 2166136261 >>> 0;
  const s = `${seed}:${streamName}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h >>> 0);
}

// ---------------------------------------------------------------------------
// Chaos errors
// ---------------------------------------------------------------------------

export class ChaosInvariantError extends Error {
  constructor(invariant, detail) {
    super(`invariant violated: ${invariant}${detail ? ` — ${detail}` : ""}`);
    this.name = "ChaosInvariantError";
    this.invariant = invariant;
    this.detail = detail;
  }
}

export class ChaosKillError extends Error {
  constructor(atStatement) {
    super(`process killed mid-transaction at statement ${atStatement}`);
    this.name = "ChaosKillError";
    this.atStatement = atStatement;
  }
}

// ---------------------------------------------------------------------------
// ChaosContext — the scenario DSL surface.
// ---------------------------------------------------------------------------

export class ChaosContext {
  #db;
  #dbPath;
  #rng;
  #faults = [];
  #checks = [];
  #statementCount = 0;
  #killAt = null; // statement index at which the process is "killed"
  #dbDir;

  constructor({ scenarioName, seed, dbPath, dbDir, rng }) {
    this.scenarioName = scenarioName;
    this.seed = seed;
    this.#dbPath = dbPath;
    this.#dbDir = dbDir;
    this.#rng = rng ?? streamRng(seed, scenarioName);
    this.#db = openDb(dbPath);
  }

  // -- randomness ----------------------------------------------------------
  /** Uniform float in [0, 1). */
  rand() {
    return this.#rng();
  }
  /** Integer in [min, max]. */
  int(min, max) {
    return min + Math.floor(this.#rng() * (max - min + 1));
  }
  /** Pick one element of a non-empty array. */
  pick(arr) {
    return arr[Math.floor(this.#rng() * arr.length)];
  }

  // -- database ------------------------------------------------------------
  get db() {
    return this.#db;
  }
  get dbPath() {
    return this.#dbPath;
  }
  get dbDir() {
    return this.#dbDir;
  }

  // -- fault injection ------------------------------------------------------
  #recordFault(fault) {
    this.#faults.push(fault);
  }
  get faults() {
    return this.#faults.map((f) => ({ ...f }));
  }

  /** Seeded scheduling point: marks an interleaving spot in the schedule.
   *  It is a real (zero-delay) yield so interleaved tasks can actually
   *  interleave; the position is fixed for a given seed + code. */
  async yieldPoint(label) {
    this.#recordFault({ type: "yield_point", label });
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Sleep a seeded 0..maxMs. Affects wall time only, never the outcome. */
  async delay(maxMs) {
    const ms = Math.floor(this.#rng() * (maxMs + 1));
    this.#recordFault({ type: "delay", ms });
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Simulate a failing fsync layer: durability guarantees are gone. The
   *  scenario should still keep its invariants after the DB recovers. */
  faultyFsync() {
    this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;");
    this.#recordFault({ type: "faulty_fsync" });
  }

  /** Seeded Fisher–Yates permutation. The full permutation is recorded so
   *  a report reader can replay the exact order. */
  shuffleInPlace(arr) {
    const permutation = arr.map((_, i) => i);
    for (let i = permutation.length - 1; i > 0; i--) {
      const j = Math.floor(this.#rng() * (i + 1));
      [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
    }
    const copy = arr.slice();
    for (let i = 0; i < arr.length; i++) arr[i] = copy[permutation[i]];
    this.#recordFault({ type: "order_reversal", permutation });
  }

  /** Arm a kill inside the next transaction: when the seeded statement
   *  index is reached, the DB connection is dropped abruptly (simulating
   *  a process crash mid-transaction). maxStatements bounds the draw. */
  armKill(maxStatements) {
    return this.armKillAt(1 + Math.floor(this.#rng() * maxStatements));
  }

  /** Arm a kill at an exact global statement index (the index itself is
   *  typically chosen by the scenario's own seeded draws, so the full
   *  schedule stays reproducible and auditable in the report). */
  armKillAt(index) {
    this.#killAt = index;
    this.#recordFault({ type: "kill_armed", at_statement: this.#killAt });
    return this.#killAt;
  }

  /** Call once per statement inside a transaction. Throws ChaosKillError
   *  (after dropping the connection) at the armed index. */
  statement() {
    this.#statementCount += 1;
    if (this.#killAt !== null && this.#statementCount === this.#killAt) {
      this.#killAt = null; // one shot
      const at = this.#statementCount;
      try {
        this.#db.close();
      } catch {
        // already gone — the kill still happened
      }
      this.#recordFault({ type: "kill_mid_transaction", at_statement: at });
      throw new ChaosKillError(at);
    }
  }

  /** Reopen the DB after a kill. SQLite's journal rolls the dead
   *  transaction back; the scenario then asserts its invariants. */
  reopenDb() {
    this.#db = openDb(this.#dbPath);
    this.#recordFault({ type: "db_reopened" });
  }

  /** Reset the statement counter (e.g. between transactions). */
  resetStatements() {
    this.#statementCount = 0;
  }

  // -- invariants ------------------------------------------------------------
  get checks() {
    return this.#checks.map((c) => ({ ...c }));
  }

  /** Record an invariant evaluation. Throws ChaosInvariantError on failure. */
  assertInvariant(name, ok, detail) {
    const check = { name, ok: Boolean(ok), detail: detail ?? null };
    this.#checks.push(check);
    if (!check.ok) throw new ChaosInvariantError(name, detail);
  }
}

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  return db;
}

// ---------------------------------------------------------------------------
// Scratch DB lifecycle
// ---------------------------------------------------------------------------

let scratchCounter = 0;

export function scratchDbPath(scenarioName, seed) {
  const base = process.env.TMPDIR || tmpdir();
  scratchCounter += 1;
  const dir = join(base, `chaos-${process.pid}-${scratchCounter}-${scenarioName}-${seed}`);
  mkdirSync(dir, { recursive: true });
  return { dir, path: join(dir, "chaos.sqlite") };
}

