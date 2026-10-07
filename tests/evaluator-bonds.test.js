// Evaluator bond registry — prototype tests (ACP wave, lane 10).
//
// Contracts owned here (nothing else covers them):
// - bond floor: assignVerdict refuses evaluators below quoteMinimumBond, so a
//   round can never be seated cheaper than the unprofitable-attack floor
// - no double-lock: the same available bond units can never back two verdicts
// - commitment breach: a reveal whose sha256 preimage misses the commit
//   slashes the full verdict lock (cryptographic proof, no human judgment)
// - no-reveal: commit without reveal by tally is a liveness fault -> slash
// - majority contradiction: a bonded majority >= quorum against your revealed
//   verdict slashes your lock; below-quorum disagreement (contested) never does
// - appeal: exactly one escalation, loser-pays 25%, fresh resolver only,
//   terminal afterwards
// - pull settlement: release/withdraw are evaluator-initiated; nothing pushed
//
// Authoring gate: each test names the regression it would catch; all go
// through the exported production functions against a fresh in-memory registry.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createEvaluatorBondRegistry,
  quoteMinimumBond,
  attackMargin,
  quorumFor,
  MIN_BOND_FLOOR,
  APPEAL_BOND_RATIO,
  EvaluatorBondError,
} from "../server/evaluator-bonds.mjs";

const commitFor = (verdict, salt) =>
  createHash("sha256").update(`${verdict}\n${salt}`).digest("hex");

function registry() {
  return createEvaluatorBondRegistry();
}

// Register three evaluators funded at the floor for a V=1000, n=3 round.
function fundedRound(t, { verdictValue = 1000, evaluators = ["a", "b", "c"], reward = 10 } = {}) {
  const reg = registry();
  const floor = quoteMinimumBond({ verdictValueUnits: verdictValue, evaluatorCount: evaluators.length, completionRewardUnits: reward });
  for (const id of evaluators) reg.registerEvaluator({ evaluatorId: id, bondUnits: floor });
  return { reg, floor };
}

const throwsCode = async (fn, code) => {
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof EvaluatorBondError, `expected EvaluatorBondError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
};

test("registration validates input and rejects duplicates", async (t) => {
  // Regression: ghost evaluators (empty id) or zero-bond seats judging rounds.
  const reg = registry();
  await throwsCode(async () => reg.registerEvaluator({ evaluatorId: "", bondUnits: 100 }), "invalid_evaluator");
  await throwsCode(async () => reg.registerEvaluator({ evaluatorId: "a", bondUnits: 0 }), "invalid_bond");
  await throwsCode(async () => reg.registerEvaluator({ evaluatorId: "a", bondUnits: -5 }), "invalid_bond");
  reg.registerEvaluator({ evaluatorId: "a", bondUnits: 100 });
  await throwsCode(async () => reg.registerEvaluator({ evaluatorId: "a", bondUnits: 100 }), "already_registered");
  const got = reg.getEvaluator("a");
  assert.equal(got.posted, 100);
  assert.equal(got.available, 100);
});

test("topUp and withdraw move only available units", async (t) => {
  // Regression: withdrawing locked bond units (double-spend of encumbered capital).
  const reg = registry();
  reg.registerEvaluator({ evaluatorId: "a", bondUnits: 500 });
  reg.topUpBond({ evaluatorId: "a", bondUnits: 100 });
  assert.equal(reg.getEvaluator("a").available, 600);
  // Lock 490 of it on a verdict, then try to withdraw past available.
  const floor = quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 2, completionRewardUnits: 10 });
  reg.registerEvaluator({ evaluatorId: "b", bondUnits: floor });
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  await throwsCode(async () => reg.withdrawBond({ evaluatorId: "a", bondUnits: 600 - floor + 1 }), "insufficient_available");
  reg.withdrawBond({ evaluatorId: "a", bondUnits: 600 - floor });
  assert.equal(reg.getEvaluator("a").available, 0);
});

test("quoteMinimumBond matches the unprofitable-attack floor", (t) => {
  // Regression: floor drift that silently re-opens profitable bribery.
  assert.equal(quorumFor(1), 1);
  assert.equal(quorumFor(2), 2);
  assert.equal(quorumFor(3), 2);
  assert.equal(quorumFor(4), 3);
  assert.equal(quorumFor(7), 5);
  // n=1: bond must cover the whole verdict value (no second evaluator).
  assert.equal(quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 1, completionRewardUnits: 10 }), 990);
  // n=3, q=2: ceil(1000/2) - 10 = 490.
  assert.equal(quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 3, completionRewardUnits: 10 }), 490);
  // More evaluators never raise the per-evaluator floor.
  const f3 = quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 3 });
  const f7 = quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 7 });
  assert.ok(f7 <= f3, `floor should not rise with n: f3=${f3} f7=${f7}`);
  // Floor never drops below the absolute minimum, even with a huge reward.
  assert.equal(quoteMinimumBond({ verdictValueUnits: 100, evaluatorCount: 3, completionRewardUnits: 10000 }), MIN_BOND_FLOOR);
});

test("attackMargin is non-positive exactly at the floor", (t) => {
  // Regression: the economic model claiming safety while the bribe math says profit.
  for (const n of [1, 2, 3, 4, 5, 7]) {
    const floor = quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: n, completionRewardUnits: 10 });
    const margin = attackMargin({ verdictValueUnits: 1000, evaluatorCount: n, bondUnits: floor, completionRewardUnits: 10 });
    assert.ok(margin <= 0, `n=${n}: attack profitable at floor (margin=${margin})`);
    const cheap = attackMargin({ verdictValueUnits: 1000, evaluatorCount: n, bondUnits: Math.max(1, floor - 50), completionRewardUnits: 10 });
    assert.ok(cheap > 0, `n=${n}: under-floor bond should admit profit (margin=${cheap})`);
  }
});

test("assignVerdict enforces the floor and never double-locks", async (t) => {
  // Regression: seating a round below the economic floor, or one bond backing two verdicts.
  const { reg, floor } = fundedRound();
  reg.registerEvaluator({ evaluatorId: "poor", bondUnits: floor - 1 });
  await throwsCode(
    async () => reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "poor"], verdictValueUnits: 1000, completionRewardUnits: 10 }),
    "insufficient_bond"
  );
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  assert.equal(reg.getEvaluator("a").available, 0);
  await throwsCode(
    async () => reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 }),
    "already_assigned"
  );
  // Same bond cannot back a second concurrent verdict.
  await throwsCode(
    async () => reg.assignVerdict({ verdictId: "v2", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 100, completionRewardUnits: 10 }),
    "insufficient_bond"
  );
});

test("honest commit-reveal-tally round releases every bond", (t) => {
  // Regression: honest evaluators losing bond to a correct round (the liveness tax).
  const { reg, floor } = fundedRound();
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  for (const id of ["a", "b", "c"]) reg.commitVerdict({ verdictId: "v1", evaluatorId: id, commitHash: commitFor("approve", `salt-${id}`) });
  for (const id of ["a", "b", "c"]) reg.revealVerdict({ verdictId: "v1", evaluatorId: id, verdict: "approve", salt: `salt-${id}` });
  const tally = reg.tallyRound({ verdictId: "v1" });
  assert.equal(tally.outcome, "unanimous");
  assert.equal(tally.majorityVerdict, "approve");
  for (const id of ["a", "b", "c"]) reg.releaseVerdict({ verdictId: "v1", evaluatorId: id });
  for (const id of ["a", "b", "c"]) assert.equal(reg.getEvaluator(id).available, floor);
  const kinds = reg.journal().map((e) => e.kind);
  for (const k of ["verdict.assigned", "bond.locked", "verdict.committed", "verdict.revealed", "round.tallied", "bond.released"])
    assert.ok(kinds.includes(k), `journal missing ${k}`);
});

test("reveal with wrong salt or wrong verdict slashes the full lock", async (t) => {
  // Regression: equivocation going unpunished (the commit-reveal proof ignored).
  const { reg, floor } = fundedRound();
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "a", commitHash: commitFor("approve", "salt-a") });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "b", commitHash: commitFor("approve", "salt-b") });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "c", commitHash: commitFor("approve", "salt-c") });
  // a reveals a different verdict than committed; b reveals with the wrong salt.
  const s1 = reg.revealVerdict({ verdictId: "v1", evaluatorId: "a", verdict: "reject", salt: "salt-a" });
  assert.equal(s1.slashed, true);
  assert.equal(s1.reason, "commitment_breach");
  assert.equal(s1.slashedUnits, floor);
  const s2 = reg.revealVerdict({ verdictId: "v1", evaluatorId: "b", verdict: "approve", salt: "wrong-salt" });
  assert.equal(s2.slashed, true);
  assert.equal(reg.poolBalance(), 2 * floor);
  assert.equal(reg.getEvaluator("a").available, 0);
  // Slashed locks cannot be "released" afterwards.
  await throwsCode(async () => reg.releaseVerdict({ verdictId: "v1", evaluatorId: "a" }), "nothing_to_release");
});

test("commit without reveal is slashed as a liveness fault at tally", (t) => {
  // Regression: commit-then-stall griefing blocking the round for free.
  const { reg, floor } = fundedRound();
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  for (const id of ["a", "b", "c"]) reg.commitVerdict({ verdictId: "v1", evaluatorId: id, commitHash: commitFor("approve", `s-${id}`) });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "a", verdict: "approve", salt: "s-a" });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "b", verdict: "approve", salt: "s-b" });
  const tally = reg.tallyRound({ verdictId: "v1" });
  const slashed = tally.slashed.map((s) => s.evaluatorId);
  assert.deepEqual(slashed, ["c"]);
  assert.equal(tally.slashed[0].reason, "no_reveal");
  assert.equal(reg.poolBalance(), floor);
});

test("bonded majority contradiction slashes the dissenter; contested rounds slash nobody", (t) => {
  // Regression: (a) a lone dissenter against a bonded majority escaping slash;
  // (b) honest below-quorum disagreement being punished as fault.
  const { reg } = fundedRound();
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  const commits = { a: commitFor("approve", "sa"), b: commitFor("approve", "sb"), c: commitFor("reject", "sc") };
  for (const id of ["a", "b", "c"]) reg.commitVerdict({ verdictId: "v1", evaluatorId: id, commitHash: commits[id] });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "a", verdict: "approve", salt: "sa" });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "b", verdict: "approve", salt: "sb" });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "c", verdict: "reject", salt: "sc" });
  const tally = reg.tallyRound({ verdictId: "v1" });
  assert.equal(tally.outcome, "majority");
  assert.deepEqual(tally.slashed.map((s) => s.evaluatorId), ["c"]);
  assert.equal(tally.slashed[0].reason, "majority_contradiction");
  reg.releaseVerdict({ verdictId: "v1", evaluatorId: "a" });
  reg.releaseVerdict({ verdictId: "v1", evaluatorId: "b" });

  // Contested: 2v2 with quorum 3 -> no slash, honest disagreement.
  const reg2 = registry();
  const ids = ["w", "x", "y", "z"];
  const floor2 = quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 4, completionRewardUnits: 10 });
  for (const id of ids) reg2.registerEvaluator({ evaluatorId: id, bondUnits: floor2 });
  reg2.assignVerdict({ verdictId: "v9", evaluatorIds: ids, verdictValueUnits: 1000, completionRewardUnits: 10 });
  const votes = { w: "approve", x: "approve", y: "reject", z: "reject" };
  for (const id of ids) reg2.commitVerdict({ verdictId: "v9", evaluatorId: id, commitHash: commitFor(votes[id], `s-${id}`) });
  for (const id of ids) reg2.revealVerdict({ verdictId: "v9", evaluatorId: id, verdict: votes[id], salt: `s-${id}` });
  const tally2 = reg2.tallyRound({ verdictId: "v9" });
  assert.equal(tally2.outcome, "contested");
  assert.deepEqual(tally2.slashed, []);
  for (const id of ids) reg2.releaseVerdict({ verdictId: "v9", evaluatorId: id });
});

test("single-evaluator rounds cannot slash via majority; honest reveal releases", (t) => {
  // Regression: majority machinery misfiring on n=1 (documented weakness: bond size is the only security).
  const reg = registry();
  const floor = quoteMinimumBond({ verdictValueUnits: 1000, evaluatorCount: 1, completionRewardUnits: 10 });
  reg.registerEvaluator({ evaluatorId: "solo", bondUnits: floor });
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["solo"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "solo", commitHash: commitFor("approve", "s") });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "solo", verdict: "approve", salt: "s" });
  const tally = reg.tallyRound({ verdictId: "v1" });
  assert.equal(tally.outcome, "single");
  assert.deepEqual(tally.slashed, []);
  reg.releaseVerdict({ verdictId: "v1", evaluatorId: "solo" });
  assert.equal(reg.getEvaluator("solo").available, floor);
});

test("appeal upheld reverses the slash and returns the appeal bond", async (t) => {
  // Regression: a successful appeal leaving the bond slashed (appeal theater).
  const { reg, floor } = fundedRound();
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "a", commitHash: commitFor("approve", "s-a") });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "b", commitHash: commitFor("approve", "s-b") });
  reg.commitVerdict({ verdictId: "v1", evaluatorId: "c", commitHash: commitFor("reject", "s-c") });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "a", verdict: "approve", salt: "s-a" });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "b", verdict: "approve", salt: "s-b" });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "c", verdict: "reject", salt: "s-c" });
  const tally = reg.tallyRound({ verdictId: "v1" });
  assert.equal(tally.slashed[0].reason, "majority_contradiction");
  const slashId = tally.slashed[0].slashId;
  // Appeal bond below 25% of the slash is refused.
  await throwsCode(
    async () => reg.appealSlash({ slashId, appellantId: "c", appealBondUnits: Math.floor(floor * APPEAL_BOND_RATIO) - 1 }),
    "insufficient_appeal_bond"
  );
  // A round participant cannot resolve the appeal (exposure rule).
  const appealBond = Math.ceil(floor * APPEAL_BOND_RATIO);
  reg.topUpBond({ evaluatorId: "c", bondUnits: appealBond });
  const appeal = reg.appealSlash({ slashId, appellantId: "c", appealBondUnits: appealBond });
  assert.equal(appeal.slashId, slashId);
  await throwsCode(async () => reg.resolveAppeal({ slashId, uphold: true, resolverId: "a" }), "conflicted_resolver");
  const done = reg.resolveAppeal({ slashId, uphold: true, resolverId: "fresh-judge" });
  assert.equal(done.outcome, "slash_reversed");
  // Slashed bond restored + the topped-up appeal bond returned in full.
  assert.equal(reg.getEvaluator("c").available, floor + appealBond);
  assert.equal(reg.poolBalance(), 0);
  // Terminal: no second appeal.
  await throwsCode(async () => reg.appealSlash({ slashId, appellantId: "c", appealBondUnits: appealBond }), "appeal_closed");
});

test("appeal denied forfeits the appeal bond to the pool and ends the dispute", (t) => {
  // Regression: a denied appeal quietly returning the appeal bond (loser-pays violated).
  const { reg, floor } = fundedRound();
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  for (const id of ["a", "b", "c"]) reg.commitVerdict({ verdictId: "v1", evaluatorId: id, commitHash: commitFor("reject", `s-${id}`) });
  const rev = reg.revealVerdict({ verdictId: "v1", evaluatorId: "a", verdict: "approve", salt: "s-a" }); // commitment breach
  assert.equal(rev.slashed, true);
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "b", verdict: "reject", salt: "s-b" });
  reg.revealVerdict({ verdictId: "v1", evaluatorId: "c", verdict: "reject", salt: "s-c" });
  reg.tallyRound({ verdictId: "v1" });
  // a's slash fired at reveal time (commitment breach) — appeal that record.
  const slashId = rev.slashId;
  const appealBond = Math.ceil(floor * APPEAL_BOND_RATIO);
  // 'a' needs fresh capital for the appeal bond: top up first.
  reg.topUpBond({ evaluatorId: "a", bondUnits: appealBond });
  reg.appealSlash({ slashId, appellantId: "a", appealBondUnits: appealBond });
  const done = reg.resolveAppeal({ slashId, uphold: false, resolverId: "fresh-judge" });
  assert.equal(done.outcome, "slash_upheld");
  // Pool holds the original slash plus the forfeited appeal bond.
  assert.equal(reg.poolBalance(), floor + appealBond);
  assert.equal(reg.getEvaluator("a").available, 0);
});

test("journal is append-only and records every state transition", (t) => {
  // Regression: silent bond movement with no audit trail.
  const { reg } = fundedRound();
  const before = reg.journal().length;
  reg.assignVerdict({ verdictId: "v1", evaluatorIds: ["a", "b", "c"], verdictValueUnits: 1000, completionRewardUnits: 10 });
  const after = reg.journal().length;
  assert.ok(after > before);
  const seqs = reg.journal().map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.ok(reg.journal().every((e) => typeof e.at === "number" && typeof e.kind === "string"));
});
