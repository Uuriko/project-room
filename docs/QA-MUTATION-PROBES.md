# QA Mutation Probes

Mutation-testing ledger for John's 200-agent QA wave (2026-10-08), mutation lane.
Workers append rows here; **never re-probe a recorded CAUGHT row** — the suite
already pins that behavior.

Columns: probe | worker | target (file) | mutation | verdict | pinning test(s) | notes.

| probe | worker | target | mutation | verdict | pinning test(s) | notes |
|---|---|---|---|---|---|---|
| qa200-mut-21-A | qa200-mut-21 (coord qa200-mutation) | server/work-claim-integrity.mjs `assertBoardEventBudget` | Gate disabled: early `return` — writes allowed past the budget floor | CAUGHT | tests/work-claim-integrity.test.js "board input rules … event budget" (`assert.throws … 409 room_event_budget_low`) | Fails red at test.js:440 "Missing expected exception". Route-level test also pins the 409. |
| qa200-mut-21-B | qa200-mut-21 (coord qa200-mutation) | server/work-claim-integrity.mjs `roomEventsRemaining` | Counter undercounts: `eventsPerRoom - floor(sequence/2)` — writes appear not to consume budget | CAUGHT | tests/work-claim-integrity.test.js "with under 10% of the event budget left…" (route) + "board input rules … event budget" (`roomEventsRemaining(limit-5) === 5`) | Both route and pure tests fail under the mutation. End-to-end counter tracking pinned by `status.eventsRemaining === limit - sequence` after real writes. |
| qa200-mut-21-C | qa200-mut-21 (coord qa200-mutation) | server/work-claim-routes.mjs call sites (lines 519/551/760) | Privilege flattened: `{ privileged: true }` for all writers at <10% budget left | CAUGHT | tests/work-claim-integrity.test.js "with under 10% of the event budget left only the owner and claim managers write" | Non-privileged `contrib` write no longer refused → route test fails. Pure unit (`privileged:false` throws, `privileged:true` passes) also pins the distinction. |

## Probes recorded by #2040

Append-only ledger. One row per probe. Never re-probe a recorded CAUGHT row.

Columns: probe | date | worker | target | mutation | tests run | result | notes

| probe | date | worker | target | mutation | tests run | result | notes |
|---|---|---|---|---|---|---|---|
| MUT-08-A | 2026-10-08 | qa200-mut-08 | server/receipts-live.mjs `hiddenReceiptIds` | DISABLE redaction: always return empty set (private rooms' receipts stay public) | tests/public-receipts-toggle.test.js (4 tests) | CAUGHT | 2/4 fail ("owner flips receipts private" + "private receipts: anonymous 403/404"): private-toggled receipts leaked on /api/public/receipts, /receipts/:id, /receipts/:id.json, sitemap. |
| MUT-08-B | 2026-10-08 | qa200-mut-08 | server/receipts-live.mjs `hiddenReceiptIds` | WRONG-FIELD redaction: invert the returned hidden set at the source (`new Set(receiptIds.filter(id => !hidden.has(id)))`) | tests/public-receipts-toggle.test.js (4 tests) | CAUGHT | Caveat: the `anyRoomPrivate` fast-path early-returns an empty set in the default state, so this mutant only fires when a room is private — the "over-redact public" half never executed. The private-state tests (3,4) fail: private receipts leak on feed/detail/sitemap. Under-redaction boundary is asserted; over-redaction of default-public receipts is untested by this mutation shape. |
| MUT-08-C | 2026-10-08 | qa200-mut-08 | scripts/room `scan_task_rows` (jq filter) | SCAN MISS: flip the 24h-SLO cutoff comparison `< $cut` to `> $cut` so no overdue completed-no-receipt task is flagged | tests/room-watch-enforcer.test.sh (66 cases) | CAUGHT | 4 new failures vs baseline: h "flags the bare done (918)", b "unclosed claim is still flagged (903)", b2 "promise language does not close the digest (908 flagged)", r "fabricated backfill receipt is still flagged (931)". Baseline pre-existing failures unchanged (a2 x2, d, i x2). |
