// FIX-17 (WAVE-300 ranked-fixes burn-down): deterministic successor election.
//
// Wherever leadership of a claim is decided, the transfer is a CAS on a
// server-side succession epoch: a ballot wins only when its expectedEpoch
// still matches the current epoch at commit time. First committer wins;
// every loser gets a deterministic work_claim_conflict — exactly one leader
// at every instant, never a split-brain. A null lead is WAIT
// (no_leader_wait): nobody can grab leadership without winning the CAS,
// so there is no bully and no grab.
//
// What FIX-12's /succeed lacks (and what this file pins): the epoch itself.
// /succeed checks eligibility (stale heartbeat) and transfers in one
// transaction, but two ballots that both read "holder stale" before either
// commits have no CAS base to discriminate them. The election rule here is
// the extracted primitive /succeed should call: it compares-and-swaps on
// successionEpoch, a counter the server bumps on every leadership change.
//
// Guardrails under test:
// - acceptance: two racing successors → exactly one wins;
// - acceptance: null lead → both wait (no grab);
// - acceptance: stale-epoch submission → rejected;
// - adversarial: 5 racing successors → exactly one wins;
// - adversarial: partitioned claimant (holder reasserts mid-race) → stale ballot dies;
// - adversarial: returning holder's writes are fenced after succession;
// - adversarial: duplicate ballot replay → second submission rejected;
// - adversarial: full leadership churn keeps every stale ballot dead.
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimWork, updateWork, reassignWork, renewWork, releaseExpired, electSuccessor, ClaimError,
} from "../server/work-claims.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);

// A live, held claim: holder "holder", in_progress, succession epoch 0.
const held = (id = "w1") => updateWork(claimWork({ id }, "holder"), "holder", { state: "in_progress" });

test("two racing successors → exactly one wins", () => {
  const item = held();
  assert.equal(item.successionEpoch, 0);
  // Both ballots are read against the same pre-commit state (epoch 0):
  // that is the race — whoever commits first wins.
  const first = electSuccessor(item, "peer-a", { expectedEpoch: 0 });
  assert.equal(first.owner, "peer-a");
  assert.equal(first.successionEpoch, 1);
  // The loser's ballot, committed second, sees the bumped epoch and dies.
  throwsCode(() => electSuccessor(first, "peer-b", { expectedEpoch: 0 }), "work_claim_conflict");
  assert.equal(first.owner, "peer-a");
  // The loser re-reads (epoch 1) and ballots again: the next round is fair.
  const second = electSuccessor(first, "peer-b", { expectedEpoch: 1 });
  assert.equal(second.owner, "peer-b");
  assert.equal(second.successionEpoch, 2);
});

test("null lead → both wait, nobody grabs", () => {
  const released = updateWork(claimWork({ id: "w2" }, "holder"), "holder", { state: "unclaimed" });
  assert.equal(released.owner, null);
  throwsCode(() => electSuccessor(released, "peer-a", { expectedEpoch: released.successionEpoch }), "no_leader_wait");
  throwsCode(() => electSuccessor(released, "peer-b", { expectedEpoch: released.successionEpoch }), "no_leader_wait");
  assert.equal(released.owner, null);
  // The only way forward from a null lead is a fresh claim round, not an election.
  const fresh = claimWork(released, "peer-a");
  assert.equal(fresh.owner, "peer-a");
  assert.equal(fresh.successionEpoch, 0);
});

test("stale-epoch submission → rejected", () => {
  const item = held();
  const first = electSuccessor(item, "peer-a", { expectedEpoch: 0 });
  throwsCode(() => electSuccessor(first, "peer-c", { expectedEpoch: 0 }), "work_claim_conflict");
  throwsCode(() => electSuccessor(first, "peer-c", {}), "invalid_claim_input");
  throwsCode(() => electSuccessor(first, "peer-c", { expectedEpoch: -1 }), "invalid_claim_input");
  // The current leader cannot elect itself.
  throwsCode(() => electSuccessor(first, "peer-a", { expectedEpoch: 1 }), "invalid_claim_input");
  // A lapsed/closed claim has no election either.
  throwsCode(() => electSuccessor(updateWork(first, "peer-a", { state: "done" }), "peer-c", { expectedEpoch: 1 }), "invalid_claim_input");
});

// --- adversarial trials (PHOENIX evidence: 5/5) ---

test("adversarial: five racing successors → exactly one wins", () => {
  const orderings = [
    ["p1", "p2", "p3", "p4", "p5"],
    ["p5", "p4", "p3", "p2", "p1"],
    ["p3", "p1", "p4", "p2", "p5"],
  ];
  for (const order of orderings) {
    const item = held(`w5-${order[0]}`);
    const [winner, ...losers] = order;
    const committed = electSuccessor(item, winner, { expectedEpoch: 0 });
    assert.equal(committed.owner, winner);
    assert.equal(committed.successionEpoch, 1);
    for (const loser of losers) {
      throwsCode(() => electSuccessor(committed, loser, { expectedEpoch: 0 }), "work_claim_conflict");
    }
    assert.equal(committed.owner, winner, "no split-brain: the first committer is the only leader");
  }
});

test("adversarial: partitioned claimant cannot take over a live holder", () => {
  const item = held("w6");
  // The peer read epoch 0 while the holder looked gone; before the ballot
  // commits, the holder reasserts (reassign/renew bumps the epoch).
  const reasserted = reassignWork(item, "holder", "holder-2", { note: "holder is alive" });
  assert.equal(reasserted.successionEpoch, 1);
  throwsCode(() => electSuccessor(reasserted, "peer-a", { expectedEpoch: 0 }), "work_claim_conflict");
  assert.equal(reasserted.owner, "holder-2");
});

test("adversarial: returning holder is fenced after succession", () => {
  const item = held("w7");
  const succeeded = electSuccessor(item, "peer-a", { expectedEpoch: 0 });
  assert.equal(succeeded.owner, "peer-a");
  // The old holder's later writes are rejected — it is no longer the owner.
  throwsCode(() => updateWork(succeeded, "holder", { state: "blocked" }), "invalid_claim_input");
  throwsCode(() => renewWork(succeeded, "holder"), "invalid_claim_input");
  throwsCode(() => reassignWork(succeeded, "holder", "holder"), "invalid_claim_input");
  // And its stale election ballot (it never was a candidate) dies too.
  throwsCode(() => electSuccessor(succeeded, "holder", { expectedEpoch: 0 }), "work_claim_conflict");
});

test("adversarial: duplicate ballot replay → second submission rejected", () => {
  const item = held("w8");
  const ballot = { expectedEpoch: 0 };
  const first = electSuccessor(item, "peer-a", ballot);
  assert.equal(first.owner, "peer-a");
  throwsCode(() => electSuccessor(first, "peer-a", ballot), "invalid_claim_input"); // self, now the leader
  throwsCode(() => electSuccessor(first, "peer-b", ballot), "work_claim_conflict"); // stale epoch replay
});

test("adversarial: full leadership churn keeps every stale ballot dead", () => {
  let item = claimWork({ id: "w9" }, "a");            // round 1, epoch 0
  assert.equal(item.successionEpoch, 0);
  item = reassignWork(item, "a", "b");                // epoch 1
  assert.equal(item.successionEpoch, 1);
  item = electSuccessor(item, "c", { expectedEpoch: 1 }); // epoch 2
  assert.equal(item.successionEpoch, 2);
  item = updateWork(item, "c", { state: "unclaimed" });   // release: owner null, epoch 3
  assert.equal(item.owner, null);
  assert.equal(item.successionEpoch, 3);
  throwsCode(() => electSuccessor(item, "d", { expectedEpoch: 3 }), "no_leader_wait");
  item = releaseExpired([updateWork(claimWork({ id: "w9b" }, "a"), "a", { state: "in_progress" })], Date.now() + 100 * 3600 * 1000)[0];
  assert.equal(item.owner, null);                     // sweep: owner null, epoch bumped
  assert.equal(item.successionEpoch, 1);
  const round2 = claimWork(item, "d");                // fresh round resets the epoch
  assert.equal(round2.owner, "d");
  assert.equal(round2.successionEpoch, 0);
  // Every stale ballot from the previous round is dead against the new one.
  throwsCode(() => electSuccessor(round2, "e", { expectedEpoch: 1 }), "work_claim_conflict");
  throwsCode(() => electSuccessor(round2, "e", { expectedEpoch: 3 }), "work_claim_conflict");
  const won = electSuccessor(round2, "e", { expectedEpoch: 0 });
  assert.equal(won.owner, "e");
  assert.equal(won.successionEpoch, 1);
});
