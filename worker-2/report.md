# WORKER 2 — shard 2/50 report (API fuzzing, local only)

- Mode: normal worker (guild.log has no GUILD DONE).
- Shard: dispatch lines in `server/http.mjs` matching `if (url.pathname…`, 0-based
  indices 1, 51, 101 → **L953** (writeSecurityTxt: `/.well-known/security.txt`,
  `/security.txt`, `/room/.well-known/security.txt`), **L2317**
  (`/api/auth/github/link/start`), **L3170** (`/api/updates` GET/HEAD).
- Harness: throwaway sqlite store + `createRoomServer` on 127.0.0.1, never production.
  Real identity secret + real account (via `/api/auth/password/signup`) used to reach
  authenticated branches. Per-request 6s timeout; 4 raw-socket malformed-HTTP attacks.
- Volume: 69 + 24 + 13 probes + 4 raw-socket + header checks. **0 crashes, 0 hangs.**
  Server survived garbage request lines, missing CRLF, 20KB header (431), null bytes.

## Findings

### F-W2-01 (minor, RFC 9110 §15.5.6) — FAIL-FIRST TEST WRITTEN, FAILS NOW
`405` from `/api/auth/github/link/start` (**server/http.mjs:2318**) omits the `Allow`
header. The RFC: "the origin server MUST generate an Allow header field in a 405
response." Sibling handlers in the same dispatch table include it
(security.txt → `Allow: GET, HEAD`; `/api/updates` → `Allow: GET`).
Minimal repro: `curl -i -X POST http://127.0.0.1:PORT/api/auth/github/link/start`
→ `405`, no `Allow` header.
Fix (one line, not applied — no-commit rule): pass `{ Allow: "GET" }` as the 4th
arg to `reject(...)` at L2318, matching L3175.
Note: the sibling `/api/auth/google/link/start` (L2335, another worker's shard)
has the identical omission — flagging for that worker, not fixing here.

### Observations (no bug, no test)
- `/api/updates` `limit` accepts hex/octal/binary/scientific via `Number()`
  (`limit=0x10`→16, `0b101`→5, `1e2`→100, `+5`, `%205`→200) — still validated
  1..100 by `parseListQuery` (server/updates.mjs:356). Lenient but safe.
- `/api/updates?auth=bogus` with a Bearer secret → 200 (bearer path ignores the
  `auth` param by design); without a secret → 422 `invalid_auth_mode`. Consistent.
- `/.well-known/security.txt` → 404 `Not found` when `ROOM_SECURITY_CONTACT` unset
  (by design); `securityContactFrom` (L147) rejects newlines and non-mailto/https
  contacts — header-injection safe.
- Authenticated `/api/auth/github/link/start` with GitHub unconfigured → 503
  `github_not_configured` (correct; anonymous callers get 401 first — no config oracle).
- Cookie edge cases all correct: duplicate `account_session` → 401
  `ambiguous_session_cookie`; tampered/truncated → 401 `invalid_session`;
  bad `binding` values → 422 `invalid_session_binding`; wrong-but-wellformed
  binding → 409 `session_binding_changed`.
- All malformed `state/kinds/cursor/limit` combos → 422 with the right code
  (`invalid_updates_query` / `invalid_cursor`); duplicate params → 422.

## Files
- `worker-2/fuzz.mjs` — batch 1: 69 probes (methods, paths, query, headers, forged creds)
- `worker-2/fuzz-auth.mjs` — batch 2: real account session; github/link/start + /api/updates cookie path
- `worker-2/fuzz-binding.mjs` — batch 3: binding variants + raw-socket HTTP abuse + post-abuse liveness
- `worker-2/regress.test.mjs` — 4 tests: F-W2-01 (FAILS now), 3 passing guards
  (`node --test worker-2/regress.test.mjs` → 3 pass / 1 fail)

## Status
Shard complete. 1 minor finding with fail-first test. No commit made. No room posts.
