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

// Act-response warnings for the same derivation (W2-F2, register rows 2
// and 4: RES-0003 / RES-0005). The computed field above made bounty READS
// honest, but the W6-A production re-verification (build 1ab906c3) found
// the residual silence: create and fund succeed with no warning, so the
// poster still learns a bounty can never be disputed only from a
// dispute_unavailable refusal after accepted, paid work. These warnings
// ride the post / fund / claim act responses — the moments the
// configuration is created, paid into, or (by the designee's own claim)
// made undisputable. Warning-only: no act is refused and no money path
// changes; disputeBounty remains the sole authority.
//
// The two-member leg is the pair trap of row 4: when the room's active
// members are exactly the poster and the designated decider, the
// designee is the only lane that can ever claim (a poster cannot claim
// their own bounty), so the designation is disputable only on paper —
// the moment they claim, the bounty is undisputable for good. The
// warning names that at posting time, plus the remedy the product
// already supports (a third member named as decider). memberLanes is
// the room's canonical active-member lanes, or null when no membership
// source exists (the leg is then skipped, never guessed).
export function undisputableWarnings({ poster, verifier, disputeDecider, claimant, memberLanes } = {}) {
  const derived = disputabilityFor({ poster, verifier, disputeDecider, claimant });
  if (derived.status === "undisputable") {
    if (derived.reason === "no_decider_named")
      return ["warning: this bounty can never be disputed — no dispute decider (or verifier) was named at posting. A dispute needs a decider named at posting, a third lane distinct from the poster and from the worker; name a verifier or dispute decider at posting to keep disputes possible."];
    if (derived.reason === "verifier_is_executor")
      return ["warning: this bounty can never be disputed — the designated dispute decider is the worker. A decider must be independent of the worker, so no dispute can ever be opened on this bounty."];
    return ["warning: this bounty can never be disputed — the designated dispute decider is the poster. A decider must be a third lane distinct from the poster."];
  }
  if ((claimant === null || claimant === undefined)
    && Array.isArray(memberLanes) && memberLanes.length === 2
    && derived.decider !== null
    && memberLanes.includes(derived.decider) && memberLanes.includes(poster))
    return ["warning: the designated dispute decider is the room's only other member — if they claim this bounty it can never be disputed, because a decider cannot be the worker. Invite a third member and name them as decider to keep disputes possible."];
  return [];
}
