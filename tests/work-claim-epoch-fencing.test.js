// Crash-recovery guild, W8 (epoch fencing): a monotonic epoch on every claim
// fences out resurrected holders. Every ownership transition (claim,
// reassign, succession, release, auto-release of an expired lease) bumps the
// epoch; updateWork must be given the epoch the caller based its decision on
// (expectedEpoch); a stale epoch is rejected with stale_epoch rather than
// applied — so a restarted former holder cannot clobber a successor's work.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, reassignWork, releaseExpired, renewWork,
  electClaimSuccessor, ClaimError } from "../server/work-claims.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const T0 = Date.parse("2026-10-07T20:00:00.000Z");
const H = 3600 * 1000;

// The crash scenario: holder-a claims (epoch 1), hands to holder-b
// (epoch 2), takes the claim back (epoch 3), then its process dies.
// Succession elects holder-b (epoch 4).
const crashedScenario = () => {
  let item = createWork({ id: "e1" }, { now: T0, agentId: "system" });
  item = claimWork(item, "holder-a", { now: T0 });
  item = reassignWork(item, "holder-a", "holder-b", { now: T0 });
  item = reassignWork(item, "holder-b", "holder-a", { now: T0 });
  assert.equal(item.epoch, 3);
  assert.equal(item.owner, "holder-a");
  item = electClaimSuccessor(item, "holder-b", { now: T0 + H });
  assert.equal(item.epoch, 4);
  assert.equal(item.owner, "holder-b");
  return item;
};

test("epoch fencing (a): resurrected holder presenting a stale epoch is rejected with stale_epoch", () => {
  const item = crashedScenario();
  // holder-a restarts, still believes it owns the claim, and issues an
  // update based on the epoch-2 world it last saw.
  throwsCode(() => updateWork(item, "holder-a",
    { state: "in_progress", expectedEpoch: 2, now: T0 + 2 * H }), "stale_epoch");
  // The rejection is checked before the owner check: the accurate error for
  // a resurrected holder is stale_epoch, not work_not_owner.
  throwsCode(() => updateWork(item, "holder-a",
    { state: "in_progress", expectedEpoch: 3, now: T0 + 2 * H }), "stale_epoch");
});

test("epoch fencing (a2): a stale holder cannot release the successor's claim", () => {
  const item = crashedScenario();
  // Release is the most destructive clobber: it wipes the successor's round.
  throwsCode(() => updateWork(item, "holder-a",
    { state: "unclaimed", expectedEpoch: 2, now: T0 + 2 * H }), "stale_epoch");
  assert.equal(item.owner, "holder-b");
  assert.equal(item.epoch, 4);
});

test("epoch fencing (b): the successor presenting the current epoch is accepted", () => {
  const item = crashedScenario();
  const updated = updateWork(item, "holder-b",
    { state: "in_progress", expectedEpoch: 4, now: T0 + 2 * H });
  assert.equal(updated.state, "in_progress");
  assert.equal(updated.owner, "holder-b");
  assert.equal(updated.epoch, 4); // same-owner state change: no bump
});

test("epoch fencing: presenting the current epoch does not bypass the owner check", () => {
  const item = claimWork(createWork({ id: "e-owner" }, { now: T0, agentId: "system" }), "a", { now: T0 });
  // The epoch check passes (1 === 1); the owner check still refuses.
  // (updateWork's owner refusal is invalid_claim_input; work_not_owner is
  // appendWorkPullRequest's code — fencing changes neither.)
  throwsCode(() => updateWork(item, "b", { expectedEpoch: 1, now: T0 }), "invalid_claim_input");
});

test("epoch fencing (c): epoch bumps on every ownership transition and nothing else", () => {
  let item = createWork({ id: "e3" }, { now: T0, agentId: "system" });
  assert.equal(item.epoch, 0); // create: no owner yet, no bump
  item = claimWork(item, "a", { now: T0 }); // nobody -> a
  assert.equal(item.epoch, 1);
  item = updateWork(item, "a", { state: "in_progress", now: T0 }); // same owner
  assert.equal(item.epoch, 1);
  item = updateWork(item, "a", { note: "still working", now: T0 }); // note-only
  assert.equal(item.epoch, 1);
  item = renewWork(item, "a", { now: T0 }); // lease renew, same owner
  assert.equal(item.epoch, 1);
  item = reassignWork(item, "a", "b", { now: T0 }); // a -> b
  assert.equal(item.epoch, 2);
  item = electClaimSuccessor(item, "c", { now: T0 + H }); // b -> c (succession)
  assert.equal(item.epoch, 3);
  assert.equal(item.owner, "c");
  item = updateWork(item, "c", { state: "unclaimed", now: T0 + H }); // c -> nobody (release)
  assert.equal(item.epoch, 4);
  assert.equal(item.owner, null);
  item = claimWork(item, "d", { now: T0 + H }); // nobody -> d (reclaim)
  assert.equal(item.epoch, 5);
  assert.equal(item.owner, "d");
});

test("epoch fencing (c2): auto-release of an expired lease bumps the epoch", () => {
  const claimed = claimWork(createWork({ id: "e4" }, { now: T0, agentId: "system" }),
    "a", { leaseHours: 6, now: T0 });
  assert.equal(claimed.epoch, 1);
  const [released] = releaseExpired([claimed], T0 + 7 * H);
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
  assert.equal(released.epoch, 2);
  // Whoever claims next starts from the bumped epoch: a holder woken from
  // before the expiry cannot present its old epoch.
  const reclaimed = claimWork(released, "b", { now: T0 + 7 * H });
  assert.equal(reclaimed.epoch, 3);
  throwsCode(() => updateWork(reclaimed, "a", { expectedEpoch: 1, now: T0 + 8 * H }), "stale_epoch");
});

test("epoch fencing: malformed expectedEpoch is refused as invalid input", () => {
  const item = claimWork(createWork({ id: "e6" }, { now: T0, agentId: "system" }), "a", { now: T0 });
  throwsCode(() => updateWork(item, "a", { expectedEpoch: -1, now: T0 }), "invalid_claim_input");
  throwsCode(() => updateWork(item, "a", { expectedEpoch: 1.5, now: T0 }), "invalid_claim_input");
  throwsCode(() => updateWork(item, "a", { expectedEpoch: "1", now: T0 }), "invalid_claim_input");
  throwsCode(() => updateWork(item, "a", { expectedEpoch: NaN, now: T0 }), "invalid_claim_input");
});

test("epoch fencing: backward compatible — pre-existing claims hydrate to epoch 0, expectedEpoch optional", () => {
  // A stored claim from before epoch fencing carries no epoch field.
  const legacy = { id: "legacy", state: "claimed", owner: "a", history: [],
    claimedAt: new Date(T0).toISOString(), leaseStartAt: null, leaseExpiresAt: null };
  const updated = updateWork(legacy, "a", { state: "in_progress", now: T0 });
  assert.equal(updated.epoch, 0);
  assert.equal(updated.state, "in_progress");
  // Old call style (no expectedEpoch) keeps working everywhere.
  const legacyFree = { id: "legacy-free", state: "unclaimed", owner: null, history: [] };
  const claimed = claimWork(legacyFree, "a", { now: T0 });
  assert.equal(claimed.epoch, 1);
  const noted = updateWork(claimed, "a", { note: "no epoch presented", now: T0 });
  assert.equal(noted.epoch, 1);
});

test("epoch fencing: succession starts the new holder on a clean round", () => {
  let item = claimWork(createWork({ id: "e9" }, { now: T0, agentId: "system" }), "a", { now: T0 });
  item = updateWork(item, "a", { state: "in_progress", now: T0 });
  const elected = electClaimSuccessor(item, "b", { now: T0 + H });
  assert.equal(elected.owner, "b");
  assert.equal(elected.state, "claimed");
  assert.equal(elected.epoch, 2);
  assert.ok(elected.claimedAt !== null && Date.parse(elected.claimedAt) === T0 + H);
  assert.deepEqual([...elected.attestations], []);
  assert.deepEqual([...elected.reviews], []);
  assert.ok((elected.history[elected.history.length - 1]?.action ?? "").startsWith("succession:"));
  // Nonsense successions are refused: unclaimed items are claimed, not
  // successed; done items are immutable.
  const free = createWork({ id: "e9-free" }, { now: T0, agentId: "system" });
  throwsCode(() => electClaimSuccessor(free, "c", { now: T0 + H }), "invalid_claim_input");
  const done = updateWork(updateWork(elected, "b", { state: "in_progress", now: T0 + H }),
    "b", { state: "done", now: T0 + H });
  throwsCode(() => electClaimSuccessor(done, "c", { now: T0 + H }), "invalid_claim_input");
});
