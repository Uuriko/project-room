// B006/B007: work claim + update. Pure state-machine tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, updateWork, reassignWork, releaseWork, workOwnedBy, unclaimedWork, ClaimError, STATES } from "../server/work-claims.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);

test("claim → start → finish is the happy path", () => {
  const claimed = claimWork({ id: "a012" }, "quill");
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.owner, "quill");
  const started = updateWork(claimed, "quill", { state: "in_progress" });
  assert.equal(started.state, "in_progress");
  const done = updateWork(started, "quill", { state: "done", note: "shipped" });
  assert.equal(done.state, "done");
  assert.equal(done.history.length, 3);
  assert.ok(Object.isFrozen(done) && Object.isFrozen(done.history));
});
test("double-claim and foreign updates are refused", () => {
  const claimed = claimWork({ id: "a012" }, "quill");
  throwsCode(() => claimWork(claimed, "grok"), "invalid_claim_input");
  throwsCode(() => updateWork(claimed, "grok", { state: "in_progress" }), "invalid_claim_input");
  throwsCode(() => reassignWork(claimed, "grok", "instinct"), "invalid_claim_input");
  const done = updateWork(updateWork(claimed, "quill", { state: "in_progress" }), "quill", { state: "done" });
  throwsCode(() => updateWork(done, "quill", { note: "late" }), "invalid_claim_input");
});
test("illegal transitions are refused; release and reassign work", () => {
  const claimed = claimWork({ id: "b" }, "quill");
  throwsCode(() => updateWork(claimed, "quill", { state: "done" }), "invalid_claim_input");
  const released = updateWork(claimed, "quill", { state: "unclaimed" });
  assert.equal(released.owner, null);
  const reclaimed = claimWork(released, "grok");
  const reassigned = reassignWork(reclaimed, "grok", "instinct");
  assert.equal(reassigned.owner, "instinct");
  assert.equal(reassigned.state, "claimed");
});
test("query helpers filter a list", () => {
  const items = [
    claimWork({ id: "w1" }, "quill"),
    claimWork({ id: "w2" }, "grok"),
    { id: "w3" },
  ];
  assert.deepEqual(workOwnedBy(items, "quill").map(w => w.id), ["w1"]);
  assert.deepEqual(unclaimedWork(items).map(w => w.id), ["w3"]);
  throwsCode(() => claimWork({ id: "x" }, ""), "invalid_claim_input");
  assert.ok(STATES.includes("blocked"));
});

// Authoring gate: pure transition owns same-round CAS and evidence
// invalidation; route tests own persistence/events and transport tests own
// field preservation. No test-only production hook is introduced.
test("append PR keeps prior observations, invalidates approval, and needs a fresh explicit review", async () => {
  const { createWork, appendWorkPullRequest, recordReview, recordCi, canCloseWork } = await import("../server/work-claims.mjs");
  const now = Date.parse("2026-10-03T13:00:00Z");
  let work = claimWork(createWork({ id: "reviewed", reviewPolicy: "distinct_member",
    pullRequest: { url: "https://github.com/acme/repo/pull/1", outcome: "merged", syncedAt: new Date(now).toISOString(), etag: '"old"', nextPollAt: now + 4000 },
    files: [{ path: "src/held.js", block: "owned" }], dependsOn: ["prerequisite"], repo: "acme/repo", branch: "draft", revision: "retained" }, { now }), "quill", { now, leaseHours: 6 });
  work = recordCi(work, { state: "success", headSha: "a".repeat(40) }, now).item;
  work = recordReview(work, "reviewer", { verdict: "approve", summary: "Reviewed original links", now });
  const policy = { reviewMembers: ["reviewer"] };
  assert.equal(canCloseWork(work, "reviewer", policy), true);
  const basis = { expectedClaimedAt: work.claimedAt, expectedHistoryLength: work.history.length, now };
  assert.equal(appendWorkPullRequest(work, "quill", { ...basis, pullRequest: "https://github.com/acme/repo/pull/1/" }), work);
  const added = appendWorkPullRequest(work, "quill", { ...basis, pullRequest: "https://github.com/acme/repo/pull/2/" });
  assert.equal(added.pullRequest.url, "https://github.com/acme/repo/pull/2");
  assert.deepEqual(added.pullRequests[0], work.pullRequests[0]);
  assert.equal(added.ci, null);
  assert.deepEqual(added.attestations, []);
  assert.deepEqual(added.reviews, work.reviews);
  for (const key of ["owner", "state", "claimedAt", "leaseStartAt", "leaseExpiresAt", "files", "fileBlocks", "dependsOn", "repo", "branch", "revision", "deliveryMode"]) assert.deepEqual(added[key], work[key], key);
  assert.equal(canCloseWork(added, "reviewer", policy), false);
  const retry = recordReview(added, "reviewer", { verdict: "approve", summary: "Reviewed original links", now: now + 1 });
  assert.equal(canCloseWork(retry, "reviewer", policy), false);
  const fresh = recordReview(added, "reviewer", { verdict: "approve", summary: "Reviewed the newly linked PR", now: now + 2 });
  assert.equal(canCloseWork(fresh, "reviewer", policy), true);
});

test("append PR refuses stale rounds, unsafe input and stopped ownership without changing work", async () => {
  const { appendWorkPullRequest, createWork, renewWork } = await import("../server/work-claims.mjs");
  const now = Date.parse("2026-10-03T13:00:00Z");
  const work = claimWork(createWork({ id: "held" }, { now }), "quill", { now, leaseHours: 6 });
  const input = { pullRequest: "https://github.com/acme/repo/pull/1", expectedClaimedAt: work.claimedAt, expectedHistoryLength: work.history.length, now };
  const original = JSON.stringify(work);
  for (const pullRequest of [null, { url: input.pullRequest, outcome: "merged" }, "https://other.example/acme/repo/pull/1", "https://user:password@github.com/acme/repo/pull/1", input.pullRequest + "?x=1", input.pullRequest + "#fragment", "https://github.com:8443/acme/repo/pull/1", "https://github.com/acme/repo/pull/0", "x".repeat(301)]) {
    throwsCode(() => appendWorkPullRequest(work, "quill", { ...input, pullRequest }), "invalid_claim_input");
  }
  for (const fields of [{ expectedClaimedAt: null }, { expectedClaimedAt: "bad" }, { expectedHistoryLength: "2" }, { expectedHistoryLength: -1 }, { expectedHistoryLength: 1.5 }]) {
    throwsCode(() => appendWorkPullRequest(work, "quill", { ...input, ...fields }), "invalid_claim_input");
  }
  for (const fields of [{ expectedHistoryLength: 0 }, { expectedClaimedAt: new Date(now - 1).toISOString() }]) {
    throwsCode(() => appendWorkPullRequest(work, "quill", { ...input, ...fields }), "work_claim_conflict");
  }
  throwsCode(() => appendWorkPullRequest(work, "grok", input), "work_not_owner");
  throwsCode(() => appendWorkPullRequest(work, "quill", { ...input, now: now + 6 * 3600000 }), "claim_lease_lapsed");
  for (const changed of [{ ...work, state: "unclaimed", owner: null }, { ...work, state: "done" }, { ...work, supersededBy: "new" }]) {
    throwsCode(() => appendWorkPullRequest(changed, "quill", input), "work_claim_conflict");
  }
  const reclaimed = claimWork(updateWork(work, "quill", { state: "unclaimed", now }), "quill", { now, leaseHours: 6 });
  assert.equal(reclaimed.claimedAt, work.claimedAt);
  throwsCode(() => appendWorkPullRequest(reclaimed, "quill", input), "work_claim_conflict");
  const roundTrip = reassignWork(reassignWork(work, "quill", "grok", { now }), "grok", "quill", { now });
  throwsCode(() => appendWorkPullRequest(roundTrip, "quill", input), "work_claim_conflict");
  throwsCode(() => appendWorkPullRequest(renewWork(work, "quill", { now }), "quill", input), "work_claim_conflict");
  assert.equal(JSON.stringify(work), original);
  for (const state of ["claimed", "in_progress", "blocked"]) {
    const held = { ...work, state, leaseStartAt: null, leaseExpiresAt: null };
    const linked = appendWorkPullRequest(held, "quill", input);
    assert.equal(linked.state, state);
    assert.equal(linked.leaseExpiresAt, null);
  }
  const full = claimWork(createWork({ id: "full", pullRequests: Array.from({ length: 16 }, (_, n) => `https://github.com/acme/repo/pull/${n + 1}`) }, { now }), "quill", { now });
  const fullInput = { ...input, expectedHistoryLength: full.history.length };
  assert.equal(appendWorkPullRequest(full, "quill", fullInput), full);
  throwsCode(() => appendWorkPullRequest(full, "quill", { ...fullInput, pullRequest: "https://github.com/acme/repo/pull/17" }), "invalid_claim_input");
});

// E5/D4 (QA-200 2026-10-08): a release binds the claim round it was read
// from. A stale replay (timed-out retry) or a delayed duplicate landing
// after an intervening release + re-claim must be refused instead of
// silently destroying the fresh claim.
test("release binds the claim round: stale generations are refused", () => {
  const now = Date.parse("2026-10-08T02:00:00Z");
  const fresh1 = claimWork({ id: "e5" }, "quill", { now, leaseHours: 6 });
  const round1 = { expectedClaimedAt: fresh1.claimedAt, expectedHistoryLength: fresh1.history.length };
  // the round the client read releases cleanly
  const released1 = releaseWork(fresh1, "quill", { ...round1, note: "done", now });
  assert.equal(released1.state, "unclaimed");
  assert.equal(released1.owner, null);
  // re-claim: a new generation. A same-ms re-claim keeps the old claimedAt
  // (claimWork stamps now), so history length is the round discriminator.
  const fresh2 = claimWork(released1, "quill", { now, leaseHours: 6 });
  assert.equal(fresh2.state, "claimed");
  assert.equal(fresh2.owner, "quill");
  assert.ok(fresh2.history.length > round1.expectedHistoryLength);
  const before = JSON.stringify(fresh2);
  // E5: replaying the stale release payload is refused; the fresh claim is untouched
  throwsCode(() => releaseWork(fresh2, "quill", { ...round1, note: "done", now }), "work_claim_conflict");
  assert.equal(JSON.stringify(fresh2), before);
  // D4: the same stale payload arriving late, after an intervening
  // release + re-claim by the same owner, is refused the same way
  const released2 = releaseWork(fresh2, "quill",
    { expectedClaimedAt: fresh2.claimedAt, expectedHistoryLength: fresh2.history.length, note: "mid", now });
  const fresh3 = claimWork(released2, "quill", { now, leaseHours: 6 });
  throwsCode(() => releaseWork(fresh3, "quill", { ...round1, note: "late duplicate", now }), "work_claim_conflict");
  assert.equal(fresh3.owner, "quill");
  assert.equal(fresh3.state, "claimed");
  // the fresh round releases cleanly
  const released3 = releaseWork(fresh3, "quill",
    { expectedClaimedAt: fresh3.claimedAt, expectedHistoryLength: fresh3.history.length, note: "done", now });
  assert.equal(released3.state, "unclaimed");
  // malformed round tokens
  for (const fields of [{ expectedClaimedAt: null }, { expectedClaimedAt: "not-a-date" },
      { expectedHistoryLength: -1 }, { expectedHistoryLength: 1.5 }, { expectedHistoryLength: "3" }]) {
    throwsCode(() => releaseWork(fresh3, "quill", { expectedClaimedAt: fresh3.claimedAt,
      expectedHistoryLength: fresh3.history.length, ...fields, now }), "invalid_claim_input");
  }
  // releasing an in_progress claim keeps the pause transition, bound to the read round
  const active = updateWork(claimWork({ id: "e5b" }, "quill", { now, leaseHours: 6 }), "quill", { state: "in_progress", now });
  const done = releaseWork(active, "quill",
    { expectedClaimedAt: active.claimedAt, expectedHistoryLength: active.history.length, note: "wrap", now });
  assert.equal(done.state, "unclaimed");
  const actions = done.history.map(entry => entry.action);
  assert.ok(actions.includes("state:claimed") && actions.at(-1) === "state:unclaimed");
});
