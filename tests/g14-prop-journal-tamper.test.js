// Guild-14 property test: journal tamper-evidence.
// verifyConservation re-hashes every account chain: flipping an amount, a
// hash, or a prev_hash in the journal must surface a violation, and replaying
// the journal from genesis must re-derive the same balances.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-journal";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT g14j");
    try { const out = fn(); db.exec("RELEASE g14j"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14j"); db.exec("RELEASE g14j"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

function seed(escrow) {
  const b = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, b.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, b.bountyId, { claimant: GROK });
  escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 3 });
}

test("g14-journal: amount tamper breaks conservation", () => {
  const { escrow, db } = makeEscrow();
  seed(escrow);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
  db.prepare("UPDATE bounty_journal SET amount = amount + 1000 WHERE rowid = (SELECT MAX(rowid) FROM bounty_journal)").run();
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, false);
  assert.ok(c.violations.some(v => /hash mismatch|global sum|negative balance/.test(v)), JSON.stringify(c.violations));
});

test("g14-journal: hash tamper breaks conservation", () => {
  const { escrow, db } = makeEscrow();
  seed(escrow);
  db.prepare("UPDATE bounty_journal SET hash = 'deadbeef' WHERE rowid = (SELECT MIN(rowid) FROM bounty_journal)").run();
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, false);
  assert.ok(c.violations.some(v => /hash/.test(v)), JSON.stringify(c.violations));
});

test("g14-journal: prev_hash tamper breaks chain linkage", () => {
  const { escrow, db } = makeEscrow();
  seed(escrow);
  db.prepare("UPDATE bounty_journal SET prev_hash = 'tampered' WHERE rowid = (SELECT MAX(rowid) FROM bounty_journal)").run();
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, false);
  assert.ok(c.violations.some(v => /chain break/.test(v)), JSON.stringify(c.violations));
});

test("g14-journal: replay from journal re-derives identical balances", () => {
  const { escrow, db } = makeEscrow();
  seed(escrow);
  const lanes = ["id:agent/jill", "id:agent/grokbot", "id:agent/instinct", "id:agent/codex", "pool"];
  const rows = db.prepare("SELECT account_id, lot_state, SUM(amount) AS t FROM bounty_journal WHERE room_id=? GROUP BY account_id, lot_state").all(ROOM);
  const replayed = new Map();
  for (const r of rows) replayed.set(`${r.account_id}/${r.lot_state}`, r.t);
  for (const lane of lanes) {
    const b = escrow.balances(ROOM, lane);
    for (const state of ["payable", "locked", "attributed", "approved"]) {
      assert.equal(replayed.get(`${lane}/${state}`) ?? 0, b[state] * 1000, `replay mismatch ${lane}/${state}`);
    }
  }
});
