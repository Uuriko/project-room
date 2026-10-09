// WAVE-400 fuzz-23: kill -9 mid-write chaos trial.
//
// The child writer hammers the REAL persistence path — RoomStore over a real
// sqlite file (nodeStorage pragmas: WAL + synchronous=FULL + busy_timeout=3000,
// BEGIN IMMEDIATE write transactions; registry server/work-claim-sqlite.mjs)
// with claim/update/renew/release writes as fast as it can. The parent
// SIGKILLs it 50-500ms after it starts writing, reopens the DB, and checks:
//
//   1. the DB opens cleanly (RoomStore constructor + migrations do not throw);
//   2. PRAGMA integrity_check returns "ok" (page-level, WAL recovery sound);
//   3. workClaims.verifySchema() passes (fail-closed schema check);
//   4. every work_claims row parses as JSON and decodes through the real
//      row codec (decodeRow is fail-closed: corrupt rows throw, never
//      silently decode) into a well-formed claim: id/state/owner/history/
//      lease internally consistent, history stamps shaped, no torn
//      half-applied rows.
//
// NOTE on server/work-claim-integrity.mjs: that module is board INPUT guards
// (text normalization, lease bounds, event budget) for the HTTP layer, not a
// database integrity checker — there is nothing in it that validates
// persisted rows. The applicable integrity checks for a kill-mid-write trial
// are PRAGMA integrity_check (WAL replay soundness) and verifySchema()
// (fail-closed schema shape), both run below.
//
// Dual-mode file: `node tests/fuzz-23-kill9-midwrite.test.js --fuzz-child
// <dbPath> <seed>` runs the writer loop (it never exits on its own — the
// parent kills it). Any other invocation runs the node:test kill-cycle suite.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CLAIM_HISTORY } from "../server/work-claims.mjs";

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32). Seed printed at start for reproducibility.
// ---------------------------------------------------------------------------
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-23 kill9-midwrite] seed=${SEED}`);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = dirname(THIS_FILE);
const ROOT = join(THIS_DIR, "..");

// ---------------------------------------------------------------------------
// Row well-formedness. These mirror the state machine's own construction
// rules (server/work-claims.mjs), read off the code, not assumed:
//
// - release (->unclaimed) and close/cancel (->closed) clear owner + lease;
//   finish (->done) KEEPS the owner's owner + lease (a torn write would be
//   the only way to see done/closed with a half-cleared lease pair).
// - claimWork sets claimedAt; createWork leaves it null; release keeps it.
// - every write stamps history (cap MAX_CLAIM_HISTORY) and sets updatedAt.
// ---------------------------------------------------------------------------
const CLAIM_STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done", "closed"];

function assertWellFormedClaim(item, cycle) {
  const where = `cycle ${cycle} claim ${item && typeof item.id === "string" ? item.id : "?"}`;
  assert.ok(item && typeof item === "object" && !Array.isArray(item), `${where}: row is not an object`);
  assert.equal(typeof item.id, "string", `${where}: id is not a string`);
  assert.ok(item.id.length > 0 && item.id.length <= 256, `${where}: id length ${item.id.length} out of range`);
  assert.ok(CLAIM_STATES.includes(item.state), `${where}: bad state ${JSON.stringify(item.state)}`);
  assert.equal(typeof item.title, "string", `${where}: title is not a string`);
  assert.ok(item.title.length > 0, `${where}: title is empty`);
  assert.ok(Array.isArray(item.history), `${where}: history is not an array`);
  assert.ok(item.history.length <= MAX_CLAIM_HISTORY,
    `${where}: history has ${item.history.length} entries (cap ${MAX_CLAIM_HISTORY})`);
  for (const [i, entry] of item.history.entries()) {
    const swhere = `${where} history[${i}]`;
    assert.ok(entry && typeof entry === "object", `${swhere}: stamp is not an object`);
    assert.equal(typeof entry.at, "string", `${swhere}: at is not a string`);
    assert.ok(Number.isFinite(Date.parse(entry.at)), `${swhere}: at is not a parseable timestamp`);
    assert.equal(typeof entry.agentId, "string", `${swhere}: agentId is not a string`);
    assert.ok(entry.agentId.length > 0, `${swhere}: agentId is empty`);
    assert.equal(typeof entry.action, "string", `${swhere}: action is not a string`);
    assert.ok(entry.action.length > 0, `${swhere}: action is empty`);
    assert.ok(entry.note === null || entry.note === undefined || typeof entry.note === "string",
      `${swhere}: note is not a string/null`);
  }
  if (item.historyOmitted !== undefined) {
    assert.ok(Number.isSafeInteger(item.historyOmitted) && item.historyOmitted >= 0,
      `${where}: historyOmitted is ${JSON.stringify(item.historyOmitted)}`);
  }
  assert.ok(Array.isArray(item.dependsOn), `${where}: dependsOn is not an array`);
  for (const dep of item.dependsOn) {
    assert.equal(typeof dep, "string", `${where}: dependsOn entry is not a string`);
    assert.ok(dep.length > 0, `${where}: dependsOn entry is empty`);
    assert.notEqual(dep, item.id, `${where}: claim depends on itself`);
  }
  for (const field of ["attestations", "reviews", "files"]) {
    assert.ok(Array.isArray(item[field]), `${where}: ${field} is not an array`);
  }
  assert.ok(item.updatedAt === null || typeof item.updatedAt === "string", `${where}: updatedAt is malformed`);
  if (typeof item.updatedAt === "string") {
    assert.ok(Number.isFinite(Date.parse(item.updatedAt)), `${where}: updatedAt is not a parseable timestamp`);
  }
  if (item.claimedAt !== null && item.claimedAt !== undefined) {
    assert.ok(typeof item.claimedAt === "string" && Number.isFinite(Date.parse(item.claimedAt)),
      `${where}: claimedAt is malformed`);
  }

  // Owner/lease consistency. release and close/cancel clear both; the finish
  // transition keeps the holder's owner + lease.
  if (item.state === "unclaimed" || item.state === "closed") {
    assert.strictEqual(item.owner, null, `${where}: ${item.state} but owner is ${JSON.stringify(item.owner)}`);
    assert.strictEqual(item.leaseStartAt, null, `${where}: ${item.state} but leaseStartAt is set`);
    assert.strictEqual(item.leaseExpiresAt, null, `${where}: ${item.state} but leaseExpiresAt is set`);
  } else {
    assert.equal(typeof item.owner, "string", `${where}: ${item.state} but owner is not a string`);
    assert.ok(item.owner.length > 0, `${where}: ${item.state} but owner is empty`);
    assert.equal(typeof item.claimedAt, "string", `${where}: ${item.state} but claimedAt is not a string`);
    assert.ok(Number.isFinite(Date.parse(item.claimedAt)), `${where}: ${item.state} but claimedAt is unparseable`);
    assert.equal(item.leaseStartAt === null, item.leaseExpiresAt === null,
      `${where}: leaseStartAt/leaseExpiresAt half-set (torn lease pair)`);
    if (item.leaseStartAt !== null) {
      const start = Date.parse(item.leaseStartAt), exp = Date.parse(item.leaseExpiresAt);
      assert.ok(Number.isFinite(start) && Number.isFinite(exp), `${where}: lease timestamps malformed`);
      assert.ok(exp > start, `${where}: leaseExpiresAt <= leaseStartAt`);
    }
  }
}

// ===========================================================================
// Child writer mode
// ===========================================================================
if (process.argv[2] === "--fuzz-child") {
  const dbPath = process.argv[3];
  const childSeed = Number(process.argv[4] ?? SEED);
  const { RoomStore } = await import("../server/store.mjs");
  const { createWork, claimWork, renewWork, updateWork } = await import("../server/work-claims.mjs");

  const rng = mulberry32(childSeed);
  const store = new RoomStore(dbPath);
  const registry = store.workClaims;
  const ROOMS = ["fz-room-a", "fz-room-b"];
  const AGENTS = ["fz-alice", "fz-bruno", "fz-cara", "fz-dot"];
  const IDS = Array.from({ length: 32 }, (_, i) => `fzc-${i}`);
  // Mirrors TRANSITIONS in server/work-claims.mjs (update-route moves only;
  // close/cancel have their own routes and are out of scope for this trial).
  const MOVES = {
    claimed: ["in_progress", "blocked", "unclaimed"],
    in_progress: ["blocked", "done", "claimed"],
    blocked: ["in_progress", "claimed"],
  };
  const pick = arr => arr[(rng() * arr.length) | 0];
  const leaseHours = () => (rng() < 0.1 ? null : 0.25 + rng() * 167.75);
  const note = n => (rng() < 0.5 ? null : `fuzz note op ${n} ${"x".repeat((rng() * 60) | 0)}`);

  // Expected rejects: state-machine check failures (ClaimError, e.g. a race
  // lost between get and set, lapsed lease, illegal transition) and sqlite
  // errors. Anything else is a real write-path crash: let it kill the child
  // so the parent records it as a violation.
  const expectedOrThrow = error => {
    if (error && (error.name === "ClaimError" || String(error.code ?? "").startsWith("ERR_SQLITE"))) return;
    throw error;
  };
  const write = fn => {
    try { registry.transaction(fn); }
    catch (error) { expectedOrThrow(error); }
  };

  process.stdout.write("ready\n"); // parent starts the kill timer from here
  let n = 0;
  for (;;) {
    n++;
    const r = rng();
    const room = pick(ROOMS);
    const agent = pick(AGENTS);
    const id = pick(IDS);
    if (r < 0.20) {
      // create (rotating ids collide on purpose; the upsert is one atomic row write)
      write(() => {
        const item = createWork({
          id, title: `fuzz claim ${id} op ${n}`, note: note(n),
          files: rng() < 0.3 ? [`server/fz-${(rng() * 40) | 0}.mjs`] : undefined,
        }, { now: Date.now(), agentId: agent });
        registry.set(room, item);
      });
    } else if (r < 0.45) {
      // claim
      const cur = registry.get(room, id);
      if (cur && cur.state === "unclaimed") {
        write(() => registry.set(room, claimWork(cur, agent,
          { leaseHours: leaseHours(), note: note(n), now: Date.now() })));
      }
    } else if (r < 0.60) {
      // renew (owner-only, active lease required)
      const cur = registry.get(room, id);
      if (cur && cur.state === "claimed" && cur.owner && cur.leaseExpiresAt) {
        write(() => registry.set(room, renewWork(cur, cur.owner,
          { leaseHours: leaseHours(), note: note(n), now: Date.now() })));
      }
    } else {
      // update: note-only, state move, or release (state -> unclaimed)
      const cur = registry.get(room, id);
      if (cur && cur.owner && (cur.state === "claimed" || cur.state === "in_progress" || cur.state === "blocked")) {
        const moves = MOVES[cur.state] ?? [];
        if (r < 0.72 || moves.length === 0) {
          write(() => registry.set(room, updateWork(cur, cur.owner,
            { note: note(n) ?? `heartbeat ${n}`, now: Date.now() })));
        } else {
          const next = pick(moves);
          write(() => registry.set(room, updateWork(cur, cur.owner,
            { state: next, note: note(n), now: Date.now() })));
        }
      }
    }
  }
}

// ===========================================================================
// Parent kill-cycle suite
// ===========================================================================
const CYCLES = Number(process.env.FUZZ_KILL_CYCLES ?? 200);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test(`kill -9 mid-write: ${CYCLES} SIGKILL cycles leave the claim board intact`, { timeout: 60 * 60 * 1000 }, async t => {
  // TMPDIR discipline: everything under the worktree .tmp, never default /tmp.
  const envTmp = process.env.TMPDIR;
  const tmpRoot = envTmp && envTmp.includes("pr-wave400-fuzz") ? envTmp : join(ROOT, ".tmp");
  assert.ok(resolve(tmpRoot).startsWith(resolve(ROOT)),
    `fuzz-23 refuses to run: tmpRoot ${tmpRoot} is outside the worktree`);
  if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "fuzz23-"));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const dbPath = join(dir, "room.sqlite");

  const { RoomStore } = await import("../server/store.mjs");

  const rng = mulberry32(SEED ^ 0x9e3779b9);
  const violations = [];
  let cyclesWithWrites = 0;
  let totalClaimsChecked = 0;

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const childSeed = (SEED + cycle * 7919) >>> 0;
    const child = spawn(process.execPath, [THIS_FILE, "--fuzz-child", dbPath, String(childSeed)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: tmpRoot },
    });
    let stdout = "", stderr = "", ready = false;
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("ready")) ready = true; });
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 16384) stderr = stderr.slice(-16384); });

    // Wait for the writer to actually be inside its write loop before the
    // kill window (cycle 0 also runs the full RoomStore migration chain).
    const deadline = Date.now() + 120000;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(25);
    }
    if (!ready) {
      violations.push({ cycle, type: "child-never-ready", exitCode: child.exitCode, signalCode: child.signalCode, stderr: stderr.slice(-2000) });
      try { child.kill("SIGKILL"); } catch {}
      continue;
    }
    cyclesWithWrites++;

    // Random kill window: 50-500ms of hammering, then SIGKILL (unkillable,
    // uncatchable — the closest userspace analog to power loss mid-write).
    await sleep(50 + rng() * 450);
    child.kill("SIGKILL");
    const exit = await new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
    if (exit.signal !== "SIGKILL") {
      violations.push({ cycle, type: "child-crashed", exit, stderr: stderr.slice(-2000) });
    }

    // Reopen the DB on the REAL path and run the checks.
    let store = null;
    try {
      store = new RoomStore(dbPath);
      const page = store.db.prepare("PRAGMA integrity_check").get();
      const integrity = page && (page.integrity_check ?? Object.values(page)[0]);
      if (integrity !== "ok") {
        violations.push({ cycle, type: "integrity-check", result: integrity });
      }
      // Fail-closed schema check: throws on mismatch, never silently wrong.
      store.workClaims.verifySchema();
      // Raw JSON parse of every row first (catches torn JSON), then decode
      // + well-formedness per claim through the real row codec (decodeRow
      // throws on corrupt rows — fail-closed, attributed per claim).
      const rooms = store.db.prepare("SELECT DISTINCT room_id FROM work_claims").all().map(r => r.room_id);
      for (const room of rooms) {
        const raw = store.db.prepare("SELECT claim_id, item_json FROM work_claims WHERE room_id=?").all(room);
        for (const row of raw) {
          try { JSON.parse(row.item_json); }
          catch (error) {
            violations.push({ cycle, type: "torn-json", room, claim: row.claim_id, error: String(error).slice(0, 300) });
            continue;
          }
          let item;
          try { item = store.workClaims.get(room, row.claim_id); }
          catch (error) {
            violations.push({ cycle, type: "decode-failed", room, claim: row.claim_id, error: String(error).slice(0, 300) });
            continue;
          }
          totalClaimsChecked++;
          try { assertWellFormedClaim(item, cycle); }
          catch (error) { violations.push({ cycle, type: "torn-row", room, claim: row.claim_id, error: error.message }); }
        }
      }
    } catch (error) {
      violations.push({ cycle, type: "reopen-failed", error: String((error && error.stack) || error).slice(0, 2000) });
    } finally {
      try { store?.db?.close(); } catch {}
    }

    if ((cycle + 1) % 25 === 0) {
      console.log(`[fuzz-23 kill9-midwrite] ${cycle + 1}/${CYCLES} cycles, ${violations.length} violations, ${totalClaimsChecked} claim reads`);
    }
  }

  console.log(`[fuzz-23 kill9-midwrite] done: ${CYCLES} cycles, ${cyclesWithWrites} reached write loop, ` +
    `${totalClaimsChecked} claim reads, ${violations.length} violations`);
  assert.equal(violations.length, 0,
    `${violations.length} invariant violations across ${CYCLES} kill cycles:\n` +
    violations.slice(0, 10).map(v => JSON.stringify(v)).join("\n"));
});
