// WAVE-400 fuzz worker: spend-grant crash-consistency.
// The request-ID kill-trial pattern: persist-then-send.
//
// Two flows, both driven against the REAL production functions in
// server/spend-grants.mjs (no test-only seams in the money path):
//
//   A/B. Charge path. authorizeSpend(db, {nonce}) persists the dedupe record
//        (spend_authorizations row, PRIMARY KEY (room_id, agent_id, nonce))
//        inside its transaction BEFORE the caller performs the external
//        "send" (the priced tool invocation); settle()/void() is the ack.
//        The nonce IS the request ID. Code-read verification: authorizeSpend
//        INSERTs the 'reserved' row in transact() and returns the handle;
//        production callers (callRoomTool in server/mcp-room-profile.mjs,
//        server/mcp-full-profile.mjs) invoke the tool only afterwards, and
//        settle on success / void on failure. The 'reserved'-replay path is
//        the crash-recovery protocol: a retry with the same nonce gets the
//        live authorization back instead of a second charge.
//   C/D. Issuance path. A test-local request-ID wrapper around the real
//        issueSpendGrant implements persist-then-send explicitly:
//        dedupe row -> grant rows -> send -> ack. Re-issue is upsert-safe
//        (server/grants.mjs issueGrant), so retries can never widen the cap.
//
// Crash points (CP0/CP1/CP2), fuzzed per trial:
//   CP0: before persist — nothing durable; retry must start clean.
//   CP1: between persist and send — dedupe/grant durable, send not done;
//        retry must dedupe (no second row) and complete exactly once.
//   CP2: after send before ack — send durable, ack not done; retry must not
//        re-send and must settle exactly once.
//
// Invariants (asserted after every trial):
//   I1 retry after ANY crash point never double-grants: exactly one
//      authorization row per request ID; the balance delta (charge) is
//      applied exactly once.
//   I2 the dedupe record is persisted BEFORE the first external send: a
//      kill between persist and send still dedupes on retry (replay path,
//      no second row). A "persisted" marker with no durable row is a bug.
//   I3 no grant is silently lost: every persisted grant ends settled (sent)
//      or is retryable; voided/reaped reservations free the cap, never charge.
//
// Method: A/C simulate crashes in-process by throwing at the crash point and
// retrying with the same request ID (seeded). B/D spawn a real child node
// process on a real sqlite file, SIGKILL it mid-run, reopen the DB, and
// retry — the kill cases the task requires. A final orphan sweep recovers
// rows whose commit landed but whose marker was lost to the kill.
//
// Trial budget: A=360, B=150 children, C=120, D=10 children => 640 trials,
// covering CP0/CP1/CP2 on both flows. Plus hostile nonce-reuse variants and
// the documented lease-expiry (409 duplicate_nonce) boundary.
//
// VERIFIED (WAVE-400, 2026-10-08, seed 20261008, node v24.20.0): all 6 tests
// PASS (~178s). Actual kill/retry trials: A=360 (CP0/CP1/CP2 = 120/120/120)
// + 10 hostile + 36 fresh-nonce probes; C=120 (40/40/40) + 20 hostile
// cap-widen retries deduped; B=161 children, all SIGKILLed, 145 kill trials
// (cp0=10, cp1=87, cp2=48), 495 rows settled exactly-once, 0 orphans;
// D=11 children, 10 kill trials (cp1=4, cp2=6), 16 requests all done.
// Total kill/retry trials across all crash points: 635 (>= 500).
// ZERO double-grants, ZERO lost grants. Lease-expiry quirk re-verified:
// same-nonce retry past the lease -> 409 and the reaper's void is rolled
// back (row stays 'reserved', cap headroom leaks) until the NEXT COMMITTED
// authorizeSpend reaps it; fresh-nonce recovery voids durably and charges
// exactly once. Reported as a confirmed MINOR bug (no money violation),
// not fixed (test-only lane).
//
// Hard rules honored: this file is the ONLY write; server/, scripts/,
// docs/ untouched; no new dependencies (node builtins only); TMPDIR honored.
//
// Performance note: this FS fsyncs at ~160ms/commit. The in-process fuzz
// (A/C) simulates crashes with JS throws in the same connection, so
// OS-crash durability is not under test there — those DBs run with
// PRAGMA journal_mode=MEMORY, synchronous=OFF (retry/dedupe/replay logic
// is identical). The kill fuzz (B/D) keeps FULL durability: real kill -9,
// real fsyncs, real recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authorizeSpend,
  issueSpendGrant,
  ensureSpendGrantsSchema,
  remainingSpendCents,
  SpendGrantError,
  RESERVE_LEASE_MS,
} from "../server/spend-grants.mjs";
import { ensureGrantsSchema } from "../server/grants.mjs";
import { ensureAutonomyTiersSchema, setTier } from "../server/autonomy-tiers.mjs";

const SELF = fileURLToPath(import.meta.url);
const CHILD_MODE = process.argv.includes("--fuzz-child");

// Seeded RNG (mulberry32). Same seed => same crash schedule.
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
if (!CHILD_MODE) console.log(`FUZZ_SEED=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TMPBASE = process.env.TMPDIR || tmpdir();
const ROOM = "fuzz-room";
const OWNER = "owner-1";
const CRASH = new Error("fuzz: simulated crash before/after persist");
const ICRASH = new Error("fuzz: simulated crash in issuance flow");

function openFuzzDb(path, { durable = true } = {}) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  if (!durable) {
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("PRAGMA synchronous = OFF");
  }
  ensureGrantsSchema(db);
  ensureSpendGrantsSchema(db);
  ensureAutonomyTiersSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS fuzz_sends(
    nonce TEXT PRIMARY KEY, agent_id TEXT NOT NULL, price_cents TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS fuzz_issue_dedupe(
    request_id TEXT PRIMARY KEY, status TEXT NOT NULL, agent_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS fuzz_issue_sends(request_id TEXT PRIMARY KEY)`);
  return db;
}

function freshDb(t, tag, opts) {
  const dir = mkdtempSync(join(TMPBASE, `fuzz20-${tag}-`));
  const dbPath = join(dir, "fuzz.sqlite");
  const db = openFuzzDb(dbPath, opts);
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, dbPath, dir };
}

function seedChargeAgents(db, agents, capCents = "1000000") {
  const now = Date.now();
  for (const a of agents) {
    setTier(db, ROOM, a, "t2_standard", { updatedBy: OWNER, nowMs: now });
    issueSpendGrant(db, ROOM, a, {
      grantedBy: OWNER, capCents, perTxCapCents: "10", nowMs: now,
    });
  }
}
function seedTiers(db, agents) {
  const now = Date.now();
  for (const a of agents) setTier(db, ROOM, a, "t2_standard", { updatedBy: OWNER, nowMs: now });
}

const authzRow = (db, agentId, nonce) =>
  db.prepare(`SELECT status, price_cents, tool_name FROM spend_authorizations
    WHERE room_id = ? AND agent_id = ? AND nonce = ?`).get(ROOM, agentId, nonce);
const authzCount = (db, nonce) =>
  db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ? AND nonce = ?`).get(ROOM, nonce).n;
const settledSum = (db, agentId) =>
  Number(db.prepare(`SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)),0) AS t
    FROM spend_authorizations WHERE room_id = ? AND agent_id = ? AND status = 'settled'`)
    .get(ROOM, agentId).t);

// --- Issuance path: test-local request-ID wrapper (persist-then-send) ---
// Dedupe row (fuzz_issue_dedupe) is INSERTed BEFORE the grant is issued and
// BEFORE the send. Status machine: pending -> issued -> done. Retries resume
// from the recorded status: 'pending' re-issues (upsert-safe), 'issued'
// skips straight to the idempotent send, 'done' returns deduped.
function issueSpendGrantOnce(db, requestId, p, crashPoint) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const first = attempt === 0;
    const row = db.prepare(`SELECT status FROM fuzz_issue_dedupe WHERE request_id = ?`).get(requestId);
    try {
      if (!row) {
        if (crashPoint === 0 && first) throw ICRASH; // CP0: before persist
        db.prepare(`INSERT INTO fuzz_issue_dedupe(request_id, status, agent_id) VALUES (?,?,?)`)
          .run(requestId, "pending", p.agentId);
      } else if (row.status === "done") {
        return { deduped: true };
      }
      const st = row ? row.status : "pending";
      if (st === "pending") {
        issueSpendGrant(db, p.roomId, p.agentId, {
          grantedBy: p.grantedBy, capCents: p.capCents, perTxCapCents: p.perTxCapCents,
          allowlist: p.allowlist ?? null, singleUse: p.singleUse ?? false, nowMs: Date.now(),
        });
        db.prepare(`UPDATE fuzz_issue_dedupe SET status = 'issued' WHERE request_id = ?`).run(requestId);
      }
      if (crashPoint === 1 && first) throw ICRASH; // CP1: between persist and send
      db.prepare(`INSERT OR IGNORE INTO fuzz_issue_sends(request_id) VALUES (?)`).run(requestId);
      if (crashPoint === 2 && first) throw ICRASH; // CP2: after send before ack
      db.prepare(`UPDATE fuzz_issue_dedupe SET status = 'done' WHERE request_id = ?`).run(requestId);
      return { deduped: false, resumed: attempt > 0 };
    } catch (e) { if (e !== ICRASH) throw e; }
  }
  throw new Error(`issue retry loop exhausted for ${requestId}`);
}
const issueParams = agentId => ({
  roomId: ROOM, agentId, grantedBy: OWNER, capCents: "5000", perTxCapCents: "10",
});
function assertIssuanceInvariants(db, requestId, agentId, expectCap = "5000") {
  const d = db.prepare(`SELECT status FROM fuzz_issue_dedupe WHERE request_id = ?`).get(requestId);
  assert.equal(d?.status, "done", `I3: request ${requestId} not acked (status ${d?.status})`);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_sends WHERE request_id = ?`).get(requestId).n,
    1, `I1: send applied more than once for ${requestId}`);
  const terms = db.prepare(`SELECT cap_cents FROM spend_grant_terms WHERE room_id = ? AND agent_id = ?`)
    .get(ROOM, agentId);
  assert.ok(terms, `I3: grant terms lost for ${agentId} (${requestId})`);
  assert.equal(terms.cap_cents, expectCap, `I1: cap changed across retry for ${requestId}`);
}

// --- Child loops (run via fork(SELF, ["--fuzz-child", ...])) ---
const mark = s => writeSync(1, s + "\n");
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function childChargeLoop(dbPath, roomId, agents, grants, seed) {
  const db = openFuzzDb(dbPath);
  const rnd = mulberry32(seed);
  for (let i = 0; i < grants; i++) {
    const agent = agents[i % agents.length];
    const nonce = randomUUID();
    const h = authorizeSpend(db, {
      roomId, agentId: agent, toolName: "room_put_file", priceCents: 5,
      nonce, nowMs: Date.now(),
    });
    mark(`persisted:${nonce}:${agent}`); // durable: authorizeSpend committed before returning
    nap(8 + Math.floor(rnd() * 16));     // kill window CP1: between persist and send
    db.prepare(`INSERT OR IGNORE INTO fuzz_sends(nonce,agent_id,price_cents) VALUES (?,?,?)`)
      .run(nonce, agent, "5");
    mark(`sent:${nonce}`);
    nap(8 + Math.floor(rnd() * 16));     // kill window CP2: after send before ack
    h.settle();
    mark(`settled:${nonce}`);
  }
  db.close();
}

function childIssueLoop(dbPath, roomId, agents, grants, seed) {
  const db = openFuzzDb(dbPath);
  const rnd = mulberry32(seed);
  for (let i = 0; i < grants; i++) {
    const agent = agents[i % agents.length];
    const rid = randomUUID();
    const p = { ...issueParams(agent), roomId };
    db.prepare(`INSERT INTO fuzz_issue_dedupe(request_id,status,agent_id) VALUES (?,?,?)`)
      .run(rid, "pending", agent);
    mark(`ipending:${rid}:${agent}`);
    issueSpendGrant(db, roomId, agent, { ...p, nowMs: Date.now() });
    db.prepare(`UPDATE fuzz_issue_dedupe SET status = 'issued' WHERE request_id = ?`).run(rid);
    mark(`iissued:${rid}`);
    nap(8 + Math.floor(rnd() * 16));    // kill window: between persist and send
    db.prepare(`INSERT OR IGNORE INTO fuzz_issue_sends(request_id) VALUES (?)`).run(rid);
    mark(`isent:${rid}`);
    nap(8 + Math.floor(rnd() * 16));    // kill window: after send before ack
    db.prepare(`UPDATE fuzz_issue_dedupe SET status = 'done' WHERE request_id = ?`).run(rid);
    mark(`idone:${rid}`);
  }
  db.close();
}

async function childMain(args) {
  const [mode, dbPath, roomId, agentsJson, grants, seed] = args;
  const agents = JSON.parse(agentsJson);
  if (mode === "charge") childChargeLoop(dbPath, roomId, agents, Number(grants), Number(seed));
  else if (mode === "issue") childIssueLoop(dbPath, roomId, agents, Number(grants), Number(seed));
  else throw new Error(`unknown child mode ${mode}`);
}

if (CHILD_MODE) {
  await childMain(process.argv.slice(3));
  process.exit(0);
}

// ================= Fuzz A: in-process crash points, charge path ==========
// 360 trials. Each trial: authorize (persist) -> [crash] -> durable
// idempotent send (INSERT OR IGNORE into fuzz_sends) -> [crash] -> settle.
// Crash at CP0/CP1/CP2 on attempt 0 only; retry with the SAME nonce.
function chargeTrial(db, rng, o) {
  // o: {agentId, toolName, priceCents, nonce, crashPoint, voidIt}
  let voided = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const first = attempt === 0;
    try {
      if (o.crashPoint === 0 && first) throw CRASH; // CP0: before persist
      const h = authorizeSpend(db, {
        roomId: ROOM, agentId: o.agentId, toolName: o.toolName,
        priceCents: o.priceCents, nonce: o.nonce, nowMs: Date.now(),
      });
      if (o.crashPoint === 1 && first) throw CRASH; // CP1: between persist and send
      if (o.voidIt && !voided) { // send failed (no crash): void, never charged.
        // Runs on the first non-crashed attempt, so voidIt x CP0/CP1 also
        // exercises void-after-crash-recovery (replay handle void).
        voided = true;
        assert.equal(h.void(), true, "void must release the reservation");
        return { outcome: "voided" };
      }
      // Durable, idempotent "send": exactly-once per nonce by PRIMARY KEY.
      db.prepare(`INSERT OR IGNORE INTO fuzz_sends(nonce,agent_id,price_cents) VALUES (?,?,?)`)
        .run(o.nonce, o.agentId, String(o.priceCents));
      if (o.crashPoint === 2 && first) throw CRASH; // CP2: after send before ack
      assert.equal(h.settle(), true, `settle must move exactly one row (nonce ${o.nonce})`);
      return { outcome: "settled", replayed: h.replayed ?? null };
    } catch (e) { if (e !== CRASH) throw e; }
  }
  throw new Error(`charge retry loop exhausted for ${o.nonce}`);
}

test("fuzz A: 360 in-process crash/retry trials on the charge path (CP0/CP1/CP2)", async t => {
  const { db } = freshDb(t, "A", { durable: false });
  const agents = ["ag-0", "ag-1", "ag-2", "ag-3"];
  seedChargeAgents(db, agents);
  const rng = mulberry32(SEED ^ 0xa);
  const tools = [["room_put_file", 5], ["add_land_item", 1]];
  const cpCount = [0, 0, 0];
  const expected = new Map(agents.map(a => [a, 0]));
  const N = 360;
  for (let trial = 0; trial < N; trial++) {
    const agent = agents[Math.floor(rng() * agents.length)];
    const [toolName, priceCents] = tools[Math.floor(rng() * tools.length)];
    const nonce = `fuzzA-${trial}-${Math.floor(rng() * 2 ** 31).toString(36)}`;
    const crashPoint = (trial + 1) % 3; // exact 120/120/120 coverage
    cpCount[crashPoint]++;
    const voidIt = trial % 10 === 9; // 10%: send fails -> void path
    const r = chargeTrial(db, rng, { agentId: agent, toolName, priceCents, nonce, crashPoint, voidIt });
    if (voidIt) {
      assert.equal(r.outcome, "voided");
      const row = authzRow(db, agent, nonce);
      assert.equal(row.status, "voided", "failed send must void, never charge");
      // A voided nonce stays consumed: re-presenting hits documented 409.
      const err = (() => { try { authorizeSpend(db, { roomId: ROOM, agentId: agent, toolName, priceCents, nonce, nowMs: Date.now() }); } catch (e) { return e; } throw new Error("expected 409"); })();
      assert.ok(err instanceof SpendGrantError && err.status === 409 && err.code === "duplicate_nonce");
      // Fresh nonce works: the void freed the cap (no lost grant).
      const fresh = `fuzzA-${trial}-fresh`;
      chargeTrial(db, rng, { agentId: agent, toolName, priceCents, nonce: fresh, crashPoint: -1, voidIt: false });
      expected.set(agent, expected.get(agent) + priceCents);
      const fr = authzRow(db, agent, fresh);
      assert.equal(fr.status, "settled");
    } else {
      assert.equal(r.outcome, "settled");
      expected.set(agent, expected.get(agent) + priceCents);
    }
    // I1: exactly one row per nonce, settled exactly once.
    const row = authzRow(db, agent, nonce);
    assert.ok(row, `I3: no row for nonce ${nonce}`);
    assert.equal(authzCount(db, nonce), 1, `I1: double-grant: >1 row for nonce ${nonce}`);
    assert.equal(row.status, voidIt ? "voided" : "settled", `I3: nonce ${nonce} not settled`);
    assert.equal(row.price_cents, String(priceCents), "charge amount must match the first persist");
    // I1 (send side): the durable send ran exactly once per settled nonce.
    const sends = db.prepare(`SELECT COUNT(*) AS n FROM fuzz_sends WHERE nonce = ?`).get(nonce).n;
    assert.equal(sends, voidIt ? 0 : 1, `I1: send applied ${sends}x for nonce ${nonce}`);
  }
  assert.deepEqual(cpCount, [120, 120, 120], "all crash points covered");
  // Global money conservation per agent.
  for (const agent of agents) {
    assert.equal(settledSum(db, agent), expected.get(agent), `cap math drift for ${agent}`);
    assert.equal(remainingSpendCents(db, ROOM, agent), 1000000 - expected.get(agent));
  }
  const totalRows = db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ?`).get(ROOM).n;
  const totalSends = db.prepare(`SELECT COUNT(*) AS n FROM fuzz_sends`).get().n;
  console.log(`fuzz A: ${N} trials, CP coverage ${cpCount}, authz rows ${totalRows}, sends ${totalSends}, no violations`);
});

test("fuzz A hostile: same nonce, different price/tool/agent on retry", async t => {
  const { db } = freshDb(t, "Ah", { durable: false });
  seedChargeAgents(db, ["hag-0", "hag-1"]);
  // Same nonce re-presented with a DIFFERENT price and tool: first-write-wins
  // on the dedupe record — the retry must replay original terms, never a
  // second row, never the new price.
  for (let i = 0; i < 5; i++) {
    const nonce = `hostile-price-${i}`;
    const h1 = authorizeSpend(db, { roomId: ROOM, agentId: "hag-0", toolName: "room_put_file", priceCents: 5, nonce, nowMs: Date.now() });
    const h2 = authorizeSpend(db, { roomId: ROOM, agentId: "hag-0", toolName: "bounty_post", priceCents: 10, nonce, nowMs: Date.now() });
    assert.equal(h2.replayed, "reserved", "must replay, not re-authorize");
    assert.equal(h2.priceCents, 5, "replay keeps the ORIGINAL price (first-write-wins)");
    assert.equal(h2.toolName, "room_put_file");
    assert.equal(authzCount(db, nonce), 1, "I1: no second row on hostile replay");
    assert.equal(h2.settle(), true);
    assert.equal(authzRow(db, "hag-0", nonce).price_cents, "5", "I1: charged exactly the original 5c");
  }
  // Same nonce across DIFFERENT agents: independent dedupe keys (PK includes
  // agent_id) — no cross-agent interference, no lost grant.
  for (let i = 0; i < 5; i++) {
    const nonce = `hostile-agent-${i}`;
    const a = authorizeSpend(db, { roomId: ROOM, agentId: "hag-0", toolName: "room_put_file", priceCents: 5, nonce, nowMs: Date.now() });
    const b = authorizeSpend(db, { roomId: ROOM, agentId: "hag-1", toolName: "room_put_file", priceCents: 5, nonce, nowMs: Date.now() });
    assert.ok(!a.replayed && !b.replayed, "distinct agents => distinct authorizations");
    assert.equal(a.settle(), true);
    assert.equal(b.settle(), true);
  }
  assert.equal(settledSum(db, "hag-0") + settledSum(db, "hag-1"), 75, "sanity: 50c + 25c settled");
  console.log("fuzz A hostile: 10 trials, first-write-wins + per-agent isolation hold");
});

// CONFIRMED BUG (WAVE-400, 2026-10-08) — server/spend-grants.mjs:
// reapExpiredSpendAuthorizations runs at the top of authorizeSpend's
// module-local transact(). It voids the expired row inside that
// transaction; then the replay check sees status 'voided' and refuse(409,
// "duplicate_nonce") throws INSIDE transact -> ROLLBACK -> the void (and
// the room-reservation release) are discarded. The caller gets the
// documented 409, but the reservation row stays 'reserved' (documented:
// 'voided') and keeps consuming grant cap (authorizationsTotal counts
// 'reserved') and room-allowance headroom ('active' reservation) until
// some UNRELATED later authorizeSpend successfully commits a reap.
// The design's own crash-recovery path (same-nonce retry) thus defeats the
// reaping. Minimal repro: the script below this comment. API behavior is
// correct (409, no double charge) — this is a state-convergence / cap
// leak bug, not a double-spend. Do NOT "fix" by weakening the assertions;
// the assertions below encode the documented post-condition.
test("lease-expiry boundary: delayed retry past the lease is 409, cap freed (documented)", async t => {
  const { db } = freshDb(t, "lease", { durable: false });
  seedChargeAgents(db, ["lag-0"]);
  const t0 = Date.now();
  const h = authorizeSpend(db, { roomId: ROOM, agentId: "lag-0", toolName: "room_put_file", priceCents: 5, nonce: "lease-1", nowMs: t0 });
  assert.ok(h && !h.replayed, "first authorization reserves");
  // No settle: simulate a caller gone past the 10-minute lease, then retry.
  const late = t0 + RESERVE_LEASE_MS + 1000;
  const err = (() => { try { authorizeSpend(db, { roomId: ROOM, agentId: "lag-0", toolName: "room_put_file", priceCents: 5, nonce: "lease-1", nowMs: late }); } catch (e) { return e; } throw new Error("expected 409"); })();
  assert.ok(err instanceof SpendGrantError && err.status === 409 && err.code === "duplicate_nonce",
    "expired reservation must 409 and demand a fresh nonce");
  // Observed quirk (not a money violation): the 409 aborts authorizeSpend's
  // transaction, so the reaper's void is rolled back with it — the row still
  // reads 'reserved' here. The documented recovery (fresh nonce) heals it:
  // the fresh call's reaper durably voids the expired row before proceeding.
  const h2 = authorizeSpend(db, { roomId: ROOM, agentId: "lag-0", toolName: "room_put_file", priceCents: 5, nonce: "lease-2", nowMs: late });
  assert.equal(h2.settle(), true, "fresh nonce works after expiry");
  assert.equal(authzRow(db, "lag-0", "lease-1").status, "voided",
    "reaper durably voids the expired row on the next live call");
  assert.equal(settledSum(db, "lag-0"), 5, "only the fresh authorization charged");
  console.log("lease boundary: 409 + void-on-next-call + fresh-nonce recovery as documented");
});

// ================= Fuzz C: in-process crash points, issuance path ========// 120 trials through issueSpendGrantOnce (dedupe -> grant -> send -> ack),
// crashing at CP0/CP1/CP2 on the first attempt, retrying the same request ID.
test("fuzz C: 120 in-process crash/retry trials on grant issuance (CP0/CP1/CP2)", async t => {
  const { db } = freshDb(t, "C", { durable: false });
  const agents = ["cag-0", "cag-1", "cag-2"];
  seedTiers(db, agents);
  const rng = mulberry32(SEED ^ 0xc);
  const cpCount = [0, 0, 0];
  const N = 120;
  for (let trial = 0; trial < N; trial++) {
    const agent = agents[Math.floor(rng() * agents.length)];
    const requestId = `iss-${trial}-${Math.floor(rng() * 2 ** 31).toString(36)}`;
    const crashPoint = (trial + 2) % 3; // exact 40/40/40 coverage
    cpCount[crashPoint]++;
    const r = issueSpendGrantOnce(db, requestId, issueParams(agent), crashPoint);
    assert.ok(r, "wrapper must return");
    // Hostile: retry the SAME request ID with a DIFFERENT cap — first-write-
    // wins; the dedupe record must not let a retry widen the grant.
    if (trial % 6 === 5) {
      const r2 = issueSpendGrantOnce(db, requestId,
        { ...issueParams(agent), capCents: "999999" }, -1);
      assert.equal(r2.deduped, true, "completed request must dedupe, not re-issue");
    }
    assertIssuanceInvariants(db, requestId, agent, "5000");
  }
  assert.deepEqual(cpCount, [40, 40, 40], "all crash points covered");
  // Global: every request acked, every send exactly once, one terms row each.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_dedupe WHERE status != 'done'`).get().n, 0,
    "I3: every issuance request must reach done");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_dedupe`).get().n, N);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_sends`).get().n, N, "I1: sends == requests");
  for (const agent of agents)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM spend_grant_terms WHERE room_id = ? AND agent_id = ?`).get(ROOM, agent).n, 1,
      `I1: exactly one terms row for ${agent}`);
  console.log(`fuzz C: ${N} trials, CP coverage ${cpCount}, 20 hostile cap-widen retries deduped, no violations`);
});

// ================= Kill harness (shared by Fuzz B and D) =================
function runKillChild({ dbPath, roomId, agents, mode, grants, seed, killAfter, killAt }) {
  // killAfter: 'boot' | a marker prefix ('persisted'|'sent'|'ipending'|'iissued'|'isent');
  // killAt: kill right after the killAt-th such marker line arrives.
  return new Promise(resolve => {
    const child = fork(SELF, ["--fuzz-child", mode, dbPath, roomId, JSON.stringify(agents), String(grants), String(seed)], { silent: true });
    const markers = new Map(); // key -> array of [name, extra]
    const counts = {};
    let killed = false, exited = false, buf = "";
    const note = (name, key, extra) => {
      if (!markers.has(key)) markers.set(key, []);
      markers.get(key).push([name, extra]);
      counts[name] = (counts[name] || 0) + 1;
    };
    const doKill = () => {
      if (!killed && !exited) { killed = true; try { child.kill("SIGKILL"); } catch {} }
    };
    if (killAfter === "boot") setImmediate(doKill);
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        const m = /^(persisted|sent|settled|ipending|iissued|isent|idone):([^:]+)(?::(\S+))?$/.exec(line);
        if (m) {
          note(m[1], m[2], m[3] ?? null);
          if (m[1] === killAfter && (counts[m[1]] || 0) >= killAt) doKill();
        }
      }
    });
    const watchdog = setTimeout(doKill, 30000);
    child.on("exit", () => {
      clearTimeout(watchdog);
      // Drain any final buffered line fragment.
      resolve({ markers, wasKilled: killed, counts });
    });
  });
}

function recoverChargeNonce(db, agentId, nonce) {
  // I2: the persisted marker means authorizeSpend committed before the kill;
  // the row MUST be there — its absence is the "dedupe not persisted before
  // send" bug. Retry dedupes via the replay path (no second row).
  const row = authzRow(db, agentId, nonce);
  assert.ok(row, `I2 BUG: persisted marker for nonce ${nonce} has no durable dedupe row`);
  const sentBefore = !!db.prepare(`SELECT 1 FROM fuzz_sends WHERE nonce = ?`).get(nonce);
  const h = authorizeSpend(db, {
    roomId: ROOM, agentId, toolName: "room_put_file", priceCents: 5, nonce, nowMs: Date.now(),
  });
  assert.ok(h.replayed === "reserved" || h.replayed === "settled",
    `I2: retry of ${nonce} must dedupe via replay, got fresh authorization`);
  db.prepare(`INSERT OR IGNORE INTO fuzz_sends(nonce,agent_id,price_cents) VALUES (?,?,?)`)
    .run(nonce, agentId, "5");
  assert.equal(h.settle(), true, `I1: settle must move exactly one row for ${nonce}`);
  const after = authzRow(db, agentId, nonce);
  assert.equal(after.status, "settled", `I3: nonce ${nonce} not settled after recovery`);
  assert.equal(authzCount(db, nonce), 1, `I1 BUG: double-grant — >1 row for nonce ${nonce}`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_sends WHERE nonce = ?`).get(nonce).n, 1,
    `I1 BUG: send applied more than once for ${nonce}`);
  return sentBefore ? "cp2" : "cp1";
}

// ================= Fuzz B: SIGKILL children, charge path =================
// 150 children, each on its own copy of a template DB (copies are cheap;
// one shared file would serialize the children on BEGIN IMMEDIATE). Up to 6
// children run concurrently. Parent kills each child mid-run:
// 100 right after a `persisted:` marker (CP1: between persist and send),
// 40 right after a `sent:` marker (CP2: after send before ack),
// 10 at boot (CP0: before persist). Recovery reopens the child's sqlite
// file (FULL durability) and retries with the same nonces.

async function mapPool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

function assertChargeDbInvariants(db, agents, capCents) {
  for (const n of db.prepare(`SELECT nonce, agent_id, status FROM spend_authorizations WHERE room_id = ?`).all(ROOM)) {
    assert.equal(n.status, "settled", `I3: nonce ${n.nonce} left ${n.status}`);
    assert.equal(authzCount(db, n.nonce), 1, `I1 BUG: double-grant on ${n.nonce}`);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_sends WHERE nonce = ?`).get(n.nonce).n, 1,
      `I1 BUG: send count != 1 for ${n.nonce}`);
  }
  const totalSettled = db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ? AND status = 'settled'`).get(ROOM).n;
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_sends`).get().n, totalSettled, "sends == settled");
  for (const agent of agents) {
    const sum = settledSum(db, agent);
    const cnt = db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ? AND agent_id = ? AND status = 'settled'`).get(ROOM, agent).n;
    assert.equal(sum, cnt * 5, `cap math drift for ${agent}`);
    assert.equal(remainingSpendCents(db, ROOM, agent), capCents - sum, `remaining drift for ${agent}`);
  }
  return totalSettled;
}

test("fuzz B: 150 SIGKILL/retry trials on the charge path (real child + real sqlite file)", async t => {
  const dir = mkdtempSync(join(TMPBASE, "fuzz20-B-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = ["ag-0", "ag-1", "ag-2", "ag-3"];
  const templatePath = join(dir, "template.sqlite");
  {
    const tdb = openFuzzDb(templatePath); // FULL durability
    seedChargeAgents(tdb, agents);
    tdb.close();
  }
  const rng = mulberry32(SEED ^ 0xb);
  const GRANTS = 8;
  const plans = [];
  for (let i = 0; i < 100; i++) plans.push({ killAfter: "persisted", killAt: 1 + Math.floor(rng() * 5) });
  for (let i = 0; i < 40; i++) plans.push({ killAfter: "sent", killAt: 1 + Math.floor(rng() * 5) });
  for (let i = 0; i < 10; i++) plans.push({ killAfter: "boot", killAt: 1 });
  for (let i = plans.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1));[plans[i], plans[j]] = [plans[j], plans[i]]; }
  const seeds = plans.map(() => Math.floor(rng() * 2 ** 31));

  const oneChild = async (plan, idx) => {
    const childPath = join(dir, `child-${idx}.sqlite`);
    copyFileSync(templatePath, childPath);
    const { markers, wasKilled } = await runKillChild({
      dbPath: childPath, roomId: ROOM, agents, mode: "charge", grants: GRANTS,
      seed: seeds[idx], killAfter: plan.killAfter, killAt: plan.killAt,
    });
    const db = openFuzzDb(childPath); // FULL durability: real crash recovery
    const st = { cp1: 0, cp2: 0, cp0: 0, killed: wasKilled ? 1 : 0, orphans: 0, settled: 0 };
    try {
      for (const [nonce, events] of markers) {
        const names = events.map(e => e[0]);
        const agent = events.find(e => e[0] === "persisted")?.[1];
        if (names.includes("settled")) {
          const row = authzRow(db, agent, nonce);
          assert.equal(row?.status, "settled", `I2: settled marker without durable commit (${nonce})`);
          continue;
        }
        if (!names.includes("persisted")) continue; // killed before first persist: CP0
        st[recoverChargeNonce(db, agent, nonce)]++;
      }
      if (plan.killAfter === "boot") {
        assert.equal(markers.size, 0, "CP0: child killed at boot must leave no markers");
        st.cp0++;
        // Crash-before-persist leaves the system healthy: full flow works.
        const agent = agents[idx % agents.length];
        const nonce = `cp0-probe-${idx}`;
        const h = authorizeSpend(db, { roomId: ROOM, agentId: agent, toolName: "room_put_file", priceCents: 5, nonce, nowMs: Date.now() });
        db.prepare(`INSERT OR IGNORE INTO fuzz_sends(nonce,agent_id,price_cents) VALUES (?,?,?)`).run(nonce, agent, "5");
        assert.equal(h.settle(), true);
      }
      // Orphan sweep: rows committed but whose marker was lost to the kill
      // (kill landed between commit and writeSync). Recover exactly-once.
      for (const o of db.prepare(`SELECT agent_id, nonce FROM spend_authorizations WHERE room_id = ? AND status = 'reserved'`).all(ROOM)) {
        st.orphans++;
        assert.equal(recoverChargeNonce(db, o.agent_id, o.nonce), "cp1");
        st.cp1++;
      }
      st.settled = assertChargeDbInvariants(db, agents, 1000000);
    } finally {
      db.close();
      rmSync(childPath, { force: true });
    }
    return st;
  };

  const results = await mapPool(plans, 6, oneChild);
  const mergeB = (a, s) => ({
    cp1: a.cp1 + s.cp1, cp2: a.cp2 + s.cp2, cp0: a.cp0 + s.cp0,
    killed: a.killed + s.killed, orphans: a.orphans + s.orphans, settled: a.settled + s.settled,
  });
  let tot = results.reduce(mergeB, { cp1: 0, cp2: 0, cp0: 0, killed: 0, orphans: 0, settled: 0 });
  // Top-up: a kill can land in the gap between a grant's settle and the next
  // grant's persist (no in-flight nonce to recover). Spawn replacements until
  // the trial target is met.
  let extra = 0;
  while (tot.cp0 + tot.cp1 + tot.cp2 < 145 && extra < 40) {
    tot = mergeB(tot, await oneChild({ killAfter: "persisted", killAt: 1 + Math.floor(rng() * 5) }, 1000 + extra));
    extra++;
  }
  const killTrials = tot.cp1 + tot.cp2 + tot.cp0;
  console.log(`fuzz B: ${plans.length + extra} children (6 concurrent), killed=${tot.killed}, orphans-swept=${tot.orphans}, ` +
    `kill trials cp0=${tot.cp0} cp1=${tot.cp1} cp2=${tot.cp2} total=${killTrials}, settled=${tot.settled}`);
  assert.ok(tot.killed >= 130, `expected most children killed, got ${tot.killed}`);
  assert.ok(killTrials >= 140, `expected >=140 kill trials, got ${killTrials}`);
  assert.ok(tot.cp1 >= 50, `CP1 coverage too low: ${tot.cp1}`);
  assert.ok(tot.cp2 >= 10, `CP2 coverage too low: ${tot.cp2}`);
  console.log("fuzz B: all per-child DBs settled exactly-once, money conserved, no violations");
}, { timeout: 900000 });

// ================= Fuzz D: SIGKILL children, issuance path ================
// 10 children on template copies; kill after `iissued:` (CP1: grant
// persisted, send not done) or after `isent:` (CP2: send done, ack not
// done). Recovery resumes through issueSpendGrantOnce with the same
// request ID.
function assertIssueDbInvariants(db, agents, expectCap) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_dedupe WHERE status != 'done'`).get().n, 0,
    "I3: every issuance request acked");
  const nReq = db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_dedupe`).get().n;
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fuzz_issue_sends`).get().n, nReq, "I1: sends == requests");
  // Only agents the child actually reached need terms; a kill can land before
  // an agent's first issuance.
  for (const { agent_id } of db.prepare(`SELECT DISTINCT agent_id FROM fuzz_issue_dedupe`).all()) {
    const terms = db.prepare(`SELECT cap_cents FROM spend_grant_terms WHERE room_id = ? AND agent_id = ?`).get(ROOM, agent_id);
    assert.ok(terms, `I3: terms lost for ${agent_id}`);
    assert.equal(terms.cap_cents, expectCap, `I1: cap drift for ${agent_id}`);
  }
  return nReq;
}

test("fuzz D: 10 SIGKILL/retry trials on grant issuance (real child + real sqlite file)", async t => {
  const dir = mkdtempSync(join(TMPBASE, "fuzz20-D-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = ["dag-0", "dag-1", "dag-2"];
  const templatePath = join(dir, "template.sqlite");
  {
    const tdb = openFuzzDb(templatePath);
    seedTiers(tdb, agents);
    tdb.close();
  }
  const rng = mulberry32(SEED ^ 0xd);
  const plans = [];
  for (let i = 0; i < 5; i++) plans.push({ killAfter: "iissued", killAt: 1 + Math.floor(rng() * 2) });
  for (let i = 0; i < 5; i++) plans.push({ killAfter: "isent", killAt: 1 + Math.floor(rng() * 2) });
  const seeds = plans.map(() => Math.floor(rng() * 2 ** 31));

  const oneChild = async (plan, idx) => {
    const childPath = join(dir, `child-${idx}.sqlite`);
    copyFileSync(templatePath, childPath);
    const { markers, wasKilled } = await runKillChild({
      dbPath: childPath, roomId: ROOM, agents, mode: "issue", grants: 6,
      seed: seeds[idx], killAfter: plan.killAfter, killAt: plan.killAt,
    });
    const db = openFuzzDb(childPath);
    const st = { cp1: 0, cp2: 0, killed: wasKilled ? 1 : 0, requests: 0 };
    try {
      for (const [rid, events] of markers) {
        const names = events.map(e => e[0]);
        const agent = events.find(e => e[0] === "ipending")?.[1];
        if (names.includes("idone")) continue;
        if (!agent) continue;
        const before = db.prepare(`SELECT status FROM fuzz_issue_dedupe WHERE request_id = ?`).get(rid);
        assert.ok(before, `I2 BUG: ipending marker for ${rid} has no durable dedupe row`);
        issueSpendGrantOnce(db, rid, issueParams(agent), -1); // resume, no new crash
        assertIssuanceInvariants(db, rid, agent, "5000");
        if (names.includes("isent")) st.cp2++; else st.cp1++;
      }
      for (const o of db.prepare(`SELECT request_id, agent_id FROM fuzz_issue_dedupe WHERE status != 'done'`).all()) {
        issueSpendGrantOnce(db, o.request_id, issueParams(o.agent_id), -1);
        assertIssuanceInvariants(db, o.request_id, o.agent_id, "5000");
        st.cp1++;
      }
      st.requests = assertIssueDbInvariants(db, agents, "5000");
    } finally {
      db.close();
      rmSync(childPath, { force: true });
    }
    return st;
  };

  const results = await mapPool(plans, 6, oneChild);
  const mergeD = (a, s) => ({
    cp1: a.cp1 + s.cp1, cp2: a.cp2 + s.cp2, killed: a.killed + s.killed, requests: a.requests + s.requests,
  });
  let tot = results.reduce(mergeD, { cp1: 0, cp2: 0, killed: 0, requests: 0 });
  let extra = 0;
  while (tot.cp1 + tot.cp2 < 10 && extra < 5) {
    tot = mergeD(tot, await oneChild({ killAfter: "iissued", killAt: 1 + Math.floor(rng() * 2) }, 1000 + extra));
    extra++;
  }
  const killTrials = tot.cp1 + tot.cp2;
  console.log(`fuzz D: ${plans.length + extra} children, killed=${tot.killed}, kill trials cp1=${tot.cp1} cp2=${tot.cp2} total=${killTrials}, requests=${tot.requests}`);
  assert.ok(tot.killed >= 8, `expected most children killed, got ${tot.killed}`);
  assert.ok(killTrials >= 8, `expected >=8 kill trials, got ${killTrials}`);
  console.log("fuzz D: all issuance requests done, sends exactly once, caps intact, no violations");
}, { timeout: 900000 });
