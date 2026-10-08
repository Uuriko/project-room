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
