// I3 charter §8 step 2 settle-path tests. MONEY-ADJACENT.
import test from "node:test";
import assert from "node:assert/strict";
import { settleSplitPool, dedupeBySimilarity, VerifierIsBidderError } from "../server/bounty-sybil-guard.mjs";

const subs = (texts) => texts.map((text, i) => ({ identityId: `id-${i}`, submissionId: `sub-${i}`, text, score: 10 }));

test("I3 (a): settle with verifier == bidder is refused with the named error and no payment moves", () => {
  const submissions = subs(["alpha work", "beta work"]);
  assert.throws(
    () => settleSplitPool({ poolMillis: 100000, submissions, verifierId: "id-0", scores: { "sub-0": 10, "sub-1": 10 } }),
    (e) => e instanceof VerifierIsBidderError && e.code === "verifier_is_bidder"
  );
});

test("I3 (b): three near-duplicate submissions from split identities settle as ONE identity's share", () => {
  const submissions = [
    { identityId: "sybil-a", submissionId: "s1", text: "fix the payment receipt flow for rooms", score: 10 },
    { identityId: "sybil-b", submissionId: "s2", text: "fix the payment receipt flow for rooms", score: 10 },
    { identityId: "sybil-c", submissionId: "s3", text: "fix the payment receipt flow for rooms!", score: 10 },
    { identityId: "honest-1", submissionId: "s4", text: "rebuild the search index pipeline entirely differently", score: 10 },
  ];
  const groups = dedupeBySimilarity(submissions);
  assert.equal(groups.length, 2, "near-dupes merged into one group");
  const result = settleSplitPool({ poolMillis: 100000, submissions, verifierId: "verifier-9", scores: Object.fromEntries(submissions.map((s) => [s.submissionId, s.score])) });
  const sybilTotal = result.entries.filter((e) => e.groupId === groups[0].groupId).reduce((a, e) => a + e.amountMillis, 0);
  const honest = result.entries.find((e) => e.identityId === "honest-1");
  assert.equal(sybilTotal, honest.amountMillis, "deduped sybil group earns one share, equal to one honest share");
});

test("I3 (c): settlement receipt names verifier and bidders; verifier not in bidders is machine-checkable", () => {
  const submissions = subs(["one unique piece", "another distinct piece"]);
  const result = settleSplitPool({ poolMillis: 50000, submissions, verifierId: "verifier-1", scores: { "sub-0": 5, "sub-1": 5 } });
  assert.equal(result.receipt.verifierId, "verifier-1");
  assert.deepEqual([...result.receipt.bidderIds].sort(), ["id-0", "id-1"]);
  assert.equal(result.receipt.verifierNotBidder, true);
  assert.ok(!result.receipt.bidderIds.includes(result.receipt.verifierId));
});

test("I3 bond: duplicate identities merged by dedupe forfeit their bonds into the pool; unique identities do not", () => {
  const submissions = [
    { identityId: "sybil-a", submissionId: "s1", text: "fix the payment receipt flow for rooms", score: 10 },
    { identityId: "sybil-b", submissionId: "s2", text: "fix the payment receipt flow for rooms", score: 10 },
    { identityId: "honest-1", submissionId: "s3", text: "rebuild the search index pipeline entirely differently", score: 10 },
  ];
  const result = settleSplitPool({ poolMillis: 100000, submissions, verifierId: "v", scores: { s1: 10, s2: 10, s3: 10 }, bondMillisPerIdentity: 5000 });
  assert.equal(result.receipt.bondForfeitedMillis, 5000, "one duplicate identity merged -> one bond forfeited");
  assert.equal(result.receipt.totalPaidMillis, 105000, "forfeited bond joins the pool; conservation includes it");
  assert.equal(result.entries.reduce((a, e) => a + e.amountMillis, 0), 105000);
});

test("I3 conservation: shares sum exactly to the pool (genesis equality shape)", () => {
  const submissions = subs(["aaa bbb ccc", "ddd eee fff", "ggg hhh iii"]);
  const result = settleSplitPool({ poolMillis: 100001, submissions, verifierId: "v", scores: { "sub-0": 3, "sub-1": 5, "sub-2": 7 } });
  assert.equal(result.entries.reduce((a, e) => a + e.amountMillis, 0), 100001);
});
