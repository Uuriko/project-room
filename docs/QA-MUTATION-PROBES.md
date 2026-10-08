# QA Mutation Probes

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
