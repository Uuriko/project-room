# WORKER 41 report — shard 41/50, server/http.mjs route fuzzing

## Shard
Literal `app.(get|post|put|patch|delete|use)` grep: **0 matches** in this codebase —
routes dispatch via `if (url.pathname === "...")`. Adapted shard: all
`url.pathname === "..."` literals in `server/http.mjs`, sorted by line,
(index mod 50) == 40 (worker 41). 2 routes:

1. `server/http.mjs:2181` — `POST /api/auth/recovery-codes/redeem`
2. `server/http.mjs:3105` — `POST /api/access-requests`

(+ its companion 405 branch at :3111, exercised in phase D.)

## Method
- Server booted locally per phase (`RoomStore` in `$worktree/.tmp`, `createRoomServer`,
  `127.0.0.1` ephemeral port); fresh server per phase to reset the in-memory
  rate buckets (redeem: 10/min, access-requests: 20/min per address).
- `fuzz.mjs`: 45 cases in 4 phases — malformed JSON, non-object JSON, `__proto__`,
  deep nesting, bad field types, huge values, oversized bodies (>16KB cap),
  missing/wrong content-type, null bytes, wrong methods, origin/header spoofing,
  host mismatch, query junk, duplicate requestId (idempotency).
- No process crashes. No 5xx on any case. All malformed input answered with
  typed 4xx (400/401/403/405/413/415/422) as designed.

## Finding W41-001 (real bug, connection-level)
**`server/http.mjs:4989` + `server/http.mjs:821-822` — keep-alive request sent
immediately after an oversize-body 413 is swallowed and its socket destroyed.**

Mechanism:
1. `:821-822`: a POST whose declared `Content-Length` exceeds the 16KB body cap
   throws `413 too_large` *before* the body is read; the 413 is sent on a
   keep-alive connection (Node 19+ clients keep-alive by default).
2. `:4989+`: the 413 drain handler tries to keep the socket alive while draining
   the unread body. But the client may legally send the next request as soon as
   the 413 response ends; the server cannot distinguish those bytes from the
   still-in-flight oversize body, so they are consumed as body bytes. When the
   declared byte count is reached the socket is ended — the follow-up request is
   never parsed and the client sees `socket hang up`.
3. Verified: the server never logs the second request; deterministic 3/3 runs,
   on both shard routes (redeem B8→B9, access-requests D10→D11). With a 1.5s gap
   the same follow-up returns the correct 405. Correct fix: on a 413 with an
   unread body, send `Connection: close` and close the socket after draining
   instead of attempting keep-alive reuse.

Minimal repro: `worker-41/repro-seq.mjs` (oversize POST → empty POST back-to-back
on one keep-alive agent; second request → `socket hang up`).
Fail-first test: `worker-41/keepalive-413.test.mjs` — currently FAILS
(`REQ-ERR: socket hang up`, expected HTTP 405); run with
`node --test worker-41/keepalive-413.test.mjs` from repo root.

Impact: any keep-alive client (Node 19+ default) that overshoots the body cap
and retries immediately loses its retry to a dead socket. Low-medium; no data
corruption, but a spurious connection error for legitimate clients. The 413
itself and the retry-after-delay path are correct.

## Non-findings (checked, working as designed)
- A8/A9: bad field types on redeem return 401 (slot check) before 422 (field
  validation) — `signInSlotToken` runs first by design, not a bug.
- B3/B4: wrong methods on redeem → 404, while access-requests → 405 with
  `Allow: POST`. Cosmetic inconsistency only.
- D11 X-Forwarded-For spoof: returns 405 (proxy not trusted, header ignored) —
  correct; the earlier socket hang-up there was the W41-001 sequence effect.
- D8 `//api/access-requests` → 404; D12 host mismatch → 403 `host_denied`; B1/B2
  origin gate → 403 `origin_denied`. All correct.
- Duplicate `requestId` (C11/C12) idempotent, no 500.

## Files (all under `worker-41/`, no commit, no push, zero room posts)
- `fuzz.mjs` — 45-case harness (results: `results.json`)
- `repro.mjs`, `repro-seq.mjs`, `repro-inst.mjs` — minimal/sequence/instrumented repros
- `keepalive-413.test.mjs` — fail-first regression test (FAILS on current code)
- `results.json` — full 45-case result log
- `report.md` — this file
