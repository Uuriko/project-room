// Tests for integration-map slice #4: bounty outcomes -> agent reputation.
//
// A minimal in-memory store double (same shape as bounty-escrow.test.js):
// node:sqlite plus a SAVEPOINT-based transaction().
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { bandOf, BOUNTY_SIGNAL_WEIGHTS, REPUTATION_BANDS } from "../server/reputation.mjs";
import { projectBountyReputation, reputationSummary, claimBand, claimEligibility, routingVisibility,
  signalsForEvent, PROBATION_MAX_CLAIM_CREDITS, PROBATION_MAX_CLAIM_MILLIS } from "../server/bounty-reputation.mjs";

const ROOM = "room-rep";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";     // challenger lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
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
  return { escrow, db };
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

// Post -> fund -> claim -> submit -> accept, then drive through the
// challenge window + epoch sweep to a full payout.
function runToPaid(escrow, { amount = 0.5, verifier = null, worker = GROK } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: worker });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: worker,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick((amount < 1 ? 24 : 3 * 24) * 3_600_000 + 1); // challenge window passes
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: worker });
  escrow.closeEpoch(ROOM, { caller: JILL });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

const scoreOf = (escrow, agent) => reputationSummary(escrow, ROOM, agent, { nowMs }).score;
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

test("band boundaries: trusted >= 40, standard >= -20, probation below", () => {
  assert.equal(bandOf(100), REPUTATION_BANDS.TRUSTED);
  assert.equal(bandOf(40), REPUTATION_BANDS.TRUSTED);
  assert.equal(bandOf(39.99), REPUTATION_BANDS.STANDARD);
  assert.equal(bandOf(0), REPUTATION_BANDS.STANDARD);
  assert.equal(bandOf(-20), REPUTATION_BANDS.STANDARD);
  assert.equal(bandOf(-20.01), REPUTATION_BANDS.PROBATION);
  assert.equal(bandOf(-100), REPUTATION_BANDS.PROBATION);
});

test("honest earner climbs: accepted + paid signals stack toward trusted", () => {
  const { escrow } = makeEscrow();
  const paid = runToPaid(escrow);
  assert.equal(paid.state, "paid");
  // One lifecycle: submission_accepted (+4, decayed ~24h by payout time) + payout_released (+8).
  const oneCycle = scoreOf(escrow, GROK);
  assert.ok(oneCycle > 11.9 && oneCycle < 12, `expected ~11.93, got ${oneCycle}`);
  const summary = reputationSummary(escrow, ROOM, GROK, { nowMs });
  assert.equal(summary.band, REPUTATION_BANDS.STANDARD);
  assert.equal(summary.positive, 2);
  assert.equal(summary.negative, 0);
  assert.equal(summary.signals.map(s => s.type).sort().join(","),
    "payout_released,submission_accepted");
  // Four more lifecycles push the earner into trusted (5 x 12 = 60, minus decay).
  for (let i = 0; i < 4; i++) runToPaid(escrow);
  const grown = reputationSummary(escrow, ROOM, GROK, { nowMs });
  assert.ok(grown.score >= 40, `expected trusted, got ${grown.score}`);
  assert.equal(grown.band, REPUTATION_BANDS.TRUSTED);
  assert.equal(grown.positive, 10);
});

test("projection is deterministic: replaying the event stream changes nothing", () => {
  const { escrow } = makeEscrow();
  runToPaid(escrow);
  const first = projectBountyReputation(escrow, ROOM, { nowMs });
  const second = projectBountyReputation(escrow, ROOM, { nowMs });
  assert.deepEqual(
    [...second.reputation.leaderboard(10)].map(r => [r.agentId, r.score, r.positive, r.negative]),
    [...first.reputation.leaderboard(10)].map(r => [r.agentId, r.score, r.positive, r.negative]));
  assert.equal(second.signals.length, first.signals.length);
});

test("failed retries never double-count: rejected transitions emit no events", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  const before = escrow.listEvents(ROOM).length;
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: CODEX }), "already_claimed");
  assert.equal(escrow.listEvents(ROOM).length, before);
  const a = projectBountyReputation(escrow, ROOM, { nowMs });
  const b = projectBountyReputation(escrow, ROOM, { nowMs });
  assert.deepEqual(a.signals.length, b.signals.length);
  assert.equal(scoreOf(escrow, CODEX), 0); // the failed claimer learned nothing
});

test("claim flake penalizes, then decays back toward neutral", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(3_600_000 + 1);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: INSTINCT });
  assert.equal(action, "refunded");
  assert.equal(scoreOf(escrow, GROK), BOUNTY_SIGNAL_WEIGHTS.claim_flaked); // -6
  assert.equal(claimBand(escrow, ROOM, GROK, { nowMs }), REPUTATION_BANDS.STANDARD);
  const summary = reputationSummary(escrow, ROOM, GROK, { nowMs });
  assert.equal(summary.signals.length, 1);
  assert.equal(summary.signals[0].type, "claim_flaked");
  // One half-life (30d): the flake halves.
  tick(30 * 24 * 3_600_000);
  const halved = scoreOf(escrow, GROK);
  assert.ok(Math.abs(halved - -3) < 1e-9, `expected ~-3, got ${halved}`);
  // Four half-lives: effectively forgiven.
  tick(90 * 24 * 3_600_000);
  const forgiven = scoreOf(escrow, GROK);
  assert.ok(forgiven > -0.4 && forgiven < 0, `expected ~-0.375, got ${forgiven}`);
});

test("dispute upheld: claimant drops to probation and is gated off large claims", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10, verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/2", summary: "shoddy" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  // Claimant: +4 (accepted) -12 (dispute_lost) -10 (bond_forfeited) = -18...
  // plus nothing else; challenger: +2 (dispute_won).
  assert.equal(scoreOf(escrow, GROK), -18);
  assert.equal(scoreOf(escrow, CODEX), BOUNTY_SIGNAL_WEIGHTS.dispute_won);
  // Not yet probation at -18. One more upheld dispute tips them over.
  const b2 = post(escrow, { amount: 10, verifierId: INSTINCT });
  escrow.fundBounty(ROOM, b2.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, b2.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, b2.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/3", summary: "shoddy again" } });
  escrow.acceptWork(ROOM, b2.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, b2.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work again" });
  escrow.decideDispute(ROOM, b2.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.ok(scoreOf(escrow, GROK) < -20, `expected probation, got ${scoreOf(escrow, GROK)}`);
  assert.equal(claimBand(escrow, ROOM, GROK, { nowMs }), REPUTATION_BANDS.PROBATION);
  // Gate: a 10-credit bounty is refused...
  const big = post(escrow, { amount: 10 });
  escrow.fundBounty(ROOM, big.bountyId, { funder: JILL });
  expectCode(() => escrow.claimBounty(ROOM, big.bountyId, { claimant: GROK }), "reputation_probation");
  // ...but a small bounty (<= 5 credits) still claims fine. Never a ban.
  const small = post(escrow, { amount: PROBATION_MAX_CLAIM_CREDITS });
  escrow.fundBounty(ROOM, small.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, small.bountyId, { claimant: GROK });
  assert.equal(escrow.getBounty(ROOM, small.bountyId).state, "claimed");
});

test("dispute rejected: challenger penalized, claimant vindicated", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10, verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/4", summary: "solid" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "nitpick" });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(scoreOf(escrow, GROK),
    BOUNTY_SIGNAL_WEIGHTS.submission_accepted + BOUNTY_SIGNAL_WEIGHTS.dispute_won); // 4 + 2
  assert.equal(scoreOf(escrow, CODEX), BOUNTY_SIGNAL_WEIGHTS.dispute_lost); // -12
});

test("dispute split: both sides share a small loss", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10, verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/5", summary: "meh" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "partial" });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(scoreOf(escrow, GROK),
    BOUNTY_SIGNAL_WEIGHTS.submission_accepted + BOUNTY_SIGNAL_WEIGHTS.dispute_split); // 4 - 4
  assert.equal(scoreOf(escrow, CODEX), BOUNTY_SIGNAL_WEIGHTS.dispute_split); // -4
});

test("listEvents returns the stream in seq order with parsed data", () => {
  const { escrow } = makeEscrow();
  runToPaid(escrow);
  const events = escrow.listEvents(ROOM);
  const types = events.map(e => e.type);
  assert.ok(types.includes("bounty.proposed"));
  assert.ok(types.includes("bounty.funded"));
  assert.ok(types.includes("bounty.claimed"));
  assert.ok(types.includes("bounty.accepted"));
  assert.ok(types.includes("bounty.paid"));
  for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq);
  const paid = events.find(e => e.type === "bounty.paid");
  assert.equal(paid.data.earner, GROK);
  assert.equal(typeof paid.data.paid, "number");
});

test("unknown event types and malformed payloads never crash the projector", () => {
  assert.deepEqual(signalsForEvent({ type: "chat.message", data: {} }), []);
  assert.deepEqual(signalsForEvent({ type: "bounty.paid", data: {} }), []);
  assert.deepEqual(signalsForEvent({ type: "bounty.decided", data: { outcome: "upheld" } }), []);
  assert.deepEqual(signalsForEvent({ type: "bounty.refunded", data: { reason: "timeout" } }), []);
  assert.deepEqual(signalsForEvent({ type: "bounty.refunded",
    data: { reason: "timeout", claimant: GROK } }),
    [{ agent: GROK, type: "claim_flaked" }]);
});

test("claimEligibility reports the band and the probation cap", () => {
  const { escrow } = makeEscrow();
  const open = claimEligibility(escrow, ROOM, GROK, 10_000, { nowMs });
  assert.equal(open.allowed, true);
  assert.equal(open.band, REPUTATION_BANDS.STANDARD);
  assert.equal(open.maxClaimMillis, null);
});

test("verifier acceptance overturned: upheld dispute penalizes the verifier (overturn-rate feed)", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10, verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/9", summary: "shoddy" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: INSTINCT,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  // The verifier's pinned-rubric acceptance was overturned: -8.
  assert.equal(scoreOf(escrow, INSTINCT), BOUNTY_SIGNAL_WEIGHTS.acceptance_overturned);
  const summary = reputationSummary(escrow, ROOM, INSTINCT, { nowMs });
  assert.ok(summary.signals.some(s => s.type === "acceptance_overturned"), "overturn signal recorded");
  assert.equal(summary.band, REPUTATION_BANDS.STANDARD);
  // Claimant/challenger signals are unchanged.
  assert.equal(scoreOf(escrow, GROK),
    BOUNTY_SIGNAL_WEIGHTS.submission_accepted + BOUNTY_SIGNAL_WEIGHTS.dispute_lost + BOUNTY_SIGNAL_WEIGHTS.bond_forfeited);
  assert.equal(scoreOf(escrow, CODEX), BOUNTY_SIGNAL_WEIGHTS.dispute_won);
});

test("rejected dispute overturns nothing: no acceptance_overturned for the verifier", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10, verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/10", summary: "fine work" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: INSTINCT,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "sour grapes" });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["frivolous"] });
  // The acceptance stood: the verifier takes no signal.
  assert.equal(scoreOf(escrow, INSTINCT), 0);
  const summary = reputationSummary(escrow, ROOM, INSTINCT, { nowMs });
  assert.deepEqual(summary.signals, []);
});

test("sybil flag confirmed: member lanes take sybil_confirmed; dismissed stays neutral", () => {
  const { escrow } = makeEscrow();
  const identical = { evidenceUrl: "https://example.com/pr/sybil-rep",
    evidenceKind: "work.completed", summary: "identical submission" };
  // First pair: byte-identical evidence -> copy-paste flag -> confirmed.
  const a = post(escrow, { amount: 5 });
  escrow.fundBounty(ROOM, a.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, a.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, a.bountyId, { claimant: GROK, evidence: { ...identical } });
  const b = post(escrow, { amount: 5 });
  escrow.fundBounty(ROOM, b.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, b.bountyId, { claimant: CODEX });
  const { flags } = escrow.submitWork(ROOM, b.bountyId, { claimant: CODEX, evidence: { ...identical } });
  assert.ok(flags.length >= 1, "copy-paste cluster raised a flag");
  tick(1000);
  escrow.resolveSybilFlag(ROOM, flags[0].flagId,
    { resolution: "confirmed", reason: "same author behind two lanes", resolver: JILL });
  assert.equal(scoreOf(escrow, GROK), BOUNTY_SIGNAL_WEIGHTS.sybil_confirmed);
  assert.ok(Math.abs(scoreOf(escrow, CODEX) - BOUNTY_SIGNAL_WEIGHTS.sybil_confirmed) < 1e-3,
    "confirmed flag adds exactly one sybil_confirmed per member lane");
  const grokSummary = reputationSummary(escrow, ROOM, GROK, { nowMs });
  assert.ok(grokSummary.signals.some(s => s.type === "sybil_confirmed"));
  // Second pair, different evidence: flag raised, then dismissed as honest
  // coincidence — no reputation trace for either lane.
  const c = post(escrow, { amount: 5 });
  escrow.fundBounty(ROOM, c.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, c.bountyId, { claimant: INSTINCT });
  escrow.submitWork(ROOM, c.bountyId, { claimant: INSTINCT,
    evidence: { evidenceUrl: "https://example.com/pr/template", evidenceKind: "work.completed", summary: "template task" } });
  const d = post(escrow, { amount: 5 });
  escrow.fundBounty(ROOM, d.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, d.bountyId, { claimant: CODEX });
  const r2 = escrow.submitWork(ROOM, d.bountyId, { claimant: CODEX,
    evidence: { evidenceUrl: "https://example.com/pr/template", evidenceKind: "work.completed", summary: "template task" } });
  assert.ok(r2.flags.length >= 1, "second copy-paste cluster raised a flag");
  tick(1000);
  escrow.resolveSybilFlag(ROOM, r2.flags[0].flagId,
    { resolution: "dismissed", reason: "same template on a trivial task", resolver: JILL });
  assert.equal(scoreOf(escrow, INSTINCT), 0, "dismissed flag leaves no trace");
  assert.ok(Math.abs(scoreOf(escrow, CODEX) - BOUNTY_SIGNAL_WEIGHTS.sybil_confirmed) < 1e-3,
    "dismissed flag adds nothing on top of the earlier confirmed penalty");
});

test("probation gate denial produces a review packet for arbiters (never a suspension)", () => {
  const { escrow } = makeEscrow();
  // Drive GROK into probation with two upheld disputes.
  for (let i = 0; i < 2; i++) {
    const bounty = post(escrow, { amount: 10, verifierId: INSTINCT });
    escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
    escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
    escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
      evidence: { evidenceUrl: `https://example.com/pr/gate-${i}`, summary: "shoddy" } });
    escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
      verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
    escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
    escrow.decideDispute(ROOM, bounty.bountyId,
      { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
    tick(1000);
  }
  assert.equal(claimBand(escrow, ROOM, GROK, { nowMs }), REPUTATION_BANDS.PROBATION);
  const big = post(escrow, { amount: 10 });
  escrow.fundBounty(ROOM, big.bountyId, { funder: JILL });
  expectCode(() => escrow.claimBounty(ROOM, big.bountyId, { claimant: GROK }), "reputation_probation");
  const packets = escrow.getReputationPackets(ROOM);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].agentId, GROK);
  assert.equal(packets[0].band, "probation");
  assert.ok(packets[0].score < -20, `expected probation score, got ${packets[0].score}`);
  assert.equal(packets[0].bountyId, big.bountyId);
  assert.equal(packets[0].maxClaimMillis, PROBATION_MAX_CLAIM_MILLIS);
  assert.ok(packets[0].signals.some(s => s.type === "dispute_lost"), "packet carries the signals");
  // Retrying the denied claim does not spam the queue: one packet per 24h.
  expectCode(() => escrow.claimBounty(ROOM, big.bountyId, { claimant: GROK }), "reputation_probation");
  assert.equal(escrow.getReputationPackets(ROOM).length, 1);
  // After the dedupe window a fresh denial produces a fresh packet.
  tick(25 * 3600 * 1000);
  expectCode(() => escrow.claimBounty(ROOM, big.bountyId, { claimant: GROK }), "reputation_probation");
  assert.equal(escrow.getReputationPackets(ROOM).length, 2);
  // The lane is still not suspended: small claims keep working.
  const small = post(escrow, { amount: PROBATION_MAX_CLAIM_CREDITS });
  escrow.fundBounty(ROOM, small.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, small.bountyId, { claimant: GROK });
  assert.equal(escrow.getBounty(ROOM, small.bountyId).state, "claimed");
});

test("sybil.flag-resolved without member lanes never crashes the projector", () => {
  assert.deepEqual(signalsForEvent({ type: "sybil.flag-resolved", data: {} }), []);
  assert.deepEqual(signalsForEvent({ type: "sybil.flag-resolved",
    data: { resolution: "dismissed", memberLanes: [GROK, CODEX] } }), []);
  assert.deepEqual(signalsForEvent({ type: "sybil.flag-resolved",
    data: { resolution: "confirmed", memberLanes: [GROK, CODEX] } }),
    [{ agent: GROK, type: "sybil_confirmed" }, { agent: CODEX, type: "sybil_confirmed" }]);
});

test("routing visibility: per-viewer claimable annotation mirrors the claim gate; never hides, never touches money", () => {
  const { escrow } = makeEscrow();
  const small = post(escrow, { amount: PROBATION_MAX_CLAIM_CREDITS });
  const big = post(escrow, { amount: PROBATION_MAX_CLAIM_CREDITS + 1 });
  escrow.fundBounty(ROOM, small.bountyId, { funder: JILL });
  escrow.fundBounty(ROOM, big.bountyId, { funder: JILL });

  // No viewer: no annotation at all, nothing hidden.
  const plain = escrow.listBounties(ROOM, {});
  assert.equal(plain.length, 2);
  assert.ok(plain.every(b => b.viewerRouting === undefined), "no viewer -> no routing annotation");

  // Standard-band viewer: every bounty is routable to them.
  const std = escrow.listBounties(ROOM, { viewer: JILL });
  assert.equal(std.length, 2, "the listing never hides bounties");
  assert.ok(std.every(b => b.viewerRouting.band === REPUTATION_BANDS.STANDARD));
  assert.ok(std.every(b => b.viewerRouting.claimable === true), "standard band: all bounties routable");
  assert.ok(std.every(b => b.viewerRouting.maxClaimMillis === null));

  // Drop GROK to probation with two upheld disputes (claimant: +4 accepted,
  // -12 dispute_lost, -10 bond_forfeited each).
  for (const n of [1, 2]) {
    const b = post(escrow, { amount: 10, verifierId: INSTINCT });
    escrow.fundBounty(ROOM, b.bountyId, { funder: JILL });
    escrow.claimBounty(ROOM, b.bountyId, { claimant: GROK });
    escrow.submitWork(ROOM, b.bountyId, { claimant: GROK,
      evidence: { evidenceUrl: `https://example.com/pr/r${n}`, summary: "shoddy" } });
    escrow.acceptWork(ROOM, b.bountyId, { acceptor: JILL,
      verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
        citations: [{ criterionId: "c1", verdict: "pass" }] } });
    escrow.disputeBounty(ROOM, b.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
    escrow.decideDispute(ROOM, b.bountyId,
      { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  }
  assert.equal(claimBand(escrow, ROOM, GROK, { nowMs }), REPUTATION_BANDS.PROBATION);

  // Probation viewer: the small bounty is routable, the large one is not —
  // and the listing still shows everything (the two dispute bounties too).
  const prob = escrow.listBounties(ROOM, { viewer: GROK });
  assert.equal(prob.length, 4, "probation hides nothing from the listing");
  const byId = Object.fromEntries(prob.map(b => [b.bountyId, b.viewerRouting]));
  assert.equal(byId[small.bountyId].band, REPUTATION_BANDS.PROBATION);
  assert.equal(byId[small.bountyId].claimable, true, "small bounty stays routable on probation");
  assert.equal(byId[big.bountyId].claimable, false, "large bounty not routable on probation");
  assert.equal(byId[big.bountyId].maxClaimMillis, PROBATION_MAX_CLAIM_MILLIS);
  // Routing visibility never touches money: amounts and conservation intact.
  assert.equal(prob.find(b => b.bountyId === big.bountyId).amountMillis, (PROBATION_MAX_CLAIM_CREDITS + 1) * 1000);
  expectConserved(escrow);
});

test("routingVisibility mirrors claimEligibility across bands and amounts (no drift)", () => {
  const { escrow } = makeEscrow();
  // GROK to probation via two upheld disputes.
  for (const n of [1, 2]) {
    const b = post(escrow, { amount: 10, verifierId: INSTINCT });
    escrow.fundBounty(ROOM, b.bountyId, { funder: JILL });
    escrow.claimBounty(ROOM, b.bountyId, { claimant: GROK });
    escrow.submitWork(ROOM, b.bountyId, { claimant: GROK,
      evidence: { evidenceUrl: `https://example.com/pr/d${n}`, summary: "shoddy" } });
    escrow.acceptWork(ROOM, b.bountyId, { acceptor: JILL,
      verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
        citations: [{ criterionId: "c1", verdict: "pass" }] } });
    escrow.disputeBounty(ROOM, b.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
    escrow.decideDispute(ROOM, b.bountyId,
      { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  }
  for (const lane of [JILL, GROK]) {
    const vis = routingVisibility(escrow, ROOM, lane, { nowMs });
    for (const amountMillis of [1, PROBATION_MAX_CLAIM_MILLIS, PROBATION_MAX_CLAIM_MILLIS + 1, 10_000_000]) {
      const gate = claimEligibility(escrow, ROOM, lane, amountMillis, { nowMs });
      assert.equal(vis.claimable(amountMillis), gate.allowed,
        `routing claimable must mirror the gate for ${lane} at ${amountMillis} millis`);
      assert.equal(vis.band, gate.band, "same band on both paths");
    }
  }
  const prob = routingVisibility(escrow, ROOM, GROK, { nowMs });
  assert.equal(prob.band, REPUTATION_BANDS.PROBATION);
  assert.equal(prob.claimable(PROBATION_MAX_CLAIM_MILLIS), true);
  assert.equal(prob.claimable(PROBATION_MAX_CLAIM_MILLIS + 1), false);
  const std = routingVisibility(escrow, ROOM, JILL, { nowMs });
  assert.equal(std.maxClaimMillis, null, "non-probation bands carry no cap");
});
