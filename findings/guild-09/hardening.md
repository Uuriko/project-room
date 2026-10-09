# Guild-09 test hardening — track 1 rollup (20 units)

Method per unit: baseline run of the suite → up to 6 mechanical semantic breaks
(`===`/`!==` flips, `return true`/`false` flips) applied one at a time to the
covered source file → run suite → restore byte-identical (verified per unit).
Verdict `hardened` = at least one break went red without a syntax error.
Verdict `false-positive` = all breaks stayed green. `baseline-red` = the suite
was already red/timing-out before any break.

## Totals

- 20 units run; **16 hardened**, **2 false-positive**, **2 baseline-red**

## Hardened (16)

| unit | suite | source | killing break |
|---|---|---|---|
| h01 | analytics-derive.test.js | server/analytics/derive-tables.mjs | flip ===→!== L12 |
| h02 | access-request-cancel.test.js | server/access-requests.mjs | flip ===→!== L98 (isPending) |
| h03 | admin-routes-autonomy-tier.test.js | server/autonomy-tiers.mjs | flip ===→!== L90 |
| h04 | bounty-anti-flake.test.js | server/bounty-escrow.mjs | flip !==→=== L553 (4th attempt; L450/L533/L536 stayed green — convergence fast-paths untested) |
| h05 | agent-enrollment.test.js | server/recovery.mjs | flip ===→!== L12 (canonical JSON) |
| h06 | access-request-cancel.test.js | server/identity-ratelimit.mjs | flip ===→!== L12 |
| h07 | agent-card-deploy-consistency.test.js | server/agent-card-signing.mjs | flip !==→=== L50 |
| h08 | channel-import.test.js | server/graph-email.mjs | flip ===→!== L13 (L7 `not_loaded` state flip stayed green — that path uncovered) |
| h10 | channel-connection.test.js | server/email-envelope.mjs | flip !==→=== L9 |
| h11 | agent-heartbeats.test.js | server/agent-heartbeats.mjs | flip ===→!== L107 |
| h13 | channel-drain.test.js | server/channel-import.mjs | flip ===→!== L26 (validateWebhookSecret) |
| h15 | analytics-backfill.test.js | server/analytics/tail.mjs | flip ===→!== L27 |
| h16 | agent-lanes.test.js | server/work-matchmaking.mjs | flip ===→!== L36 (isStr) |
| h17 | webhook-dispatch.test.js | server/webhook-dispatch.mjs | flip ===→!== L57 |
| h19 | notify-policy.test.js | server/notify-prefs.mjs | flip !==→=== L29 |
| h20 | mention-lifecycle.test.js | server/mention-lifecycle.mjs | flip ===→!== L29 |

Partial-coverage notes: h04 (bounty-escrow convergence fast-paths L450/L533/L536
breaks stayed green) and h08 (graph-email L7 state flip stayed green) each have
one uncovered path worth a follow-up test.

## False positives (2)

- **h14 — audit-wave-low-a.test.js vs server/inbox-spam.mjs**: 6 breaks in
  inbox-spam.mjs all stayed green. The suite's tests (stitch.rotate receipts,
  quarantine queue, message dedup, attachment purge) never exercise
  inbox-spam.mjs — the import is incidental. No rewrite owed to this suite;
  coverage lives in the dedicated suites (mutation m01 confirmed
  inbox-spam.test.js kills the same breaks).
- **h18 — analytics-tail.test.js vs server/receipts-live.mjs**: 2 breaks stayed
  green; incidental import. Coverage lives in receipts-route.test.js /
  receipts-live-filter.test.js (mutation m02 confirmed kill).

## Baseline-red (2)

- **h09 — id-sec-http.test.js**: baseline failed once (`minted.status` 201 vs
  expected 403 at line 125) during the parallel batch, then passed 3/3 on
  re-runs (4/4 tests). Flaky, not a product bug — but the flake is in the
  security-critical unverified-mint assertion; recommend `detect-flaky` runs.
- **h12 — messages-backfill.test.js**: baseline timed out at 280s (also timed
  out with a break applied). Suite is too slow for the unit budget; needs a
  dedicated long-timeout investigation.

## Mutation track (10 units) — summary

- **8 killed** (m01 inbox-spam, m02 receipts-live, m03 http, m05 telegram
  adapter, m06 webhook-subscriptions, m07 agent-directory, m08 telegram-config,
  m09 notify-policy)
- **1 survived real bug → BUG-1** (server/analytics/schema.mjs:90-91
  `columnExists` — two mutants survived 5 analytics suites; fail-first
  regression added to tests/analytics-derive.test.js, committed 2f3f890b8;
  see BUGS.md)
- **1 baseline-red artifact** (m04: 6 suites in one runner tripped
  warnMissingSecurityContactCheck; suite passes 19/19 standalone)
