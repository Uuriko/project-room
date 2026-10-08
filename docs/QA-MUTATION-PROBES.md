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

## Probes recorded by #2037

Recorded probes across the 2026-10-08 QA200 mutation wave. Rows are append-only;
never re-probe a recorded CAUGHT row — write a new row if the target changes.

Format: `| probe | target / mutation | result | worker | date | notes |`

| probe | target / mutation | result | worker | date | notes |
|-------|-------------------|--------|--------|------|-------|
| file-lease A | `fileLeaseConflicts` forced to return `[]` (declared overlaps pass undetected) | CAUGHT | qa200-mut-26 | 2026-10-08 | 4 failures across work-claim-files + work-claim-guards; tests distinguish declared vs undeclared overlap |
| file-lease B | 409 `file_lease_conflict` body stripped to generic 409 (no holder/expiry) | CAUGHT | qa200-mut-26 | 2026-10-08 | 5 failures; tests assert holder claimId/owner, conflicting files, and leaseExpiresAt |
| file-lease C | `update` allowed to change declared `files` after claim (was 422-immutable via shape) | UNCAUGHT → hardened | qa200-mut-26 | 2026-10-08 | All 16 file-lease tests passed with the break. Hardening test added: "update cannot change the declared files after claim (files are immutable)" in tests/work-claim-files.test.js — verified red-with-break / green-without. PR #2037 |

## Probes recorded by #2032

Mutation-testing ledger for the QA wave (fail-first probes). Each row is one
probe: the mutation applied, whether existing tests caught it, and the
outcome. Workers: never re-probe a row marked CAUGHT.

Columns: probe id · target file · mutation · tests run · caught? · hardening

| Probe | Target | Mutation | Tests | Caught? | Hardening |
|---|---|---|---|---|---|
| MUT-15 A | server/claim-coordination.mjs | added `"done"` to `LIVE_CLAIM_STATES` (double-settle allowed) | tests/claim-settle-1526.test.js, tests/work-claim-batch-outcome.test.js, tests/work-claim-settle-missing-link.test.js (15 tests) | **UNCAUGHT** (15/15 green under mutation) | tests/work-claim-settle-double.test.js — red with break (1 fail), green without (2 pass); PR #2032 |
| MUT-15 B | server/claim-coordination.mjs | `pullsReadyToSettle` forced to `return true` (missing/invalid pull-link guard bypassed) | same settle suite (15 tests) | **CAUGHT** (1 fail: claim-settle-1526 asserts `pullsReadyToSettle` is false with only open links) | none needed; mutation reverted |
| MUT-15 C | server/bounty-escrow.mjs | duplicated the refund `_move` leg in `rejectWork` (funds move twice) | tests/bounty-free-miss.test.js (12 tests) | **CAUGHT** (5 fail: balance conservation, no-new-journal-rows, single settlement event) | none needed; mutation reverted |

## Probes recorded by #2040

Append-only ledger. One row per probe. Never re-probe a recorded CAUGHT row.

Columns: probe | date | worker | target | mutation | tests run | result | notes

| probe | date | worker | target | mutation | tests run | result | notes |
|---|---|---|---|---|---|---|---|
| MUT-08-A | 2026-10-08 | qa200-mut-08 | server/receipts-live.mjs `hiddenReceiptIds` | DISABLE redaction: always return empty set (private rooms' receipts stay public) | tests/public-receipts-toggle.test.js (4 tests) | CAUGHT | 2/4 fail ("owner flips receipts private" + "private receipts: anonymous 403/404"): private-toggled receipts leaked on /api/public/receipts, /receipts/:id, /receipts/:id.json, sitemap. |
| MUT-08-B | 2026-10-08 | qa200-mut-08 | server/receipts-live.mjs `hiddenReceiptIds` | WRONG-FIELD redaction: invert the returned hidden set at the source (`new Set(receiptIds.filter(id => !hidden.has(id)))`) | tests/public-receipts-toggle.test.js (4 tests) | CAUGHT | Caveat: the `anyRoomPrivate` fast-path early-returns an empty set in the default state, so this mutant only fires when a room is private — the "over-redact public" half never executed. The private-state tests (3,4) fail: private receipts leak on feed/detail/sitemap. Under-redaction boundary is asserted; over-redaction of default-public receipts is untested by this mutation shape. |
| MUT-08-C | 2026-10-08 | qa200-mut-08 | scripts/room `scan_task_rows` (jq filter) | SCAN MISS: flip the 24h-SLO cutoff comparison `< $cut` to `> $cut` so no overdue completed-no-receipt task is flagged | tests/room-watch-enforcer.test.sh (66 cases) | CAUGHT | 4 new failures vs baseline: h "flags the bare done (918)", b "unclosed claim is still flagged (903)", b2 "promise language does not close the digest (908 flagged)", r "fabricated backfill receipt is still flagged (931)". Baseline pre-existing failures unchanged (a2 x2, d, i x2). |

## Probes recorded by #2044

Ledger of mutation-testing probes against Project Room. Workers append rows;
never re-probe a row marked CAUGHT or UNCAUGHT (UNCAUGHT rows carry a
hardening test that now guards the behavior).

Columns: `worker` | `target` | `probe` | `mutation` | `result` | `hardening test`.

| date | worker | target | probe | mutation | result | hardening test |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-08 | qa200-mut-13 | `server/account-login-methods.mjs` `consumeEmailVerifyCode` | A: skip a verification step (any 6-digit code accepted) | dropped `constantTimeDigestEqual` from the code-row match | **UNCAUGHT** — 28/28 tests passed with the break (`tests/account-login-methods.test.js`, `tests/share-links-email-gate.test.js`, `tests/agent-invites-mail-unconfigured.test.js`) | `consumeEmailVerifyCode rejects a wrong code without verifying the email` — verified red-with-break, green-without |
| 2026-10-08 | qa200-mut-13 | `server/account-login-methods.mjs` `findAccountByOAuth` | B: allow login with a disabled method (removed the `disabled=0` filter; `server/http.mjs` `linkGitHubSubject`/`linkGoogleSubject` drive OAuth login through this lookup) | dropped `AND disabled=0` so a disabled OAuth method still resolves its account | **UNCAUGHT** — 31/31 tests passed with the break | `findAccountByOAuth ignores disabled OAuth methods` — verified red-with-break, green-without |
| 2026-10-08 | qa200-mut-13 | `server/account-login-methods.mjs` `resetPassword` | C: account-existence oracle (distinct `account_not_found` code for unknown email, same message) | early `fail(401, "account_not_found", ...)` when `passwordResetAccount` returns null | **CAUGHT** — `tests/password-reset.test.js` `invalid()` helper pins `error.code === "invalid_password_reset"` | none needed |
| 2026-10-08 | qa200-mut-13 | `server/account-login-methods.mjs` `consumeMagicCode` | C: account-existence oracle (distinct `unknown_magic_email` code when no live code exists for the email, same `That code is not valid` message) | branch before the generic `invalid_magic_code` failure | **UNCAUGHT** — 35/35 tests passed with the break (existing tests assert only the `/not valid/` message) | `consumeMagicCode failures are uniform: no oracle by error code` — verified red-with-break, green-without |

Notes:
- All probes ran at the model layer via `node --test`; no browser work needed.
- The C1/C2 contrast is informative: the reset path pins uniform error *codes*
  (`invalid()` in `tests/password-reset.test.js`), while the magic-code path pins
  only the message. Uniformity of failure codes is now pinned for both.
- Out of scope per brief (not probed): OAuth code reuse, spend void-after-settle,
  writer-fence tamper, permission-upgrade `review()`.

## Probes recorded by #2036

Mutation-testing ledger for John's 200-agent QA wave (2026-10-08). One row per
probe: the mutant applied, whether the existing suite caught it, and any
hardening test added (verified red-with-break / green-without before the
mutant was reverted).

| Date (PDT) | Worker | Probe | Target | Mutant | Existing suite | Hardening test | Verdict |
|---|---|---|---|---|---|---|---|
| 2026-10-08 | qa200-mut-17 | A: double release (double-pay) | server/bounty-escrow.mjs `_approvedMillis` (double-entry netting backstop) | gross-only netting (`AND amount > 0`) — a re-sweep would find 500 millis "approved" and pay again | 38/38 green — **UNCAUGHT** | tests/bounty-escrow-release-probes.test.js: "double-pay backstop: swept lots net to zero" — red with mutant, green without | Behavior safe via layered guards (paid state transition + netting); netting layer now pinned. Also pinned: second closeEpoch is a payout no-op. |
| 2026-10-08 | qa200-mut-17 | B: release to wrong recipient | server/bounty-escrow.mjs `_sweep` payout credit | payout credited to `bounty.poster` instead of `bounty.claimant` | 3 failures in tests/bounty-escrow.test.js — **CAUGHT** | — (worker-balance assertions + paid-event earner already pin recipient identity) | CAUGHT. Probe pinned recipient identity in new test file ("payout credits the claimant's ledger account") as documentation. |
| 2026-10-08 | qa200-mut-17 | C: release for disputed bounty | server/bounty-escrow.mjs `_requireFinalityMove` (finality_frozen gate) | freeze gate removed | tests/bounty-tracks.test.js "illegal transitions are rejected on both tracks" fails — **CAUGHT** | — (integration behavior pinned in new test file; "a disputed bounty cannot be swept or paid while the dispute is open") | CAUGHT. Note: integration behavior is redundantly blocked by `missing_verdict` (payout requires state "approved") even with the gate removed — defense-in-depth holds. |

Probe notes (qa200-mut-17, 2026-10-08):
- Probe A layering: re-release is blocked first by the `approved -> paid` state transition (pinned by the existing sweep test's `state === "paid"` assertion) and second by double-entry netting. The netting was the unpinned layer; the new white-box test pins it.
- Probe B: recipient identity is pinned three ways — worker balance (existing), journal credit account (new), paid-event `earner` (new).
- Probe C: `finality_frozen` is unit-pinned; the keeper path needs no extra guard because `_keeperPass` on a disputed bounty never reaches `_sweep` (only "approved" bounties sweep in `closeEpoch`).
