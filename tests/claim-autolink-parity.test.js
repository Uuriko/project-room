// B2-2 F1/F2 parity: the system auto-link path must reach the same
// approval-invalidation and lease-liveness semantics as the owner path
// (appendWorkPullRequest, server/work-claims.mjs).
//
// F1 (#3685): linking a new PR opens a new round — the owner path clears
// the CI settlement and the attestations, so canCloseWork falls until a
// fresh review settles against the new PR. Auto-link used to leave both
// standing, leaving the claim closable on the previous PR's evidence.
// F2: the owner path refuses a lease-lapsed claim with
// claim_lease_lapsed; auto-link's liveness check had no lease term and
// linked anyway.
//
// The pre-states are built with the real work-claims functions (the audit
// harness shape, B2-2-autolink.mjs) and auto-link runs against a minimal
// store double, the boundary the audit executed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, appendWorkPullRequest,
  recordReview, recordCi, canCloseWork,
} from "../server/work-claims.mjs";
import { autoLinkPullRequest, findClaimForPull } from "../server/claim-autolink.mjs";

const NOW = Date.parse("2026-10-03T13:00:00Z");
const URL1 = "https://github.com/acme/repo/pull/1";
const URL2 = "https://github.com/acme/repo/pull/2";

function settledItem({ expired = false } = {}) {
  let w = createWork({ id: "w1", repo: "acme/repo", reviewPolicy: "distinct_member",
    pullRequest: { url: URL1, outcome: "merged", syncedAt: new Date(NOW - 5000).toISOString() } },
    { now: NOW - 10000, agentId: "creator" });
  w = claimWork(w, "ada", { now: NOW - 9000, leaseHours: expired ? 0.001 : 6 });
  w = recordCi(w, { state: "success", headSha: "a".repeat(40) }, NOW - 8000).item;
  w = updateWork(w, "ada", { state: "in_progress", now: NOW - 7000 });
  w = recordReview(w, "rev", { verdict: "approve", summary: "ok", now: NOW - 6000 });
  return w;
}

function fakeStore(item) {
  const map = new Map([["r1:w1", structuredClone(item)]]);
  return { workClaims: {
    get: (room, id) => map.get(room + ":" + id) ?? null,
    set: (room, it) => map.set(room + ":" + it.id, it),
    list: () => [...map.values()],
    transaction: fn => fn(),
  }, _map: map, db: null, now: () => NOW };
}

const canClose = item => canCloseWork(item, "rev", { reviewMembers: ["rev"] });

test("F1: auto-link clears CI and attestations like the owner path, so canCloseWork falls", () => {
  const before = settledItem();
  assert.equal(canClose(before), true, "precondition: closable on the settled PR's evidence");

  const owner = appendWorkPullRequest(structuredClone(before), "ada", {
    pullRequest: URL2, expectedClaimedAt: before.claimedAt,
    expectedHistoryLength: before.history.length, now: NOW,
  });
  assert.equal(owner.ci, null);
  assert.equal(owner.attestations.length, 0);
  assert.equal(canClose(owner), false);

  const store = fakeStore(before);
  const out = autoLinkPullRequest(store, "r1", "w1", { url: URL2, source: "branch" }, { nowMs: NOW });
  assert.equal(out.linked, true);
  const auto = store._map.get("r1:w1");
  assert.equal(auto.pullRequest.url, URL2);
  assert.equal(auto.ci, null, "auto-link must invalidate the prior CI settlement (#3685)");
  assert.deepEqual(auto.attestations, [], "auto-link must invalidate prior attestations (#3685)");
  assert.equal(canClose(auto), false, "the claim must not stay closable on the old PR's review");
  // Parity on the invalidation set: the reviews themselves stay as the
  // record, exactly as on the owner path; their basis stales via ci=null.
  assert.equal(auto.reviews.length, owner.reviews.length);
});

test("F2: auto-link refuses a lease-lapsed claim with claim_lease_lapsed and writes nothing", () => {
  const before = settledItem({ expired: true });
  assert.throws(
    () => appendWorkPullRequest(structuredClone(before), "ada", {
      pullRequest: URL2, expectedClaimedAt: before.claimedAt,
      expectedHistoryLength: before.history.length, now: NOW,
    }),
    error => error.code === "claim_lease_lapsed",
    "precondition: the owner path refuses this pre-state",
  );
  const store = fakeStore(before);
  const out = autoLinkPullRequest(store, "r1", "w1", { url: URL2, source: "branch" }, { nowMs: NOW });
  assert.equal(out.linked, false);
  assert.equal(out.reason, "claim_lease_lapsed");
  assert.deepEqual(store._map.get("r1:w1"), before, "a refused auto-link must not mutate the claim");
});

test("F2: findClaimForPull does not match a lease-lapsed claim at the given time", () => {
  const base = { state: "in_progress", owner: "ada", repo: "acme/repo", roomId: "r1" };
  const claims = [
    { ...base, id: "lane-lapsed", leaseExpiresAt: new Date(NOW - 1000).toISOString() },
    { ...base, id: "lane-live", leaseExpiresAt: new Date(NOW + 3600_000).toISOString() },
  ];
  const hitLapsed = findClaimForPull({ branch: "lane-lapsed", title: "", body: "", repo: "acme/repo" }, claims, { nowMs: NOW });
  assert.equal(hitLapsed, null);
  const hitLive = findClaimForPull({ branch: "lane-live", title: "", body: "", repo: "acme/repo" }, claims, { nowMs: NOW });
  assert.equal(hitLive.claim.id, "lane-live");
});
