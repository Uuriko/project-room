// Computed disputability for a bounty read (DA3-P3, register F-S1a-3).
//
// A pure, dependency-free derivation: given a bounty's poster, its raw
// designated identities (the stored dispute_decider column and the stored
// verifier — NOT the composed read value), and its current claimant, state
// whether a dispute can ever be opened on this bounty and who would decide
// it. Read-model only: this never seats, refuses, or moves anything — the
// dispute path (BountyEscrow.disputeBounty) stays the sole authority, and
// this derivation mirrors its decider resolution:
//
//   designated decider = disputeDecider ?? verifier   (disputeBounty, same
//   composition the disputeDecider read field discloses)
//
// disputeBounty then seats that designee through resolveTier1, which
// refuses a designee who is the executor (the claimant) and — at create
// time — postBounty refuses a designee who is the poster ("the verifier /
// dispute decider must be a third lane, distinct from the poster"). Those
// two independence failures, plus the no-designation case, are exactly the
// configurations evaluable from the bounty's own current state, and they
// are the ones this field reports:
//
//   no designee                  -> undisputable / no_decider_named
//   designee is the poster       -> undisputable / verifier_is_poster
//     (reachable only on rows that predate the create-time guard, or were
//     written outside postBounty; the guard makes it uncreatable today)
//   designee is the claimant     -> undisputable / verifier_is_executor
//     (evaluated against the CURRENT claimant, so the flaw surfaces the
//     moment the designee claims the work, not at dispute time)
//   otherwise                    -> disputable, decider = the designee
//
// There is NO fallback in the dispute path: when nothing is designated,
// disputeBounty seats nobody and refuses dispute_unavailable — the poster
// never decides by default. This field follows that truth: `decider` is
// the designated decider only, never a substitute party, and is null
// whenever the status is undisputable.
//
// Scope honesty: disputeBounty ALSO re-checks, at dispute time, that the
// designee is still an enrolled/active member and is independent of the
// CHALLENGER (who is unknowable at read time). Those dispute-time gates
// can still refuse a bounty this field reads disputable; the field claims
// the posting configuration's truth, not a guarantee about a future
// dispute attempt by a specific challenger.
export function disputabilityFor({ poster, verifier, disputeDecider, claimant } = {}) {
  const designated = disputeDecider ?? verifier ?? null;
  if (!designated)
    return Object.freeze({ status: "undisputable", reason: "no_decider_named", decider: null });
  if (designated === poster)
    return Object.freeze({ status: "undisputable", reason: "verifier_is_poster", decider: null });
  if (claimant !== null && claimant !== undefined && designated === claimant)
    return Object.freeze({ status: "undisputable", reason: "verifier_is_executor", decider: null });
  return Object.freeze({ status: "disputable", reason: null, decider: designated });
}
