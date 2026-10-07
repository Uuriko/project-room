# Exchange Notification Design (hard task 115)

Who gets told what, when, and how often. Notifications are room messages
(inbox) + optional email digest; no push in v1.

## Delivery rules

1. **Actionable only.** Every notification names the action the recipient
   should take. FYI-only notifications are batched into the daily digest.
2. **One ping per state change.** A bounty moving funded→claimed notifies
   the sponsor once; further claims on other bounties don't re-ping.
3. **Digest by default.** Non-urgent events (new matching bounty, review
   completed by someone else) go to the daily digest, not instant ping.
4. **Urgent = money or deadline.** Payout ready, dispute opened against
   you, review requested with <24h left — these ping instantly.
5. **Quiet hours respected.** Instant pings queue during the recipient's
   quiet hours (default 22:00–08:00 local) and deliver at 08:00, except
   dispute-opened (delivers immediately, always).
6. **Unsubscribe per category.** Bounty updates, reviews, disputes,
   digests — each toggles independently. Dispute notifications cannot be
   unsubscribed (you must know when you're in a dispute).

## The 12 event templates

| # | Event | Audience | Urgency | Template |
|---|---|---|---|---|
| 1 | bounty.funded | sponsor | digest | "Your bounty '{title}' is funded ({amount}cr) and open for claims." |
| 2 | bounty.claimed | sponsor | ping | "'{title}' was claimed by {claimer}. Review their profile: {link}." |
| 3 | bounty.match | contributor | digest | "3 new bounties match your skills: {list}." |
| 4 | work.submitted | reviewer(s) | ping | "{claimer} submitted work for '{title}'. Review requested: {link}." |
| 5 | review.advisory | sponsor + claimer | digest | "Reviewer {reviewer} advised {verdict} on '{title}': {summary}." |
| 6 | payout.ready | claimer | ping (urgent) | "{amount}cr for '{title}' is ready to release. Confirm: {link}." |
| 7 | payout.released | claimer | ping | "{amount}cr released for '{title}'. Receipt: {link}." |
| 8 | dispute.opened | both parties | ping (urgent, always) | "A dispute was opened on '{title}' by {party}. Evidence due by {deadline}: {link}." |
| 9 | dispute.evidence_due | party with pending evidence | ping (urgent <24h) | "Evidence for the '{title}' dispute is due in {hours}h: {link}." |
| 10 | dispute.resolved | both parties | ping | "The '{title}' dispute was resolved: {outcome}. {amount}cr {direction}." |
| 11 | review.timeout | sponsor + backup reviewers | ping | "Review on '{title}' timed out. A new reviewer has been drawn: {link}." |
| 12 | reputation.changed | contributor | digest | "Your exchange reputation is now {score} ({delta:+}). {reason}." |

Copy rules (from `templates/design-notification-copy.md`): ≤140 chars,
name the action, consistent voice. `{link}` is always a deep link to the
bounty or dispute; never a bare "click here".
