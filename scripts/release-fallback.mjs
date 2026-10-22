// Release-seat fallback eligibility (owner decision 2026-10-21, room seq 17471;
// contract docs/RELEASE-LEASE-CONTRACT.md). A pure decision: it reads facts it
// is given and returns eligible or the first refusal. It never sets a status,
// merges, or reads a credential. An issuer that acts on `eligible: true`
// still needs its own `statuses: write` grant and the slot.
const SHA = /^[0-9a-f]{40}$/;
export const FALLBACK_SILENCE_MS = 30 * 60 * 1000;

// Owner-approved backup landers (Potter, 2026-10-21 23:08 PT, relayed via his
// chat with Grok Bot; room seq after 17472). Jill 2 only. Changing this list
// needs a new owner decision.
export const APPROVED_FALLBACKS = Object.freeze(["ai_rNH_kQLusyE2Y0sj"]); // Jill 2

const refuse = (reason, detail = {}) => ({ eligible: false, reason, ...detail });

// facts: {
//   fallback: { memberId, githubLogin },
//   approvedFallbacks: [memberId],           // defaults to APPROVED_FALLBACKS
//   ask: { head, base, postedAt, releaseSeatRepliedAt|null },
//   pr: { head, base, authorLogin, state },
//   checks: { status },                       // landing-facts checkSummary
//   reads: [{ login, head }],                 // non-author reads
//   holds: [{ head|null, prNumber|null, active }],
//   prNumber, nowMs
// }
export function fallbackEligibility(facts) {
  const { fallback, approvedFallbacks = APPROVED_FALLBACKS, ask, pr, checks, reads = [], holds = [], prNumber, nowMs = Date.now() } = facts ?? {};
  if (!fallback?.memberId || !approvedFallbacks.includes(fallback.memberId)) return refuse("not_approved_fallback");
  if (!ask || !SHA.test(ask.head ?? "") || !SHA.test(ask.base ?? "")) return refuse("no_exact_ask");
  if (!pr || pr.state !== "open") return refuse("pr_not_open");
  if (pr.head !== ask.head) return refuse("stale_head", { askedHead: ask.head, currentHead: pr.head });
  if (pr.base !== ask.base) return refuse("stale_base", { askedBase: ask.base, currentBase: pr.base });
  if (pr.authorLogin && fallback.githubLogin && pr.authorLogin === fallback.githubLogin) return refuse("self_authored");
  if (pr.authorMemberId && pr.authorMemberId === fallback.memberId) return refuse("self_authored");
  if (ask.releaseSeatRepliedAt) return refuse("release_seat_replied");
  const posted = Date.parse(ask.postedAt ?? "");
  if (!Number.isFinite(posted)) return refuse("no_exact_ask");
  const waited = nowMs - posted;
  if (waited < FALLBACK_SILENCE_MS) return refuse("too_soon", { waitMs: FALLBACK_SILENCE_MS - waited });
  if (checks?.status !== "green") return refuse("checks_not_green", { checks: checks?.status ?? "unknown" });
  if (!reads.some(r => r?.head === pr.head && r?.login && r.login !== pr.authorLogin && r.login !== fallback.githubLogin))
    return refuse("no_non_author_read");
  const hold = holds.find(h => h?.active !== false && (h?.head === pr.head || (prNumber != null && h?.prNumber === prNumber)));
  if (hold) return refuse("held");
  return { eligible: true, head: pr.head, base: pr.base, fallback: fallback.memberId };
}
