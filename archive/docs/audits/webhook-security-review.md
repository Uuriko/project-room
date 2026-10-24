# Third-party webhook security review

**Task:** 200-hard-tasks #175 — review webhook handlers (GitHub, venue
callbacks): signature verification, replay protection, idempotency. Done when:
a review doc + tests for forged/replayed webhooks.
**Date:** 2026-10-07 · **Lane:** HT-7 · **Head audited:** `3a365ce4a`

## Inbound handlers reviewed

### 1. GitHub App webhooks — `server/github-app/verify.mjs`

| Control | Status |
|---|---|
| Signature verification | ✅ HMAC-SHA256 over the raw body, compared in constant time (`constantTimeEqual`, length-mixed into the diff) |
| Missing/empty secret | ✅ fails closed (`missing_signature`) — the secret is an argument, never read from env here |
| Malformed signature | ✅ non-hex / odd-length decoded as `null`, then compared against a zeroed buffer so timing does not leak validity |
| Body size cap | ✅ 1 MB refused *before* the MAC runs (no HMAC-DoS on huge bodies) |
| Event allowlist | ✅ only `pull_request`, `check_suite`, `installation`, `installation_repositories`; anything else (incl. `ping`, `push`) is ignored |
| Malformed JSON | ✅ `invalid_json`, ignored; arrays rejected |
| Secret handling | ✅ never logged, stored, or echoed; `verify.mjs` does not read the environment |

Tests: `tests/github-app-core.test.js` covers tampered body, wrong secret,
missing header, oversize body, and the exact-limit boundary.

### 2. GitHub PR webhook route — `POST /api/github/pr-webhook` (`server/claim-autolink.mjs`)

| Control | Status |
|---|---|
| Default posture | ✅ off unless `ROOM_PR_WEBHOOK=1/true/yes`; when off, answers **404** (indistinguishable from no route) |
| Enabled but unconfigured | ✅ **503** `webhook_unconfigured` — fails closed, never runs unverified |
| Rate limiting | ✅ `pr-webhook:<remoteAddress>` bucket, 120 |
| Body cap | ✅ `WEBHOOK_BODY_LIMIT` (1 MB), 413 beyond |
| Signature | ✅ reuses the constant-time verifier; 401 `webhook_signature` on mismatch |
| Response minimality | ✅ returns claim id + PR number + state only; PR bodies never echoed |
| Secret hygiene | ✅ value never logged/stored; only the env var *name* is documented |

Tests: `tests/claim-autolink-http.test.js` (mounted, disabled-by-default 404,
503 unconfigured, 401 unauthenticated, valid-but-irrelevant `ping` ignored);
`tests/github-app-core.test.js` (forged signature matrix).

### 3. Channel (venue) webhooks — Telegram et al. (`server/routes/inbox.mjs`)

| Control | Status |
|---|---|
| Authentication | ✅ `x-telegram-bot-api-secret-token` header compared per connection; non-string → 401 `channel_webhook_denied` |
| Rate limiting | ✅ per-address `inbox-webhook` bucket |
| Body cap | ✅ `channelSyncLimits.webhookBodyBytes` |
| Delivery dedupe | ✅ property tests in `tests/channel-webhook-dedupe-property.test.js` |

### 4. Outbound webhook subscriptions — `server/agent-webhook-subscriptions.mjs`

Outbound only (the room calls *you*). Deliveries carry signatures and are
retained 7 days (`WEBHOOK_DELIVERY_RETENTION_MS`); not an inbound attack
surface. Noted for completeness.

## Findings

### F-1 (fixed in this change): no delivery-ID replay dedupe on the PR webhook

**Severity:** low. `handlePrWebhookPayload` records `deliveredAt` per repo (for
the poll fallback) but never dedupes `x-github-delivery` IDs. Re-delivering
the same GitHub delivery — accidental redelivery after a timeout, or a
deliberate replay by someone holding a valid signed payload — re-runs the full
payload handler. In practice the handler is written to be idempotent (linking
is a no-op when already linked; settlement flows through the same apply path),
but idempotency was incidental, not enforced, and a retry storm re-executes
DB work on every delivery.

**Fix (companion implementation PR):** delivery-ID journal in `postPrWebhook`.
After signature verification, the handler checks a bounded journal (single
`work_claim_config` row, `_claim-pr-deliveries:`, TTL 7 days, capped at the
most recent 500 IDs). A repeated delivery ID short-circuits with
`{ ok: true, duplicate: true }` and never reaches the payload handler. Old
entries are pruned on write so the journal cannot grow unboundedly.

Tests (fail-first, in the implementation PR):
- the first delivery with a given `x-github-delivery` processes normally;
- re-delivering the identical signed payload returns `duplicate: true` and
  does not re-run settlement (asserted via the settled-claims count);
- a forged signature on a replayed body is still 401 (replay ≠ auth bypass);
- entries older than the TTL are forgotten (a new delivery with an old ID
  processes again);
- the journal stays bounded under 1000 distinct deliveries.

### F-2 (accepted): `ping` events are 200-ignored, not 404

A validly-signed `ping` returns `{ ok: true, ignored: true }`. This confirms
to GitHub the hook is configured, which is the intended UX for the App
settings page. No change.

### F-3 (accepted): no timestamp freshness check on GitHub deliveries

GitHub does not sign a timestamp, so there is no signed freshness to check.
Replay protection is therefore delivery-ID dedupe (F-1), not a time window.
Correct as designed.

## Residual notes

- The `agent-plugin` webhook subscriptions are operator-configured outbound
  hooks; a compromised subscriber URL exfiltrates whatever events the operator
  subscribed to. Operators should subscribe minimally — worth one line in the
  operator docs (future).
- `scripts/inbox-telegram-check.mjs` / `inbox-unified-check.mjs` exist for
  operational verification of the channel webhooks.

## Verdict

Signature verification is strong everywhere (constant-time HMAC or per-
connection secret tokens, fail-closed on missing config, capped bodies, rate
limits). The one real gap — replay dedupe on the PR webhook — is fixed with
tests in the companion implementation PR.
