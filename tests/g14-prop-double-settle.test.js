// Guild-14 property test: kill -9 mid-settlement must not double-apply.
// File-backed sqlite DB: run the lifecycle, "crash" by dropping the handle
// mid-way (reopening on the same file), then retry settlement. Invariants:
// conservation holds, paid amount is applied exactly once, re-finalize and
// re-closeEpoch after a paid bounty are no-ops.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, MILLIS_PER_CREDIT } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-crash";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function openOn(file) {
  const db = new DatabaseSync(file);
  const transaction = fn => {
    db.exec("SAVEPOINT g14c");
    try { const out = fn(); db.exec("RELEASE g14c"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14c"); db.exec("RELEASE g14c"); throw e; }
  };
  return new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
}

function runToAccepted(escrow, amount) {
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/x", summary: "w" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return bounty.bountyId;
}

test("g14-crash: reopen after crash keeps conservation and committed state", () => {
  const file = join(mkdtempSync(join(tmpdir(), "g14-crash-")), "escrow.db");
  let escrow = openOn(file);
  escrow.ensureGenesis(ROOM);
  const id = runToAccepted(escrow, 25);
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.finalizeBounty(ROOM, id, {});
  // "kill -9": drop the handle without closing; reopen a fresh one.
  escrow = openOn(file);
  escrow.ensureGenesis(ROOM); // no-op, must not double-issue
  // The award moved to the claimant's attributed lot on accept: JILL keeps
  // 75, GROK holds 25 attributed + 1 locked (claim bond). Genesis total (400)
  // is what must not be double-issued.
  assert.equal(escrow.balances(ROOM, JILL).payable, 75);
  assert.equal(escrow.balances(ROOM, GROK).approved, 25, "award vested in claimant's approved lot");
  const genesisTotal = ["id:agent/jill", "id:agent/grokbot", "id:agent/instinct", "id:agent/codex"]
    .reduce((s, l) => s + escrow.balances(ROOM, l).total, 0) + escrow.balances(ROOM, "pool").total;
  assert.equal(genesisTotal, 400, "genesis must not double-issue on reopen");
  const b = escrow.getBounty(ROOM, id);
  assert.equal(b.state, "approved");
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `post-crash conservation: ${JSON.stringify(c.violations)}`);
  // Retry settlement after crash: completes exactly once.
  const before = escrow.balances(ROOM, GROK).payable;
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.closeEpoch(ROOM, {});
  const after = escrow.balances(ROOM, GROK).payable;
  const gross = 25 * MILLIS_PER_CREDIT;
  const expectNet = (gross - Math.floor(gross / 100)) / MILLIS_PER_CREDIT;
  // Worker gets the net award PLUS the 1-credit claim bond returned.
  assert.ok(Math.abs((after - before) - (expectNet + 1)) < 1e-9, `expected ${expectNet + 1}, got ${after - before}`);
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.closeEpoch(ROOM, {}); // second sweep: must be a no-op
  assert.equal(escrow.balances(ROOM, GROK).payable, after, "double sweep detected");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("g14-crash: crash between finalize and epoch close cannot strand funds", () => {
  const file = join(mkdtempSync(join(tmpdir(), "g14-crash2-")), "escrow.db");
  let escrow = openOn(file);
  escrow.ensureGenesis(ROOM);
  const ids = [runToAccepted(escrow, 10), runToAccepted(escrow, 40)];
  tick(3 * 24 * 3600 * 1000 + 1);
  for (const id of ids) escrow.finalizeBounty(ROOM, id, {});
  escrow = openOn(file); // crash
  tick(3 * 24 * 3600 * 1000 + 1);
  const summary = escrow.closeEpoch(ROOM, {});
  assert.equal(summary.summary.swept.length, 2);
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation after crash-recovery sweep: ${JSON.stringify(c.violations)}`);
});
