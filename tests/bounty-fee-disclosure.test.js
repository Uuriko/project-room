// Fee disclosure (UT26 lane 13 finding 13-1): the 1% room-pool fee was
// invisible at create, at fund, in attribution, and in the Terms/docs.
// These tests pin the disclosure cure: every bounty view carries the
// gross / fee / net breakdown, the accept attribution carries net + fee
// (not gross only), and the Terms + bounty MCP doc state the fee in the
// same terms. The fee is deducted from the award on released payouts
// only; the poster is never charged on top of the award.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, awardFeeBreakdown } from "../server/bounty-escrow.mjs";
import { EMBEDDED_LEGAL } from "../server/legal-documents.mjs";
import { TERMS_VERSION } from "../server/legal-store.mjs";

const ROOM = "room-fee-disclosure";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

const post = (escrow, amount = 10) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000) });

test("awardFeeBreakdown computes gross, fee and net with the sweep's floor rule", () => {
  const ten = awardFeeBreakdown(10_000);
  assert.equal(ten.grossCredits, 10);
  assert.equal(ten.feeCredits, 0.1);
  assert.equal(ten.netCredits, 9.9);
  assert.equal(ten.ratePercent, 1);
  const four = awardFeeBreakdown(4_000);
  assert.equal(four.feeCredits, 0.04);
  assert.equal(four.netCredits, 3.96);
  // Sub-0.1-credit awards: the floor at milli precision can make the fee 0,
  // and the disclosure must say so rather than promise a 1% deduction.
  const micro = awardFeeBreakdown(50);
  assert.equal(micro.feeCredits, 0);
  assert.equal(micro.netCredits, 0.05);
  const odd = awardFeeBreakdown(150);
  assert.equal(odd.feeCredits, 0.001);
  assert.equal(odd.netCredits, 0.149);
});

test("awardFeeBreakdown summary states the rule without poster-pays or signing claims", () => {
  const { summary } = awardFeeBreakdown(10_000);
  assert.match(summary, /deducted from the award/);
  assert.match(summary, /room pool/);
  assert.match(summary, /not charged/);
  assert.match(summary, /released/);
  assert.doesNotMatch(summary, /signed/i);
});

test("create and fund responses carry the fee disclosure on the bounty", () => {
  const escrow = makeEscrow();
  const { bounty: proposed } = post(escrow, 10);
  assert.equal(proposed.feeDisclosure.grossCredits, 10);
  assert.equal(proposed.feeDisclosure.feeCredits, 0.1);
  assert.equal(proposed.feeDisclosure.netCredits, 9.9);
  assert.equal(proposed.feeDisclosure.ratePercent, 1);
  const { bounty: funded } = escrow.fundBounty(ROOM, proposed.bountyId, { funder: JILL });
  assert.deepEqual(funded.feeDisclosure, proposed.feeDisclosure);
  const listed = escrow.listBounties(ROOM);
  const row = (listed.bounties ?? listed).find(b => b.bountyId === proposed.bountyId);
  assert.equal(row.feeDisclosure.netCredits, 9.9);
});

test("accept attribution shows gross, fee and net, not gross only", () => {
  const escrow = makeEscrow();
  const { bounty } = post(escrow, 10);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const { attribution } = escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  assert.equal(attribution.amount, 10); // existing gross field, unchanged
  assert.equal(attribution.grossCredits, 10);
  assert.equal(attribution.feeCredits, 0.1);
  assert.equal(attribution.netCredits, 9.9);
  assert.equal(attribution.feeDisclosure.netCredits, 9.9);
});

test("Terms disclose the fee in the same terms and the version matches", () => {
  const termsFile = readFileSync(new URL("../docs/legal/terms.md", import.meta.url), "utf8");
  assert.equal(EMBEDDED_LEGAL["terms.md"], termsFile);
  assert.match(termsFile, new RegExp(`^Version: ${TERMS_VERSION}$`, "m"));
  assert.match(termsFile, /1% of the released amount is deducted from the award/);
  assert.match(termsFile, /room pool/);
  assert.match(termsFile, /not charged[\s\S]{0,80}on top of the award/);
  assert.match(termsFile, /[Rr]efunded awards are returned in full/);
});

test("bounty MCP doc discloses the fee", () => {
  const doc = readFileSync(new URL("../docs/BOUNTY-MCP-TOOLS.md", import.meta.url), "utf8");
  assert.match(doc, /1% room-pool fee/);
  assert.match(doc, /deducted from the award/);
  assert.match(doc, /feeDisclosure/);
});
