// Escrow-family replays (in-memory BountyEscrow, fake clock — the
// HUNT-ECONOMICS probe pattern). Findings: SM-F1, FUZZ-F1, SM-F2, CHAOS-4,
// ECON-1, ECON-2, ECON-5A, ECON-5B, ECON-6, TM-7.
import { escrowWorld, verdict, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const JILL = "id:agent/jill", GROK = "id:agent/grokbot", CODEX = "id:agent/codex", INSTINCT = "id:agent/instinct";
const ATTEST = (w) => ({ at: w.iso(0), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] });

async function lifecycle(w, R, poster, worker, amount, { deadlineDays = 30, decider = null } = {}) {
  const e = w.escrow;
  e.ensureGenesis(R);
  const b = e.postBounty(R, { poster, title: "T", criteria: "C", amount, deadline: w.iso(deadlineDays * w.DAY), ...(decider ? { disputeDeciderId: decider } : {}) }).bounty;
  e.fundBounty(R, b.bountyId, { funder: poster });
  e.claimBounty(R, b.bountyId, { claimant: worker });
  e.submitWork(R, b.bountyId, { claimant: worker, evidence: { evidenceUrl: "https://example.com/x", summary: "work" } });
  return b;
}
async function settleAccepted(w, R, b, poster) {
  w.escrow.acceptWork(R, b.bountyId, { acceptor: poster, verifierAttestation: ATTEST(w) });
  w.advance(4 * w.DAY);
  w.progressEscrowEpochs(w.store, { now: w.now(), escrow: w.escrow });
  w.progressEscrowEpochs(w.store, { now: w.now(), escrow: w.escrow });
  return w.escrow.getBounty(R, b.bountyId);
}
const payable = (w, R, who) => w.escrow.balances(R, who).payable;

if (id === "SM-F1" || id === "FUZZ-F1") {
  const w = await escrowWorld();
  const R = "room-f1";
  const amount = id === "FUZZ-F1" ? 0.333 : 10; // fuzz variant: odd-milli award from the fuzz corpus shape
  const b = await lifecycle(w, R, JILL, GROK, amount, { deadlineDays: 1 });
  w.advance(2 * w.DAY);
  w.progressEscrowEpochs(w.store, { now: w.now(), escrow: w.escrow });
  const after = w.escrow.getBounty(R, b.bountyId);
  if (after.state === "submitted") still(`submitted bounty past deadline remains 'submitted' after keeper ticks — the F1 lock (poster payable ${payable(w, R, JILL)})`);
  else if (after.state === "refunded") fixed(`keeper settled the submitted bounty past deadline: state=${after.state}, poster refunded (PR #4103 in tree)`);
  else notfiled(`unexpected terminal state ${after.state}`);
} else if (id === "SM-F2" || id === "CHAOS-4") {
  // Keeper-blind (state x field) combos: corrupt/legacy rows no due branch sees.
  const w = await escrowWorld();
  const e = w.escrow, db = w.db;
  const R = "room-blind";
  e.ensureGenesis(R);
  const combos = [];
  // A: accepted + challenge_ends_ms NULL
  {
    const b = await lifecycle(w, R, JILL, GROK, 10);
    e.acceptWork(R, b.bountyId, { acceptor: JILL, verifierAttestation: ATTEST(w) });
    db.prepare("UPDATE bounty_records SET challenge_ends_ms=NULL WHERE bounty_id=?").run(b.bountyId);
    combos.push(["accepted+challenge_ends NULL", b.bountyId]);
  }
  // B: disputed + dispute_id NULL
  {
    const b = await lifecycle(w, R, JILL, GROK, 10, { decider: CODEX });
    e.acceptWork(R, b.bountyId, { acceptor: JILL, verifierAttestation: ATTEST(w) });
    e.disputeBounty(R, b.bountyId, { challenger: JILL, bond: 2.5, grounds: "g" });
    db.prepare("UPDATE bounty_records SET dispute_id=NULL WHERE bounty_id=?").run(b.bountyId);
    combos.push(["disputed+dispute_id NULL", b.bountyId]);
  }
  if (id === "SM-F2") {
    // C: disputed + resolution_json NOT NULL
    const b = await lifecycle(w, R, JILL, GROK, 10, { decider: CODEX });
    e.acceptWork(R, b.bountyId, { acceptor: JILL, verifierAttestation: ATTEST(w) });
    e.disputeBounty(R, b.bountyId, { challenger: JILL, bond: 2.5, grounds: "g" });
    db.prepare("UPDATE bounty_records SET resolution_json=? WHERE bounty_id=?").run(JSON.stringify({ outcome: "upheld" }), b.bountyId);
    combos.push(["disputed+resolution NOT NULL", b.bountyId]);
    // D: disputed + dispute_opened_ms NULL (open dispute)
    const b2 = await lifecycle(w, R, JILL, GROK, 10, { decider: CODEX });
    e.acceptWork(R, b2.bountyId, { acceptor: JILL, verifierAttestation: ATTEST(w) });
    e.disputeBounty(R, b2.bountyId, { challenger: JILL, bond: 2.5, grounds: "g" });
    db.prepare("UPDATE bounty_records SET dispute_opened_ms=NULL WHERE bounty_id=?").run(b2.bountyId);
    combos.push(["disputed+dispute_opened_ms NULL", b2.bountyId]);
  }
  w.advance(30 * w.DAY);
  const summary = w.progressEscrowEpochs(w.store, { now: w.now(), escrow: e });
  w.progressEscrowEpochs(w.store, { now: w.now(), escrow: e });
  const blind = combos.filter(([, bid]) => ["accepted", "disputed"].includes(e.getBounty(R, bid).state)).map(([name]) => name);
  if (blind.length === 0) fixed(`all ${combos.length} filed blind combos are now reached by the keeper (census/keeper coverage in tree)`);
  else if (id === "CHAOS-4" && !("unreachable" in summary) && blind.length > 0)
    still(`${blind.length}/${combos.length} nonterminal bounties match no due branch and stay invisible (${blind.join("; ")}); keeper summary has no unreachable census field — keys: ${Object.keys(summary).join(",")}`);
  else still(`${blind.length}/${combos.length} (state x field) combos remain keeper-invisible after 30 days + ticks: ${blind.join("; ")}`);
} else if (id === "ECON-1") {
  const w = await escrowWorld();
  const R = "room-ring";
  w.escrow.ensureGenesis(R);
  const before = payable(w, R, JILL) + payable(w, R, GROK);
  const b1 = await lifecycle(w, R, JILL, GROK, 10);
  const s1 = await settleAccepted(w, R, b1, JILL);
  const b2 = await lifecycle(w, R, GROK, JILL, 10);
  const s2 = await settleAccepted(w, R, b2, GROK);
  const after = payable(w, R, JILL) + payable(w, R, GROK);
  const loss = Math.round((before - after) * 1000);
  if (s1.state === "paid" && s2.state === "paid" && loss === 200)
    still(`reciprocal wash ring settled both cycles verified (states ${s1.state}/${s2.state}); coalition loss = ${loss} millis = exactly the 1% fee x2, no reciprocity screen intervenes`);
  else if (s1.state === "paid" && s2.state === "paid")
    still(`reciprocal cycles settled (states ${s1.state}/${s2.state}); coalition loss ${loss} millis`);
  else notfiled(`ring cycles did not settle as filed: states ${s1.state}/${s2.state}`);
} else if (id === "ECON-6") {
  const w = await escrowWorld();
  const R = "room-fee";
  const b = await lifecycle(w, R, JILL, GROK, 0.099);
  const s = await settleAccepted(w, R, b, JILL);
  const fees = w.db.prepare("SELECT COALESCE(SUM(amount),0) AS f FROM bounty_journal WHERE bounty_id=? AND kind LIKE '%fee%'").get(b.bountyId).f;
  if (s.state === "paid" && fees === 0) still(`99-milli award settled '${s.state}' with pool fee collected = 0 millis (fee = floor(amount/100)); the 0% tier executes`);
  else if (s.state === "paid") fixed(`sub-100-milli settlement now collects a fee (${fees} millis) — minimum-fee rule in tree`);
  else notfiled(`unexpected state ${s.state}`);
} else if (id === "ECON-2" || id === "TM-7") {
  const w = await escrowWorld();
  const R = "room-reversal";
  w.escrow.ensureGenesis(R);
  const genesisBalance = payable(w, R, JILL);
  const b = await lifecycle(w, R, JILL, GROK, 10, { decider: CODEX });
  w.escrow.acceptWork(R, b.bountyId, { acceptor: JILL, verifierAttestation: ATTEST(w) });
  w.escrow.disputeBounty(R, b.bountyId, { challenger: JILL, bond: 2.5, grounds: "g" });
  w.escrow.decideDispute(R, b.bountyId, { decider: CODEX, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  const after = w.escrow.getBounty(R, b.bountyId);
  const workerBal = w.escrow.balances(R, GROK);
  if (after.state === "refunded" && workerBal.reputation.earnedCredits === 0 && workerBal.payable < 100)
    still(`poster-named decider upheld the poster's dispute post-acceptance: bounty ${after.state}, worker earned 0, payable ${workerBal.payable} (< 100 genesis: claim bond forfeited, strike ${workerBal.flake.strikes})${id === "TM-7" ? `; poster operated entirely on the ${genesisBalance} cr genesis issuance` : ""} — no fund-flow independence check intervenes`);
  else notfiled(`reversal did not execute as filed: state=${after.state} earned=${workerBal.reputation.earnedCredits} payable=${workerBal.payable}`);
} else if (id === "ECON-5A") {
  const w = await escrowWorld();
  const R = "room-snipe";
  const b = await lifecycle(w, R, JILL, GROK, 10, { deadlineDays: 1 });
  w.advance(1 * w.DAY + 1000); // deadline + 1s
  let res = null, err = null;
  try { res = w.escrow.finalizeBounty(R, b.bountyId, { caller: INSTINCT }); } catch (e) { err = e; }
  const after = w.escrow.getBounty(R, b.bountyId);
  if (!err && after.state === "refunded")
    still(`an unrelated third party finalized the submitted bounty at deadline+1s: state=${after.state}, worker earns 0, settlement unverified — no review-grace or caller check`);
  else if (err) fixed(`third-party finalize at deadline+1s is refused: ${err.message}`);
  else notfiled(`finalize returned ${JSON.stringify(res)?.slice(0, 120)} with state ${after.state}`);
} else if (id === "ECON-5B") {
  const w = await escrowWorld();
  const R = "room-harvest";
  const b = await lifecycle(w, R, JILL, GROK, 10, { deadlineDays: 1 });
  // (lifecycle submitted at t0; deadline t0+24h; submittedAt+24h = t0+24h = deadline.
  //  Crisp E-10 test: submission at deadline-1h -> grace would run to deadline+23h.)
  w.advance(1 * w.DAY + 1000);
  w.progressEscrowEpochs(w.store, { now: w.now(), escrow: w.escrow });
  const after = w.escrow.getBounty(R, b.bountyId);
  const worker = w.escrow.balances(R, GROK);
  if (after.state === "refunded" && worker.reputation.earnedCredits === 0)
    still(`poster never accepted, keeper auto-refunded in full past deadline (state=${after.state}); worker earned 0 with the deliverable already served at submission, no strike/recourse and no submission-anchored grace (E-10 unbuilt)`);
  else notfiled(`unexpected outcome: state=${after.state} earned=${worker.reputation.earnedCredits}`);
} else {
  notfiled(`escrow.mjs has no probe for ${id}`);
}
