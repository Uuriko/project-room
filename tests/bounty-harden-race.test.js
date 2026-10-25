// HARDEN-RACE-CAVEATS (deep-dive money-core charter 7, Scope B caveats 1+2).
//
// (a) Re-entrancy orphan dispute: a second disputeBounty invoked from
// inside the open dispute transaction used to succeed — 2 dispute rows, a
// second bond stranded under an orphan dispute, and verifyConservation
// false after the outer dispute settled. Unreachable by production
// callers today (one escrow op per request, synchronously; the only
// internal re-entry is the #3275-guarded settle path) — this is
// hardening, not a live-vulnerability fix. disputeBounty now stamps the
// dispute onto the bounty row before the bond locks and re-checks for an
// existing dispute row at write time, so the inner call is refused
// dispute_exists and exactly one dispute ever exists.
//
// (b) Cross-handle BUSY: a claim from a second connection while a foreign
// writer holds the WAL write lock past busy_timeout used to surface the
// raw sqlite error (code 5, "database is locked") — neither an
// EscrowError nor storage_unavailable — which http.mjs maps to a
// 500-class response. The escrow door now maps BUSY to a clean retryable
// refusal: 503 storage_busy + Retry-After. Zero partial writes and the
// clean retry after lock release are asserted on a real WAL file with
// two connections.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { handleBountyEscrow, isSqliteBusy } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";
let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

// Faithful store double: production nodeStorage.transaction semantics
// (BEGIN IMMEDIATE, inline nesting, async bodies rejected) — a SAVEPOINT
// double contains no write lock and cannot express either probe.
function platformTx(db, fn, readOnly = false, { isolated = false } = {}) {
  const run = () => {
    const result = fn();
    if (result && typeof result.then === "function") throw new Error("Room transactions must remain synchronous");
    return result;
  };
  if (db.isTransaction) {
    if (!isolated) return run();
    db.exec("SAVEPOINT room_isolated_write");
    try { const r = run(); db.exec("RELEASE room_isolated_write"); return r; }
    catch (e) { try { db.exec("ROLLBACK TO room_isolated_write"); db.exec("RELEASE room_isolated_write"); } catch {} throw e; }
  }
  db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
  try { const r = run(); db.exec("COMMIT"); return r; }
  catch (e) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch {} } throw e; }
}
const storeFor = db => ({ db, transaction: (fn, opts) => platformTx(db, fn, false, opts),
  readTransaction: fn => platformTx(db, fn, true) });

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const escrow = new BountyEscrow(storeFor(db), { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}
const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
function runToAccepted(escrow) {
  const bounty = post(escrow, { verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

// --- (a) re-entrancy --------------------------------------------------------

test("(a) a re-entrant disputeBounty inside the open dispute transaction is refused dispute_exists", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow);
  // Fire the second dispute from the journal seam on the outer dispute's
  // bond-lock append — the instant the freeze is half-applied.
  let inner = null, fired = false;
  const origAppend = escrow._append.bind(escrow);
  escrow._append = entry => {
    const result = origAppend(entry);
    if (!fired && entry.kind === "bond-lock" && typeof entry.memo === "string" && entry.memo.startsWith("dispute bond for")) {
      fired = true;
      try {
        escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "re-entrant" });
        inner = { outcome: "succeeded" };
      } catch (error) { inner = { outcome: "refused", code: error.code }; }
    }
    return result;
  };
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "outer" });
  escrow._append = origAppend;

  assert.deepEqual(inner, { outcome: "refused", code: "dispute_exists" });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).disputeId, dispute.disputeId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bounty_disputes WHERE room_id=?").get(ROOM).n, 1,
    "exactly one dispute row exists");
  // One dispute bond locked (2.5), not two: challenger 97.5 payable / 2.5 locked.
  assert.equal(escrow.balances(ROOM, CODEX).payable, 97.5);
  assert.equal(escrow.balances(ROOM, CODEX).locked, 2.5);
  expectConserved(escrow);

  // Settlement releases everything: no stranded orphan bond, and the
  // conservation checker stays green on the terminal bounty (at baseline
  // it went false: "terminal bounty still holds 2500 in escrow buckets").
  escrow.decideDispute(ROOM, bounty.bountyId, { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  escrow.closeEpoch(ROOM, {});
  escrow.closeEpoch(ROOM, {});
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  assert.equal(escrow.balances(ROOM, CODEX).locked, 0);
  expectConserved(escrow);
});

test("(a) a persisted dispute row the bounty row does not point at still refuses a new dispute at write time", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow);
  // An orphan-shaped row by hand: a dispute record for this bounty exists
  // in bounty_disputes while bounty_records.dispute_id is NULL — the entry
  // guard alone would let a new dispute open on top of it.
  const orphanId = "dsp_orphan000000001";
  const machine = escrow._disputes;
  let d = machine.open({ disputeId: orphanId, bountyId: bounty.bountyId, bountyAmount: 10000, raisedBy: CODEX, reason: "orphan", kind: "economic", bond: 2500 });
  escrow._persistDispute(ROOM, d);
  d = machine.challenge(orphanId, { by: CODEX }); escrow._persistDispute(ROOM, d);
  const challengerBefore = escrow.balances(ROOM, CODEX);
  assert.throws(
    () => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "second" }),
    error => error.code === "dispute_exists");
  // The refusal strands nothing: no bond locked, bounty never frozen.
  assert.deepEqual(escrow.balances(ROOM, CODEX), challengerBefore);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "accepted");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bounty_disputes WHERE room_id=?").get(ROOM).n, 1);
  expectConserved(escrow);
});

test("(a) normal dispute flow is unchanged: open, decide, settle, conservation", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow);
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
  assert.equal(dispute.decider, INSTINCT);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  // A plain sequential second dispute is still refused, as before.
  assert.throws(
    () => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "also bad" }),
    error => error.code === "dispute_exists");
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(settled.resolution.kind, "release");
  escrow.closeEpoch(ROOM, {});
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  expectConserved(escrow);
});

// --- (b) BUSY surfacing -----------------------------------------------------

test("(b) isSqliteBusy classifies code 5 and only code 5", () => {
  const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  assert.equal(isSqliteBusy(busy), true);
  assert.equal(isSqliteBusy(Object.assign(new Error("snapshot busy"), { errcode: 517 })), true,
    "extended BUSY codes share the low byte");
  assert.equal(isSqliteBusy({ code: "SQLITE_BUSY", message: "x" }), true);
  assert.equal(isSqliteBusy(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" })), true,
    "message fallback for drivers that report BUSY by text");
  assert.equal(isSqliteBusy(Object.assign(new Error("UNIQUE constraint failed"), { code: "ERR_SQLITE_ERROR", errcode: 19 })), false);
  assert.equal(isSqliteBusy(Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 })), false,
    "storage failures keep their own storage_unavailable path");
  assert.equal(isSqliteBusy(new Error("db gone")), false);
  assert.equal(isSqliteBusy(null), false);
});

class HttpReject extends Error {
  constructor(status, code, message, headers) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

test("(b) a cross-handle claim under a held write lock returns 503 storage_busy, writes nothing, and retries clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "escrow-busy-"));
  const file = join(dir, "room.db");
  const mkDb = busyMs => {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    return db;
  };
  const holderDb = mkDb(3000);
  const contenderDb = mkDb(500);
  try {
    ensureAutonomyTiersSchema(contenderDb);
    const members = {
      [JILL]: { kind: "agent", active: true }, [GROK]: { kind: "agent", active: true },
      [INSTINCT]: { kind: "agent", active: true }, [CODEX]: { kind: "agent", active: true },
      "owner-human": { kind: "human", active: true },
    };
    const store = { ...storeFor(contenderDb),
      roomAuthority: () => ({ ownerId: "owner-human", members }) };
    store.bountyEscrow = new BountyEscrow(store, { now: () => nowMs });
    const escrow = store.bountyEscrow;
    escrow.ensureGenesis(ROOM);
    const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
    escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });

    // The foreign writer: BEGIN IMMEDIATE + a write, held open.
    holderDb.exec("CREATE TABLE IF NOT EXISTS probe_lock (x INTEGER)");
    holderDb.exec("BEGIN IMMEDIATE");
    holderDb.exec("INSERT INTO probe_lock VALUES (1)");

    const helpers = {
      json: (res, status, value) => { res.statusCode = status; res.body = value; },
      reject: (status, code, message, headers) => { throw new HttpReject(status, code, message, headers); },
      body: async req => req._body,
    };
    const auth = { member: { id: GROK, kind: "agent" } };
    const callClaim = async () => {
      const req = { method: "POST", headers: {}, _body: {} };
      const res = { statusCode: null, body: null };
      try {
        await handleBountyEscrow({ req, res, url: new URL(`http://localhost/api/rooms/${ROOM}/x`),
          store, roomId: ROOM, auth, escrowRoute: "claim", bountyId: bounty.bountyId,
          identity: null, sybilFlagId: null, reauthorize: () => auth, helpers });
        return { status: res.statusCode, body: res.body, headers: null };
      } catch (error) {
        if (error instanceof HttpReject) return { status: error.status, body: { code: error.code }, headers: error.headers ?? null };
        throw error; // a raw throw here is the old 500-class path — fail the test
      }
    };

    const during = await callClaim();
    assert.equal(during.status, 503, `expected the mapped 503, got ${during.status}`);
    assert.equal(during.body.code, "storage_busy");
    assert.equal(during.headers?.["Retry-After"], "1");
    // Zero partial writes, read back through the holder's connection.
    assert.equal(holderDb.prepare("SELECT state FROM bounty_records WHERE bounty_id=?").get(bounty.bountyId).state, "funded");
    assert.equal(holderDb.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE bounty_id=? AND kind='bond-lock'").get(bounty.bountyId).n, 0);
    assert.equal(holderDb.prepare("SELECT COUNT(*) AS n FROM bounty_events WHERE bounty_id=? AND type='bounty.claimed'").get(bounty.bountyId).n, 0);

    holderDb.exec("ROLLBACK"); // release the write lock
    const retry = await callClaim();
    assert.equal(retry.status, 200);
    assert.equal(retry.body.bounty.state, "claimed");
    assert.equal(retry.body.bounty.claimant, GROK);
    expectConserved(escrow);
  } finally {
    holderDb.close(); contenderDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
