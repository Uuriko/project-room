// Tests for the closeEpoch due-filter (AUDIT-50X X-06 / M-2).
//
// Before this filter, closeEpoch wrapped EVERY open bounty in its own
// isolated transaction (#3275) just for _keeperPass to return null for the
// overwhelming majority that were not due: ~2 statements of pure wrapper
// overhead per not-due bounty (measured in audit lane 08: a nothing-due
// epoch over 100 open bounties costs 207 statements, 0 writes). The filter
// (BountyEscrow._keeperDue) evaluates due-ness from the already-fetched
// row before any transaction opens, and the acting path inside the
// transaction is unchanged.
//
// HARD REQUIREMENT (charter C-08 step 2): this suite enumerates EVERY
// condition under which _keeperPass acts — plus closeEpoch's own approved
// sweep — and proves the pre-check cannot skip an acting bounty:
//
//   acting condition (from _keeperPass / closeEpoch source)     covered by
//   ----------------------------------------------------------  ----------
//   approved: sweep runs unconditionally                        table + T-b
//   proposed: now >= deadline, snooze lapsed (null or <= now)   table + T-a
//   accepted: challengeEnds set, now >= challengeEnds           table + T-b
//   submitted: now >= deadline (not in closeEpoch's SELECT;     table
//     the pass acts on it via finalizeBounty, so the predicate
//     must stay exact — T-e pins that closeEpoch leaves it be
//     because of the SELECT, not because of the filter)
//   funded / claimed: now >= deadline                           table + T-a
//   disputed: disputeId set, no resolution, and dispute record  table + T-c
//     terminal (resolved/withdrawn), or open past the 14-day
//     timeout (strict >)
//   disputed with a MISSING dispute record: _keeperPass throws  table + T-c
//     via _disputes.get; closeEpoch records summary.failed —
//     observable behaviour the filter must preserve, so a
//     missing record is DUE for the filter
//   every non-due twin of the above (each threshold 1 ms shy,   table + T-d
//     snooze pending, challenge open, dispute open and young,
//     resolution already recorded, no disputeId, terminal
//     states) must open NO isolated transaction
//
// Construction mirrors tests/bounty-escrow.test.js: in-memory
// node:sqlite, SAVEPOINT transaction double, fake clock. The double
// counts isolated transactions so the filter's effect is asserted
// directly, not inferred.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, DISPUTE_TIMEOUT_MS } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";     // challenger lane
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld() {
  const db = new DatabaseSync(":memory:");
  const counter = { isolated: 0 };
  const transaction = (fn, opts) => {
    if (opts?.isolated) counter.isolated += 1;
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db, counter };
}

const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(30 * DAY_MS), ...overrides }).bounty;

function runToAccepted(escrow, { verifier = null } = {}) {
  const bounty = post(escrow, { verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

function runToDisputed(escrow) {
  const bounty = runToAccepted(escrow, { verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks wrong" });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("enumeration: _keeperDue matches every _keeperPass acting condition, boundaries included", () => {
  const { escrow } = makeWorld();
  const NOW = nowMs;
  escrow._disputeRecords.set("d-open", { state: "adjudicating" });
  escrow._disputeRecords.set("d-resolved", { state: "resolved" });
  escrow._disputeRecords.set("d-withdrawn", { state: "withdrawn" });
  const base = { state: "proposed", deadlineMs: NOW + DAY_MS, snoozedUntilMs: null,
    challengeEndsMs: null, disputeId: null, disputeOpenedMs: null, resolution: null };
  const cases = [
    // approved: the closeEpoch sweep is unconditional
    [{ state: "approved" }, true],
    [{ state: "approved", deadlineMs: NOW + DAY_MS, challengeEndsMs: NOW + DAY_MS }, true],
    // proposed: deadline passed AND snooze lapsed
    [{ state: "proposed", deadlineMs: NOW }, true, "deadline boundary is >="],
    [{ state: "proposed", deadlineMs: NOW + 1 }, false],
    [{ state: "proposed", deadlineMs: NOW - 1, snoozedUntilMs: NOW + 1 }, false, "snooze still pending"],
    [{ state: "proposed", deadlineMs: NOW - 1, snoozedUntilMs: NOW }, true, "snooze lapses at >="],
    [{ state: "proposed", deadlineMs: NOW - 1, snoozedUntilMs: NOW - 1 }, true],
    // accepted: challenge window only; the deadline is irrelevant
    [{ state: "accepted", challengeEndsMs: NOW }, true, "challenge boundary is >="],
    [{ state: "accepted", challengeEndsMs: NOW + 1 }, false],
    [{ state: "accepted", challengeEndsMs: null, deadlineMs: NOW - 1 }, false],
    // submitted / funded / claimed: deadline only
    [{ state: "submitted", deadlineMs: NOW }, true],
    [{ state: "submitted", deadlineMs: NOW + 1 }, false],
    [{ state: "funded", deadlineMs: NOW }, true],
    [{ state: "funded", deadlineMs: NOW + 1 }, false],
    [{ state: "claimed", deadlineMs: NOW }, true],
    [{ state: "claimed", deadlineMs: NOW + 1 }, false],
    // disputed: needs disputeId and no recorded resolution
    [{ state: "disputed", disputeId: null, disputeOpenedMs: NOW - DISPUTE_TIMEOUT_MS - 1 }, false],
    [{ state: "disputed", disputeId: "d-open", resolution: { kind: "release" }, disputeOpenedMs: NOW - DISPUTE_TIMEOUT_MS - 1 }, false, "resolution already recorded"],
    // disputed, open record: timeout is a strict >
    [{ state: "disputed", disputeId: "d-open", disputeOpenedMs: NOW - DISPUTE_TIMEOUT_MS }, false, "exactly 14d is not past the timeout"],
    [{ state: "disputed", disputeId: "d-open", disputeOpenedMs: NOW - DISPUTE_TIMEOUT_MS - 1 }, true],
    [{ state: "disputed", disputeId: "d-open", disputeOpenedMs: null }, false],
    // disputed, terminal record: due immediately, whatever the clock says
    [{ state: "disputed", disputeId: "d-resolved", disputeOpenedMs: NOW }, true],
    [{ state: "disputed", disputeId: "d-withdrawn", disputeOpenedMs: NOW }, true],
    // disputed, missing record: _keeperPass throws -> summary.failed; due
    [{ state: "disputed", disputeId: "d-missing", disputeOpenedMs: NOW }, true, "missing record must not be skipped"],
    // states the pass never acts on
    [{ state: "paid" }, false],
    [{ state: "cancelled" }, false],
    [{ state: "refunded" }, false],
  ];
  for (const [overrides, expected, note] of cases) {
    const bounty = { ...base, ...overrides };
    assert.equal(escrow._keeperDue(bounty, NOW), expected,
      `${JSON.stringify(overrides)}${note ? ` (${note})` : ""}`);
  }
});

test("T-a: deadline conditions act, their not-due twins open no transaction", () => {
  const { escrow, counter } = makeWorld();
  const proposedDue = post(escrow, { deadline: isoFuture(3600_000) });
  const proposedIdle = post(escrow, { deadline: isoFuture(30 * DAY_MS) });
  const fundedDue = post(escrow, { deadline: isoFuture(3600_000) });
  escrow.fundBounty(ROOM, fundedDue.bountyId, { funder: JILL });
  const fundedIdle = post(escrow, {});
  escrow.fundBounty(ROOM, fundedIdle.bountyId, { funder: JILL });
  const claimedDue = post(escrow, { deadline: isoFuture(3600_000) });
  escrow.fundBounty(ROOM, claimedDue.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, claimedDue.bountyId, { claimant: GROK });
  // A proposed bounty past its deadline but snoozed into the future is
  // NOT due; one whose snooze has lapsed IS.
  const snoozedIdle = post(escrow, { deadline: isoFuture(3600_000) });
  escrow.snoozeBounty(ROOM, snoozedIdle.bountyId, { snoozer: JILL, until: isoFuture(10 * DAY_MS) });

  tick(2 * 3600_000); // the 1h deadlines pass; the snooze (10d) does not
  counter.isolated = 0;
  const { summary } = escrow.closeEpoch(ROOM);
  assert.deepEqual(summary.expiredUnfunded, [proposedDue.bountyId]);
  assert.deepEqual(new Set(summary.refunded), new Set([fundedDue.bountyId, claimedDue.bountyId]));
  assert.equal(summary.failed, undefined);
  assert.equal(counter.isolated, 3, "exactly the three due bounties opened a transaction");
  assert.equal(escrow.getBounty(ROOM, proposedIdle.bountyId).state, "proposed");
  assert.equal(escrow.getBounty(ROOM, fundedIdle.bountyId).state, "funded");
  assert.equal(escrow.getBounty(ROOM, snoozedIdle.bountyId).state, "proposed");
  expectConserved(escrow);
});

test("T-b: accepted approves at the challenge boundary, approved sweeps next epoch", () => {
  const { escrow, counter } = makeWorld();
  const bounty = runToAccepted(escrow); // 10 credits -> 3-day challenge window
  tick(2 * DAY_MS); // window still open
  counter.isolated = 0;
  let out = escrow.closeEpoch(ROOM);
  assert.deepEqual(out.summary.approved, []);
  assert.equal(counter.isolated, 0, "an in-window accepted bounty opens no transaction");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "accepted");

  tick(1 * DAY_MS); // exactly at the window's end: now >= challengeEnds
  out = escrow.closeEpoch(ROOM);
  assert.deepEqual(out.summary.approved, [bounty.bountyId]);
  assert.equal(counter.isolated, 1);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");

  counter.isolated = 0;
  out = escrow.closeEpoch(ROOM);
  assert.deepEqual(out.summary.swept, [bounty.bountyId], "approved always sweeps");
  assert.equal(counter.isolated, 1);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  expectConserved(escrow);
});

test("T-c: disputed timeout, terminal retry and missing record all act; a young dispute is skipped", () => {
  const { escrow, counter } = makeWorld();
  const timedOut = runToDisputed(escrow);
  const terminal = runToDisputed(escrow);
  const missing = runToDisputed(escrow);
  tick(15 * DAY_MS); // past the 14-day dispute timeout for all three
  const young = runToDisputed(escrow); // opened now: neither terminal nor timed out

  // Terminal retry: the dispute machine record is resolved but the bounty
  // never settled (the inline finalize handler threw in production).
  const rec = escrow._disputeRecords.get(terminal.disputeId);
  escrow._disputeRecords.set(terminal.disputeId, Object.freeze({ ...rec, state: "resolved",
    resolution: Object.freeze({ outcome: "rejected", reasonCodes: ["criterion-unmet"] }) }));
  // Missing record: _keeperPass throws via _disputes.get; the epoch must
  // still record summary.failed for it, so the filter must not skip it.
  escrow._disputeRecords.delete(missing.disputeId);

  counter.isolated = 0;
  const { summary } = escrow.closeEpoch(ROOM);
  assert.deepEqual(new Set(summary.released), new Set([timedOut.bountyId, terminal.bountyId]),
    "timeout defaults to release; a terminal dispute retries its settlement");
  assert.deepEqual(summary.failed?.map(f => f.bountyId), [missing.bountyId],
    "the missing-record bounty still surfaces as failed, exactly as without the filter");
  assert.equal(counter.isolated, 3, "due disputes opened a transaction; the young dispute did not");
  assert.equal(escrow.getBounty(ROOM, young.bountyId).state, "disputed");
  assert.equal(escrow.getBounty(ROOM, timedOut.bountyId).state, "approved", "released disputes vest, then sweep next epoch");
  expectConserved(escrow);
});

test("T-d: a nothing-due epoch over many open bounties opens zero isolated transactions", () => {
  const { escrow, counter } = makeWorld();
  for (let i = 0; i < 20; i++) post(escrow, {}); // proposed, deadline 30d out
  const funded = post(escrow, {});
  escrow.fundBounty(ROOM, funded.bountyId, { funder: JILL });
  const accepted = runToAccepted(escrow); // challenge window open
  const disputed = runToDisputed(escrow); // dispute young
  assert.equal(escrow.getBounty(ROOM, accepted.bountyId).state, "accepted");
  assert.equal(escrow.getBounty(ROOM, disputed.bountyId).state, "disputed");

  counter.isolated = 0;
  const { summary, event } = escrow.closeEpoch(ROOM);
  assert.equal(counter.isolated, 0);
  assert.deepEqual(summary, { approved: [], swept: [], refunded: [], released: [], paid: [], expiredUnfunded: [] });
  assert.equal(event.type, "epoch.closed", "the epoch event is still emitted");
  expectConserved(escrow);
});

test("T-e: closeEpoch does not reach submitted bounties (its SELECT scope, not the filter)", () => {
  const { escrow, counter } = makeWorld();
  const bounty = post(escrow, { deadline: isoFuture(3600_000) });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  tick(2 * 3600_000); // deadline passes: _keeperPass WOULD refund it...
  // ...and the predicate says so (it must stay exact for finalizeBounty):
  const row = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(escrow._keeperDue(
    { state: "submitted", deadlineMs: nowMs - 1, snoozedUntilMs: null, challengeEndsMs: null,
      disputeId: null, disputeOpenedMs: null, resolution: null }, nowMs), true);
  assert.equal(row.state, "submitted");
  counter.isolated = 0;
  const { summary } = escrow.closeEpoch(ROOM);
  assert.deepEqual(summary.refunded, [], "closeEpoch's SELECT never included 'submitted' — unchanged by the filter");
  assert.equal(counter.isolated, 0);
  // finalizeBounty (the door that does reach it) still settles it.
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId);
  assert.equal(fin.action, "refunded");
  expectConserved(escrow);
});
