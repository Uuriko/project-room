// bounty-sybil-guard.mjs — MONEY-ADJACENT. Bounty sybil /
// verifier-capture cure (DISCOVERY-50 lane I3, charter
// I3-sybil-verifier-cure). Lands singly.
//
// Two mechanisms at settle, per charter §3:
//  1. verifier != bidder, enforced at settle: a verifier may not score
//     a lot they bid on. Refused with the named error
//     VerifierIsBidderError (code "verifier_is_bidder") before any
//     payment moves — not a UI hint, not a disclosure.
//  2. Dedupe-by-similarity at settle (the charter's pick-one: this
//     build picks DEDUPE over a per-identity bond — reason: it needs
//     no new custody/bond handling in the ledger, and the lane
//     simulation's sybil profit came from near-duplicate submissions
//     being scored as independent identities; merging them before
//     scoring removes the profit at the source). Near-duplicate
//     submissions (token Jaccard >= DEDUPE_THRESHOLD) merge into one
//     identity group before scoring, so a split-identity sybil earns
//     one share total, not one per identity.
//
// The settlement receipt names the verifier and every bidder, with
// verifierNotBidder machine-checkable from the receipt. Shares are
// integer millis and sum EXACTLY to the pool (conservation). Scoring
// itself, pool sizing, the split-pool rule, and the 1% fee are
// untouched.

export const DEDUPE_THRESHOLD = 0.85;

export class VerifierIsBidderError extends Error {
  constructor(verifierId) {
    super(`verifier_is_bidder: verifier ${verifierId} bid on this lot and may not score/settle it`);
    this.name = "VerifierIsBidderError";
    this.code = "verifier_is_bidder";
  }
}

function tokens(text) {
  return new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}
function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// Group submissions whose texts are near-duplicates. Returns groups:
// [{ groupId, submissionIds, identityIds, representative }]
export function dedupeBySimilarity(submissions, threshold = DEDUPE_THRESHOLD) {
  const groups = [];
  const tokenSets = submissions.map((s) => tokens(s.text));
  submissions.forEach((sub, i) => {
    const hit = groups.find((g) => jaccard(tokenSets[i], g.tokenSet) >= threshold);
    if (hit) {
      hit.submissionIds.push(sub.submissionId);
      hit.identityIds.push(sub.identityId);
    } else {
      groups.push({ groupId: `group-${groups.length}`, submissionIds: [sub.submissionId], identityIds: [sub.identityId], tokenSet: tokenSets[i], representative: sub.submissionId });
    }
  });
  return groups.map(({ tokenSet, ...rest }) => rest);
}

export function settleSplitPool({ poolMillis, submissions, verifierId, scores, bondMillisPerIdentity = 0 }) {
  if (!Number.isInteger(poolMillis) || poolMillis < 0) throw new TypeError("poolMillis must be a non-negative integer");
  if (!Number.isInteger(bondMillisPerIdentity) || bondMillisPerIdentity < 0) throw new TypeError("bondMillisPerIdentity must be a non-negative integer");
  const bidderIds = [...new Set(submissions.map((s) => s.identityId))];
  if (bidderIds.includes(verifierId)) throw new VerifierIsBidderError(verifierId);

  const groups = dedupeBySimilarity(submissions);
  // Per-identity submission bond (the lane's benchmark: 5% of expected
  // share, priced in the PR body): every identity posts it; a UNIQUE
  // identity's bond is returned at settle; the bonds of duplicate
  // identities merged by dedupe are FORFEITED into the pool. This is
  // what makes a split-identity sybil strictly loss-making in the
  // lane simulation re-run filed with this change: dedupe alone caps
  // the sybil at one small share (welfare ~ +0.5 in sim units); the
  // forfeited duplicate bonds take it negative.
  let bondForfeitedMillis = 0;
  for (const g of groups) {
    const distinctIdentities = new Set(g.identityIds).size;
    if (distinctIdentities > 1) bondForfeitedMillis += (distinctIdentities - 1) * bondMillisPerIdentity;
  }
  poolMillis += bondForfeitedMillis;
  // One score per merged group: the representative's score. A sybil's
  // near-dupes cannot multiply score by splitting identities.
  const groupScore = new Map(groups.map((g) => [g.groupId, Number(scores[g.representative] ?? 0)]));
  const totalScore = [...groupScore.values()].reduce((a, b) => a + b, 0);
  if (!(totalScore > 0)) throw new TypeError("settleSplitPool: total score must be positive");

  const entries = [];
  let assigned = 0;
  groups.forEach((g, gi) => {
    const isLast = gi === groups.length - 1;
    const amount = isLast ? poolMillis - assigned : Math.floor((poolMillis * groupScore.get(g.groupId)) / totalScore);
    assigned += amount;
    // The merged group's share is paid to its representative identity;
    // the receipt lists every identity in the group.
    entries.push({ groupId: g.groupId, identityId: g.identityIds[0], memberIdentityIds: g.identityIds, submissionIds: g.submissionIds, amountMillis: amount });
  });

  return {
    entries,
    receipt: {
      kind: "split-pool-settlement",
      verifierId,
      bidderIds,
      verifierNotBidder: !bidderIds.includes(verifierId),
      dedupedGroups: groups.length,
      submissions: submissions.length,
      bondMillisPerIdentity,
      bondForfeitedMillis,
      poolMillis,
      totalPaidMillis: entries.reduce((a, e) => a + e.amountMillis, 0),
    },
  };
}
