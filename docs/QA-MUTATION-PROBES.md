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

## Probes recorded by #2035

Living ledger for QA200 mutation-testing workers probing the work-claim
renew path (`server/work-claims.mjs`, `server/work-claim-routes.mjs`).
Append rows; never re-probe a row marked CAUGHT.

| Probe | Worker | Date (PDT) | Mutation | Existing tests catch? | Verdict |
|---|---|---|---|---|---|
| MUT-04-A | qa200-mut-04 | 2026-10-08 | renew w/o progressMessageId force-upgrades lease to 24h room default instead of keeping original duration | No — `tests/lease-renewal.test.js` pins the behavior ("the room's default 24h") | **UNCAUGHT — footgun LIVE**. Hardening test `tests/work-claim-renew-probes.test.js` MUT-04-A (kept `test.skip`; fails on current code). |
| MUT-04-B | qa200-mut-04 | 2026-10-08 | renew extends from now instead of old expiry (15-min lease renewed at +6min with 1h → now+1h, stealing ~9min) | No — `tests/lease-renewal.test.js` pins it ("starts a fresh lease window from now") | **UNCAUGHT — footgun LIVE**. Hardening test MUT-04-B (kept `test.skip`; fails on current code). |
| MUT-04-C | qa200-mut-04 | 2026-10-08 | allow renew of an indefinite (null-lease) claim | Yes — pure test "renewWork refuses a foreign owner, a non-active claim, a leaseless claim, and a lapsed lease" + route test "handler: renew of a leaseless claim is refused" both fail (422 `invalid_claim_input`) | **CAUGHT** |

## Notes

- Probe A/B footguns are **already the shipped behavior**, not seeded bugs:
  `renewWork` computes `leaseStartAt = now`, `leaseExpiresAt = now + (leaseHours ?? 24h)`.
  The hardening tests document the probe-semantics (playbook §4d) and are
  red-on-current by design; they are `test.skip`ped so CI stays green.
  Deciding the intended renew semantics (fresh window from now w/ default
  vs. keep original duration / extend from old expiry) is a design call for
  the coordinator — the tests here are the fail-first record, not the fix.
- Fail-first verification for MUT-04-A/B: probe tests fail on current code
  (red), pass under a probe-semantics patch (green-without), patch reverted.
- Probe C detail: removing only the null-lease guard does NOT create the
  footgun — the lapsed-lease check (`Date.parse(null) > now` → false) still
  blocks it, just with the wrong message. The faithful "allow it" mutation
  also skips the lapse check for null leases; then 2 existing tests fail.
- Skipped by brief: OAuth code reuse, spend void-after-settle,
  writer-fence tamper, permission-upgrade review().

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

## Probes recorded by #2045

Fail-first mutation probes against Project Room: deliberately break the server,
run the relevant tests, and record whether the suite caught the break.

## Already probed by other workers (do NOT re-probe)

| seq | date | target file | mutation applied | test file(s) | CAUGHT/UNCAUGHT | notes |
|---|---|---|---|---|---|---|
| MUT-00-001 | 2026-10-08 | auth/oauth (code reuse) | OAuth code reuse allowed | — | SKIPPED | already probed by another worker |
| MUT-00-002 | 2026-10-08 | spend settle | spend void-after-settle | — | SKIPPED | already probed by another worker |
| MUT-00-003 | 2026-10-08 | server/writer-fence.mjs | writer-fence tamper | — | SKIPPED | already probed by another worker |
| MUT-00-004 | 2026-10-08 | permissions review() | permission-upgrade review() check | — | SKIPPED | already probed by another worker |

## QA200-MUT-01 probes (work-claim routes: create idempotency + per-identity cap)

Coordinator-reported rows (2026-10-08; workers safety-paused before full reports; mutations reverted by coordinator; trees verified clean; claims released):

| seq | date | target file | mutation applied | test file(s) | CAUGHT/UNCAUGHT | notes |
|---|---|---|---|---|---|---|
| MUT-06 | 2026-10-08 | server/bounty-receipts.mjs | MUTATION-B: `.filter(k => k !== "payload")` in canonicalJson's object branch — payload excluded from signed bytes (signature-forgery-class weakening) | — | outcome UNCONFIRMED | worker's tool use paused before pass/fail reported; coordinator reverted mutation, worktree clean |
| MUT-03 | 2026-10-08 | server/work-claim-routes.mjs | probe A: replaced `const authority = authorityOver(item);` with `const authority = true;` in the /release handler (non-owner release allowed) | — | outcome UNCONFIRMED | worker's tool use paused before outcome reported; coordinator reverted mutation, worktree clean |
| MUT-04 | 2026-10-08 | claim RENEW | (probe completed) | — | outcome UNCONFIRMED | coordinator sweep found no leftover mutation; worktree clean |
| MUT-07 | 2026-10-08 | bounty receipts | (probe completed) | — | all CAUGHT (per worker's final preview) | reported "no PR (all caught)"; worktree clean |

Claims released by coordinator: qa200-mut-03-claim-release, qa200-mut-04-claim-renew, qa200-mut-06-receipt-verify, qa200-mut-07-bounty-receipts.

| seq | date | target file | mutation applied | test file(s) | CAUGHT/UNCAUGHT | notes |
|---|---|---|---|---|---|---|
| MUT-01-001 | 2026-10-08 | server/work-claim-routes.mjs (create route) | duplicate CREATE returned 200 with the existing claim instead of 409 work_claim_exists | tests/work-claim-*.test.js, tests/claim-*.test.js, tests/public-work-claim*.test.js (existing) + tests/work-claim-idempotency.test.js (new) | UNCAUGHT | 331 existing tests stayed green with the break (incl. board/guards/duplicates/claims/client); only the env-broken yaml import in work-claim-client failed pre-node_modules-symlink. Hardening test "duplicate CREATE returns 409 work_claim_exists and leaves the claim unchanged" verified RED with break (200 !== 409), GREEN after revert. |
| MUT-01-002 | 2026-10-08 | server/work-claim-routes.mjs (create route, assignee branch) | per-identity cap check weakened to `held >= config.maxMemberOpenClaims + 1000` (cap never refuses on CREATE-with-assignee) | tests/work-claim-board.test.js, tests/work-claim-guards.test.js, tests/work-claims.test.js, tests/work-claim-duplicates.test.js, tests/work-claim-reassign-unclaimed.test.js, tests/work-claim-client.test.js (existing) + tests/work-claim-idempotency.test.js (new) | UNCAUGHT | 67 existing tests stayed green with the break. Existing cap coverage (board.test.js:140, guards.test.js:107) only pins the claim-route cap, not the CREATE-with-assignee cap. Hardening test "CREATE with assignee refuses 409 too_many_open_claims when the assignee is at cap" verified RED with break (201 accepted), GREEN after revert. |

## Probes recorded by #2052

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
