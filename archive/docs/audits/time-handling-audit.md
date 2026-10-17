# Time-handling audit

**Task:** 200-hard-tasks #173 — audit time handling: timezones, clock skew,
expiry checks, replay windows. Done when: an audit doc + tests proving expiry
can't be bypassed by skew within the documented tolerance.
**Date:** 2026-10-07 · **Lane:** HT-7 · **Head audited:** `3a365ce4a`

## Timezones

All server-side time is epoch milliseconds or UTC ISO-8601 strings. No local
timezone is ever consulted for an auth or expiry decision:

- Expiry fields are integers (`expires_at`, `redeem_by`, `created_at`) compared
  against `store.now()` (ms since epoch).
- Human-facing stamps use `new Date(ms).toISOString()` — always UTC, never
  locale formatting.
- The privacy policy's retention windows (7d share links, 30d invitations and
  access keys, 8h guest access, 8h/30d sessions) are all evaluated as
  `nowMs >= expiresAt` on the server clock.

Finding: no timezone-dependent branch was found in any expiry, session, or
receipt path. No change needed.

## Clock skew — documented tolerances

| Mechanism | Tolerance | Where |
|---|---|---|
| Vetting receipts (`verifyVettingReceipt`) | `DEFAULT_CLOCK_SKEW_MS = 5 min` future window; `DEFAULT_VETTING_MAX_AGE_MS = 7 d` staleness | `server/vetting-receipts.mjs` |
| Webhook dispatch freshness (receivers) | deliveries older than the tolerance are rejected | `server/webhook-dispatch.mjs` |
| GitHub App JWT | `iat = now − 60 s`, `exp = now + 9 min` | `server/github-app/auth.mjs` (tested in `tests/github-app-core.test.js`) |
| GitHub installation tokens | cached until 5 min before `expires_at` | `server/github-app/auth.mjs` |
| Invite / session / key expiry | **zero tolerance — strict `>=`** | `server/agent-invites.mjs`, `server/referral-invites.mjs`, `server/guest-invites.mjs` |

The asymmetry is deliberate and correct: *freshness* checks (did this just
happen?) tolerate a few minutes of skew; *expiry* checks (is this still valid?)
grant nothing. A skewed client clock can never extend validity because expiry
is evaluated on the **server clock** (`store.now()`), and no client-supplied
timestamp participates in any redeem/validate decision.

## Why skew cannot bypass expiry

1. **Strict comparison.** Invite redemption uses `this.now() >= expiresAt`
   (`server/referral-invites.mjs:324,380`). A client presenting a backdated
   request time changes nothing — the check never reads request time.
2. **Skew window is future-only.** In `verifyVettingReceipt`, `clockSkewMs`
   widens only the *future* bound (`issuedMs > at + clockSkewMs` rejects).
   The *stale* bound (`issuedMs < at - maxAgeMs`) does not consult the skew
   window at all: widening the skew parameter cannot revive an expired receipt.
   This is asserted by tests in this change (`tests/time-skew-boundaries.test.js`).
3. **Skew never weakens other checks.** A receipt inside the skew window still
   needs a valid Ed25519 signature under the room's trusted key, a non-empty
   candidateId, and (when supplied) matching candidate/task binding — the
   window only forgives clock disagreement, not forgery.
4. **Boundary exactness.** The vetting-receipt boundaries are exact at the
   millisecond: `issuedAt == at + clockSkewMs` passes, `+1 ms` fails; same for
   the staleness edge. No off-by-one grants an extra millisecond of validity
   (tested).

## Replay windows

- **Vetting receipts:** caller-supplied `Set` of seen `receiptId`s; repeats
  rejected (`duplicate_receipt`). The set is the caller's responsibility —
  documented in the module contract.
- **PR webhook deliveries:** recorded per repo (`deliveredAt`) for the poll
  fallback, but **delivery IDs are not deduped** — re-delivering the same
  `x-github-delivery` re-runs `handlePrWebhookPayload`. The handler is written
  to be idempotent (linking is a no-op when already linked; settlement goes
  through the same apply path), but there is no explicit replay guard. Filed
  as a follow-up in the webhook security review (task #175).
- **Channel webhooks (Telegram etc.):** secret-token auth + per-address rate
  limits + delivery dedupe property tests (`tests/channel-webhook-dedupe-property.test.js`).
- **Work-claim apply:** `inbox.apply()`-style paths are the transaction
  boundary; concurrent enforcer runs are serialized by the claim registry.

## Expiry inventory (server-authoritative)

| Credential | Lifetime | Check site |
|---|---|---|
| Room invites (agent) | `expiresInMinutes`, strict | `server/agent-invites.mjs` |
| Referral invites | `expiresAt`, strict | `server/referral-invites.mjs` |
| Guest invites | `redeem_by`, strict | `server/guest-invites.mjs` |
| Account session | 8 h browser session; 30 d re-signin cookie | privacy policy / session code |
| Share links | 7 d | privacy policy |
| Invitations / access keys | 30 d | privacy policy |
| Guest access | 8 h | privacy policy |
| Vetting receipts | 7 d max age, 5 min future skew | `server/vetting-receipts.mjs` |
| GitHub installation tokens | provider `expires_at`, 5 min early refresh | `server/github-app/auth.mjs` |

## Tests added (companion implementation PR)

`tests/time-skew-boundaries.test.js`:
- receipt issued exactly at `at + clockSkewMs` verifies; at `+1 ms` is rejected
  (`future_receipt`) — the tolerance is exact, not approximate;
- receipt issued exactly at `at − maxAgeMs` verifies; at `−1 ms` is rejected
  (`stale_receipt`);
- widening `clockSkewMs` cannot revive a stale receipt (skew is future-only);
- a future receipt inside the skew window with a bad signature is still
  rejected (skew does not weaken signature binding);
- an invite redeemed at `expiresAt` is rejected even when the requester
  presents a backdated request time (server clock is authoritative).

## Verdict

Time handling is sound: UTC everywhere, server-authoritative expiry, strict
comparisons, a documented and exactly-enforced skew window that is future-only.
The one gap is webhook delivery replay dedupe (see #175 review). No timezone
or skew bypass was found.
