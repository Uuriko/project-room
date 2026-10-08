# QA Mutation Probes

Ledger of mutation-testing probes against Project Room. Workers append rows;
never re-probe a row already recorded CAUGHT. Skipped classes (per wave
brief): OAuth code reuse, spend void-after-settle, writer-fence tamper,
permission-upgrade review().

Columns: date · worker · target · mutant · result · hardening.

| date | worker | target | mutant | result | hardening |
|---|---|---|---|---|---|
| 2026-10-08 | qa200-mut-18 | server/webhook-dispatch.mjs `classifyHttpStatus` | 409 → "retry" (terminal 4xx retried blindly) | UNCAUGHT — existing test pinned 400/404/422 → dead but not 409 | tests/webhook-dispatch.test.js: "classifyHttpStatus never retries terminal 4xx: 409 is dead, not retried" (red-with-break ✓, green-without ✓) |
| 2026-10-08 | qa200-mut-18 | server/webhook-dispatch.mjs `postDelivery` | validate target once up front, follow redirects without per-hop re-validation (retry without re-reading state) | CAUGHT — existing test "postDelivery does not follow redirects to private targets" failed on the mutant | none needed |
| 2026-10-08 | qa200-mut-18 | server/agent-plugin-store.mjs `attemptStoredDelivery` retry scheduling | `next_attempt_at = now` (no backoff on retryable 429/5xx — retry hammer) | UNCAUGHT — only backoffDelayMs arithmetic was tested, never its presence on the retry path | tests/webhook-retry-backoff.test.js: "a 429 retry reschedules with backoff, never immediately" (red-with-break ✓, green-without ✓) |
