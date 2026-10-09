// Guild-14 property test: conservation fuzz over random lifecycle sequences.
// After EVERY operation, conservation must hold: global journal sum == genesis,
// no negative balances, per-bounty award coverage, hash chains intact.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-fuzz";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT g14");
    try { const out = fn(); db.exec("RELEASE g14"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14"); db.exec("RELEASE g14"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

// Deterministic LCG so failures are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

test("g14-fuzz: random lifecycles keep conservation", () => {
  for (let run = 0; run < 5; run++) {
    const escrow = makeEscrow();
    const rnd = lcg(0x14F0000 + run);
    const ids = [];
    for (let step = 0; step < 60; step++) {
      tick(60_000);
      const roll = rnd();
      try {
        if (ids.length === 0 || roll < 0.25) {
          const amount = [1, 2.5, 10, 0.001, 999.999][Math.floor(rnd() * 5)];
          const b = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000) }).bounty;
          ids.push(b.bountyId);
        } else {
          const id = ids[Math.floor(rnd() * ids.length)];
          const op = Math.floor(rnd() * 8);
          switch (op) {
            case 0: escrow.fundBounty(ROOM, id, { funder: JILL }); break;
            case 1: escrow.claimBounty(ROOM, id, { claimant: [GROK, INSTINCT, CODEX][Math.floor(rnd() * 3)] }); break;
            case 2: escrow.submitWork(ROOM, id, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/x", summary: "w" } }); break;
            case 3: escrow.acceptWork(ROOM, id, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] } }); break;
            case 4: escrow.finalizeBounty(ROOM, id, {}); break;
            case 5: escrow.closeEpoch(ROOM, {}); break;
            case 6: escrow.declineBounty(ROOM, id, { decliner: JILL, reason: "r" }); break;
            case 7: escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 1 }); break;
          }
        }
      } catch (e) {
        // Illegal transitions are expected noise; only EscrowErrors tolerated.
        assert.ok(e && typeof e.code === "string", `unexpected throw ${e}`);
      }
      expectConserved(escrow);
    }
  }
});
