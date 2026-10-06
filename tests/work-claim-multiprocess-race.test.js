// Multi-process work-claim race stress test.
//
// Round 2 QA flagged multi-process claim races as untested. This drives the
// REAL storage layer (server/work-claim-sqlite.mjs over node:sqlite, WAL +
// busy_timeout=3000, BEGIN IMMEDIATE write transactions — the exact
// discipline server/store.mjs nodeStorage applies in production) from N
// separate OS processes racing to claim the same item, then racing
// heartbeats, then settling.
//
// Contract under test:
//  1. Exactly one process wins the claim; every loser gets a clean 409
//     conflict — never a 500, never a silent double-win.
//  2. A loser's lease heartbeat cannot clobber the winner's lease
//     (refused cleanly; leaseExpiresAt and history untouched).
//  3. The final board state is consistent: one owner, one "claimed" stamp,
//     sane history.
//
// The worker half of this file runs in the child processes
// (node tests/work-claim-multiprocess-race.test.js --race-worker ...);
// the parent half spawns them and asserts the outcome.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { createWork, claimWork, renewWork, updateWork, claimHistoryLength } from "../server/work-claims.mjs";

const WORKERS = 10;
const ROOM = "race-room";
const CLAIM_ID = "race-claim-1";

// Production storage discipline, mirroring server/store.mjs nodeStorage:
// WAL, FULL sync, 3s busy timeout, BEGIN IMMEDIATE write transactions.
// busy_timeout is set BEFORE journal_mode: a contended journal-mode change
// or WAL recovery during concurrent opens would otherwise throw
// SQLITE_BUSY immediately (timeout still zero), which is a setup race, not
// the claim race under test.
function openRaceDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  return db;
}

function immediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}

function registryFor(db) {
  return createDurableWorkClaimRegistry(db, { transaction: fn => immediate(db, fn) });
}

// --- worker ---------------------------------------------------------------
async function workerMain() {
  const [, , , dbPath, goFile, phase, agentId] = process.argv;
  const out = result => { process.stdout.write(JSON.stringify(result) + "\n"); };
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(goFile)) {
      if (Date.now() > deadline) throw new Error("start barrier timeout");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Deterministic stagger so arrivals overlap instead of lock-stepping.
    const slot = Number(agentId.split("-")[1]) || 0;
    await new Promise(resolve => setTimeout(resolve, (slot * 7) % 50));
    const db = openRaceDb(dbPath);
    try {
      const registry = registryFor(db);
      if (phase === "claim") {
        const item = registry.transaction(() => {
          const current = registry.get(ROOM, CLAIM_ID);
          if (!current) throw Object.assign(new Error("missing"), { status: 404, code: "work_claim_not_found" });
          if (current.state !== "unclaimed") {
            throw Object.assign(new Error(`already ${current.state}`), { status: 409, code: "work_claim_conflict" });
          }
          const claimed = claimWork(current, agentId, { now: Date.now() });
          registry.set(ROOM, claimed);
          return claimed;
        });
        out({ ok: true, owner: item.owner, phase });
      } else if (phase === "renew") {
        const item = registry.transaction(() => {
          const renewed = renewWork(registry.get(ROOM, CLAIM_ID), agentId, { now: Date.now() });
          registry.set(ROOM, renewed);
          return renewed;
        });
        out({ ok: true, owner: item.owner, leaseExpiresAt: item.leaseExpiresAt, phase });
      } else if (phase === "settle") {
        const item = registry.transaction(() => {
          const current = registry.get(ROOM, CLAIM_ID);
          const progressed = updateWork(current, agentId, { state: "in_progress", now: Date.now() });
          registry.set(ROOM, progressed);
          const done = updateWork(registry.get(ROOM, CLAIM_ID), agentId, { state: "done", now: Date.now() });
          registry.set(ROOM, done);
          return done;
        });
        out({ ok: true, owner: item.owner, state: item.state, phase });
      } else {
        throw new Error(`unknown phase ${phase}`);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    // ClaimError / conflict refusals are clean outcomes; anything else
    // (SQLITE_BUSY, IOERR, crashes) surfaces as a dirty 500 for the parent
    // to fail on.
    const clean = error?.status === 409 || error?.status === 404 || error?.name === "ClaimError";
    out({ ok: false, phase, agentId, code: clean ? (error.status ?? 409) : 500,
      errorCode: error?.code ?? null, message: String(error?.message ?? error).slice(0, 200) });
  }
}

if (process.argv.includes("--race-worker")) {
  await workerMain();
  process.exit(0);
}

// --- parent ---------------------------------------------------------------
function runWorkers(dbPath, goFile, phase, agents) {
  const list = Array.isArray(agents) ? agents : Array.from({ length: agents }, (_, i) => `racer-${i}`);
  const runOne = agentId => new Promise(resolve => {
    execFile(process.execPath, [process.argv[1], "--race-worker", dbPath, goFile, phase, agentId],
      { timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, phase, agentId, code: 500, message: `worker failed: ${String(error.message).slice(0, 160)}` });
        const line = String(stdout).trim().split("\n").pop();
        try { resolve(JSON.parse(line)); }
        catch { resolve({ ok: false, phase, agentId, code: 500, message: `unparseable worker output: ${String(stdout).slice(0, 160)}` }); }
      });
  });
  const pending = list.map(runOne);
  writeFileSync(goFile, "go"); // release the barrier once every worker is spawned
  return Promise.all(pending);
}

test("multi-process claim race: exactly one winner, clean 409s, consistent board", async t => {
  // The race database lives under the worktree .tmp (never /tmp, never prod).
  const dir = join(dirname(fileURLToPath(import.meta.url)), ".tmp", `claim-race-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const dbPath = join(dir, "race.db");
  const goFile = join(dir, "go");

  const seed = openRaceDb(dbPath);
  seed.exec(workClaimSchema);
  const seedRegistry = registryFor(seed);
  seedRegistry.transaction(() => {
    seedRegistry.set(ROOM, createWork({ id: CLAIM_ID, title: "race target" }, { now: Date.now(), agentId: "system" }));
  });
  seed.close();

  // Phase 1: the race.
  const claims = await runWorkers(dbPath, goFile, "claim", WORKERS);
  const winners = claims.filter(r => r.ok);
  const losers = claims.filter(r => !r.ok);
  assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}: ${JSON.stringify(claims)}`);
  assert.equal(losers.length, WORKERS - 1);
  for (const loser of losers) {
    assert.equal(loser.code, 409, `loser ${loser.agentId} must get a clean 409, got ${JSON.stringify(loser)}`);
  }
  const winnerId = winners[0].owner;
  assert.match(winnerId, /^racer-\d+$/, "winner is one of the racers");

  // Phase 2: heartbeats — the winner renews, losers must fail cleanly
  // without touching the lease or the history.
  const before = (() => { const db = openRaceDb(dbPath); try { return registryFor(db).get(ROOM, CLAIM_ID); } finally { db.close(); } })();
  const goFile2 = join(dir, "go2");
  const renewals = await runWorkers(dbPath, goFile2, "renew", WORKERS);
  const renewWins = renewals.filter(r => r.ok);
  assert.equal(renewWins.length, 1, `exactly one renew succeeds: ${JSON.stringify(renewals)}`);
  assert.equal(renewWins[0].owner, winnerId, "only the claim winner can renew");
  assert.ok(Date.parse(renewWins[0].leaseExpiresAt) > Date.parse(before.leaseExpiresAt), "winner lease extends");
  const after = (() => { const db = openRaceDb(dbPath); try { return registryFor(db).get(ROOM, CLAIM_ID); } finally { db.close(); } })();
  assert.equal(after.owner, winnerId, "loser heartbeats did not clobber the owner");
  assert.equal(after.leaseExpiresAt, renewWins[0].leaseExpiresAt, "loser heartbeats did not move the lease");
  assert.equal(claimHistoryLength(after), claimHistoryLength(before) + 1, "only the winner's renew stamped history");

  // Phase 3: the winner settles; final state must be consistent.
  const goFile3 = join(dir, "go3");
  const settles = await runWorkers(dbPath, goFile3, "settle", [winnerId]);
  assert.equal(settles[0].ok, true, `winner settles cleanly: ${JSON.stringify(settles[0])}`);
  const final = (() => { const db = openRaceDb(dbPath); try { return registryFor(db).get(ROOM, CLAIM_ID); } finally { db.close(); } })();
  assert.equal(final.state, "done");
  assert.equal(final.owner, winnerId);
  const claimedStamps = final.history.filter(h => h.action === "claimed");
  assert.equal(claimedStamps.length, 1, "exactly one claimed stamp in history");
  assert.equal(claimedStamps[0].agentId, winnerId, "the claimed stamp names the winner");
  assert.ok(!final.history.some(h => h.action === "claimed" && h.agentId !== winnerId), "no phantom winner in history");
});

