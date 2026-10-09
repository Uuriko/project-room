# WORKER 8 — RESULTS (WAVE-2000 GUILD-02, 2026-10-09)

## Shard
- `server/http.mjs:1214` — `POST /api/auth/email/verify/resend` (resend verification email; authed, per-account rate limit 5)
- `server/http.mjs:2398` — `POST /api/account/delete` (irreversible account deletion; authed, confirmationToken from `GET /api/account/deletion/plan`, per-IP rate limit 5)

## Method
Local fuzz against a booted acceptance-fixture server (`createAcceptanceFixture` +
`createRoomServer`), reusing `fuzz/adversarial.mjs` case generators: method matrix
(PUT/DELETE/PATCH/OPTIONS/TRACE), malformed JSON battery, invalid-UTF8 body,
query abuses, header abuses (foreign/missing Origin, bad CSRF, oversized
cookie/header), auth edges (no/garbage cookie), and route-specific edges
(token type/value tampering, delete→replay, plan-after-delete). ~120 cases.
No crashes, no hangs, no 5xx, no stack-trace leaks.

## Finding W8-1 (real, fail-first test FAILS as designed)
**`/api/account/delete` rate-limits before auth on a shared per-IP key** —
`server/http.mjs:2401`:
`rate(`account-delete:${remoteAddress}`, 5)` runs BEFORE `requireAccountSession()`.
Five anonymous POSTs from one IP (only a valid `Origin` header needed, no
session) burn the 5/min bucket for everyone behind that IP/NAT/VPN exit: a
legitimate, authenticated, CSRF-valid delete then gets 429 for a minute.
Sibling routes do it right: `/api/account/deletion/plan` (:2386) calls
`requireAccountSession()` first, and `/api/auth/email/verify/resend` (:1233)
keys the bucket per-account after auth. Suggested fix: key on
`session.account.id` after auth (mirror the resend route), or move `rate()`
below `requireAccountSession()`. Severity: low (1-minute lockout), but it is a
pre-auth remotely-triggerable lockout of a deletion right.

Repro (minimal, deterministic):
`worker-8/rate-limit-ordering.test.mjs` — `node --test` from the worktree root:
signs up, takes a plan token, fires 5 anonymous POST /api/account/delete, then
asserts the legitimate delete is 200. Currently fails with 429
(`rate_limited`) on the final delete. Verified 2026-10-09 ~09:30 PDT.

## Verified non-issues (looked suspicious, checked, clean)
- Raw `TRACE` -> 403 (not 405): global host gate `http.mjs:937`
  (`host_denied` — probe used `Host: x`). Deliberate, not a bug.
- Method matrix PUT/DELETE/PATCH/OPTIONS on both routes -> 405 correct.
- All delete-token type edges (missing/empty/number/null/array/object) -> 422.
  Garbage/tampered/100k/prototype-polluted tokens -> 4xx.
- Delete -> replay same token -> 401 (session invalidated). Plan-after-delete -> 401.
- Resend per-account bucket: 7 rapid resends -> [503 x5 (mailer unconfigured in
  test env — expected), 429, 429]. Correct per-account gating.
- Auth edges on both routes: no cookie -> 401, garbage cookie -> 401,
  foreign origin -> 403, missing/wrong CSRF -> 403.

## Files
- `shard.txt` — shard definition
- `fuzz-shard-8.mjs` — round-1 fuzz script (method/auth/body/rate-limit sweeps)
- `findings.json` — round-1 findings (rate-limit artifacts + TRACE artifact only)
- `fuzz-shard-8-round2.mjs` — round-2: delete validation edges in rate-safe batches
- `findings-round2.json` + `round2.log` — round-2 results: 0 findings
- `rate-limit-ordering.test.mjs` — FAIL-FIRST test for W8-1 (currently fails, 429 != 200)
- `RESULTS.md` — this file

## Status
SHARD COMPLETE — 1 real finding (W8-1, fail-first test provided), 0 crashes/hangs/5xx.
No git commits made; no room posts; no PRs.
