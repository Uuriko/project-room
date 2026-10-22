// Release-seat fallback eligibility (owner decision 2026-10-21, room seq 17471
// and 17474; contract docs/RELEASE-LEASE-CONTRACT.md). A pure decision that
// fails closed: any missing, malformed, stale or unbound fact refuses. It
// never sets a status, merges, or reads a credential. An issuer acting on
// `eligible: true` still needs its own `statuses: write` grant and the slot.
const SHA = /^[0-9a-f]{40}$/;
export const FALLBACK_SILENCE_MS = 30 * 60 * 1000;
export const HOLD_OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;

// Owner-approved backup landers (Potter, 2026-10-21 23:08 PT, relayed via his
// chat with Grok Bot; room seq 17474). Jill 2 only. Changing this list needs a
// new owner decision.
export const APPROVED_FALLBACKS = Object.freeze(["ai_rNH_kQLusyE2Y0sj"]); // Jill 2
// The decision above was relayed, not posted by the owner in Room. Until the
// owner's own room record exists, set here as its seq, every request refuses.
export const OWNER_CONFIRMATION_SEQ = null;

const refuse = (reason, detail = {}) => ({ eligible: false, reason, ...detail });
const nonEmpty = value => typeof value === "string" && value.length > 0;
// GitHub logins are case-insensitive: compare canonical forms only.
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const login = value => (typeof value === "string" && LOGIN.test(value.toLowerCase()) ? value.toLowerCase() : null);

// facts: {
//   fallback: { memberId, githubLogin },
//   approvedFallbacks: [memberId],      // defaults to APPROVED_FALLBACKS
//   ask: { head, base, postedAt, releaseSeatRepliedAt|null },
//   pr: { number, head, base, authorLogin, authorMemberId?, state },
//   checks: { head, status, includesCommitStatuses },   // check runs AND commit statuses
//   reads: [{ login, head, verified }],                  // verified non-author reads
//   holdObservation: { prNumber, head, observedAt, complete, holds: [{ head?, prNumber?, active }] },
//   nowMs
// }
export function fallbackEligibility(facts) {
  const { fallback, approvedFallbacks = APPROVED_FALLBACKS, ownerConfirmationSeq = OWNER_CONFIRMATION_SEQ, ask, pr, checks, reads, holdObservation, nowMs } = facts ?? {};
  const fallbackLogin = login(fallback?.githubLogin);
  if (!nonEmpty(fallback?.memberId) || !fallbackLogin || !Array.isArray(approvedFallbacks) || !approvedFallbacks.includes(fallback.memberId))
    return refuse("not_approved_fallback");
  if (!Number.isSafeInteger(ownerConfirmationSeq) || ownerConfirmationSeq < 1) return refuse("owner_unconfirmed");
  if (!Number.isFinite(nowMs)) return refuse("invalid_time");
  if (!ask || !SHA.test(ask.head ?? "") || !SHA.test(ask.base ?? "")) return refuse("no_exact_ask");
  if (!pr || pr.state !== "open" || !Number.isSafeInteger(pr.number)) return refuse("pr_not_open");
  if (pr.head !== ask.head) return refuse("stale_head", { askedHead: ask.head, currentHead: pr.head });
  if (pr.base !== ask.base) return refuse("stale_base", { askedBase: ask.base, currentBase: pr.base });
  const authorLogin = login(pr.authorLogin);
  if (!authorLogin) return refuse("author_unknown");
  if (authorLogin === fallbackLogin || pr.authorMemberId === fallback.memberId) return refuse("self_authored");
  if (ask.releaseSeatRepliedAt != null) return refuse("release_seat_replied");
  const posted = Date.parse(ask.postedAt ?? "");
  if (!Number.isFinite(posted) || posted > nowMs) return refuse("invalid_time");
  const waited = nowMs - posted;
  if (waited < FALLBACK_SILENCE_MS) return refuse("too_soon", { waitMs: FALLBACK_SILENCE_MS - waited });
  if (checks?.head !== pr.head) return refuse("checks_unbound");
  if (checks.includesCommitStatuses !== true) return refuse("checks_incomplete");
  if (checks.status !== "green") return refuse("checks_not_green", { checks: checks.status ?? "unknown" });
  if (!Array.isArray(reads) || !reads.some(r => r?.verified === true && r.head === pr.head && login(r.login)
      && login(r.login) !== authorLogin && login(r.login) !== fallbackLogin))
    return refuse("no_non_author_read");
  const obs = holdObservation;
  const observed = Date.parse(obs?.observedAt ?? "");
  if (!obs || obs.complete !== true || obs.head !== pr.head || obs.prNumber !== pr.number || !Array.isArray(obs.holds)
      || !Number.isFinite(observed) || observed > nowMs || nowMs - observed > HOLD_OBSERVATION_MAX_AGE_MS)
    return refuse("holds_unobserved");
  if (obs.holds.some(h => !h || typeof h !== "object" || (h.head === undefined && h.prNumber === undefined))) return refuse("holds_malformed");
  if (obs.holds.some(h => h.active !== false && (h.head === pr.head || h.prNumber === pr.number))) return refuse("held");
  return { eligible: true, prNumber: pr.number, head: pr.head, base: pr.base, fallback: fallback.memberId };
}
