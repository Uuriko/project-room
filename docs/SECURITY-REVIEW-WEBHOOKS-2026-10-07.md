# Webhook security review — 2026-10-07

Hard task 175: review third-party webhook handlers — signature verification,
replay protection, idempotency. Done when: a review doc + tests for
forged/replayed webhooks.

Scope (every inbound webhook surface in `server/` on main as of 2026-10-07):

| Surface | Module | Verdict |
|---|---|---|
| GitHub App webhook signature | `server/github-app/verify.mjs` | PASS |
| PR webhook route | `server/claim-autolink.mjs` (`postPrWebhook`) | PASS |
| Telegram channel inbox | `server/channel-import.mjs` (`ChannelWebhookInbox`) | PASS |
| Telegram secret rotation | `server/channel-adapters/telegram-rotation.mjs` | PASS |
| Outbound agent deliveries (HMAC) | `server/webhook-dispatch.mjs` | PASS |
| Outbound webhook target guard | `server/outbound-webhooks.mjs` (+ SSRF blocklist) | PASS |

## Findings (all verified against code + tests)

1. **Signature verification is constant-time and fail-closed.**
   `verifyWebhook` (github-app/verify.mjs) compares HMAC-SHA256 with
   `constantTimeEqual`, refuses bodies over 1 MB before the MAC runs,
   rejects missing/malformed `sha256=` headers, and never logs or echoes the
   secret. The route (`postPrWebhook`) is OFF by default (404 without
   `ROOM_PR_WEBHOOK=1`), 503 when enabled without `GITHUB_PR_WEBHOOK_SECRET`,
   rate-limited per source IP (120/min), and replies with minimal shapes
   (claim id + PR number + state; PR bodies never echoed). New tests in
   `tests/webhook-security-replay.test.js` assert a forged signature gets a
   401 whose body carries no secret or signature material.
2. **Replay protection: no per-delivery dedup journal, idempotency-by-state
   instead — holds.** GitHub does not dedupe delivery ids here; it doesn't
   need to: `autoLinkPullRequest` refuses `already_linked`/`open_link_exists`,
   and `applyPullRequestWebhook` only settles pulls with no outcome recorded,
   so a replayed delivery changes nothing and emits no receipt. New tests
   assert both at the handler level (`handlePrWebhookPayload` ×2 for
   `opened` and for `closed+merged`) and at the HTTP route level (second
   identical signed delivery returns the same response and journals no new
   events).
3. **Telegram inbox dual-accept is bounded and timing-safe.**
   `ChannelWebhookInbox` stores only the SHA-256 digest of the secret; the
   previous digest verifies only while `webhookRotationState` is `pending`
   (24h default, 7d max), via `timingSafeEqual`. Redelivered `update_id`s are
   a journal no-op (property-tested in
   `tests/channel-webhook-dedupe-property.test.js`).
4. **Outbound agent deliveries are replay-resistant by contract.**
   `webhook-dispatch.mjs` signs `{deliveryId, eventType, issuedAt, data}`
   with HMAC-SHA256; receivers must reject `issuedAt` older than
   `REPLAY_TOLERANCE_MS` (5 min) and dedupe on `deliveryId`. Outbound
   targets pass the webhook SSRF guard (private/reserved address blocklist,
   DNS fail-closed).
5. **Residual risks (accepted, documented, not fixed here):**
   - GitHub replay window: a replayed *signed* delivery inside the handler's
     idempotency window is a no-op (finding 2), but there is no
     receiver-side timestamp rejection on the PR route; GitHub's
     HMAC is not time-bound. Rely on delivery idempotency, not freshness.
   - Outbound `REPLAY_TOLERANCE_MS` and `deliveryId` dedupe are receiver-side
     obligations — the repo documents the contract but cannot enforce it on
     third-party receivers.

## Test evidence

- `tests/webhook-security-replay.test.js` (new): 4 tests — replay at the
  handler level (opened + closed+merged), forged signature at the route
  (401, no leak), replayed signed delivery at the route.
- Existing suites re-run green: `tests/github-app-core.test.js`,
  `tests/claim-autolink.test.js`, `tests/claim-autolink-http.test.js`,
  `tests/channel-webhook-dedupe-property.test.js`,
  `tests/telegram-webhook-rotation.test.js`, `tests/webhook-dispatch*.test.js`.

Task 175 closed. No code changes required; the review found the handlers
sound and closed the one coverage gap (HTTP-level replay/forgery) with tests.
