# WORKER-15 — shard report (WAVE-2000 GUILD-02, slice server/http.mjs)

## Shard computation
The task's literal grep (`app.(get|post|put|patch|delete|use)\(`) matches **zero**
lines in `server/http.mjs` — routes left the legacy `app.*` style and now live
as (a) a declarative route table (`server/routes/table.mjs`, dispatched via
`dispatchRoute`) and (b) the remaining legacy `if (url.pathname === ...)` chain
in `server/http.mjs`. Following worker-9's precedent (`worker-9/shard.txt`),
the shard universe is the legacy-chain handler lines in `server/http.mjs`:

`grep -n 'if (url.pathname === ' server/http.mjs` → 93 lines → content-sorted
→ 0-based indices → `(index mod 50) == 14` → indices **14** and **64**.

Raw/sorted enumerations: `worker-15/shard-raw.txt`, `worker-15/shard-sorted.txt`.

## Shard handlers
- **H1** `POST /api/account/onboarding/complete` — `server/http.mjs:2373`
  (method-gated POST; `checkOrigin(req,true)`; rate 30/min/address;
  `requireAccountSession`; `protectWrite`; `store.completeOnboarding`; no body read)
- **H2** `POST /api/referral-invites/mint` — `server/http.mjs:2973` (+405 guard :2988)
  (rate 20/min/address; bearer required 401; exact-field body validation 422;
  `store.referralInvites.mint`; always 201, `duplicate:true` on requestId replay —
  contract locked by `tests/referral-mint-idempotency.test.js:53-54`)

## What was run
- `worker-15/directed-fuzz.mjs` — 96 authenticated adversarial cases over H1+H2
  (auth matrix, origin/CSRF, method matrix incl. TRACE/PROPFIND-style, malformed/
  huge/unread bodies, query/pathology, idempotency replay+conflict, requestId
  shape validation, maxDepth edges, proto-pollution, rate-limit bursts).
  Local loopback servers (acceptance fixture + bootstrap store). No crashes, no hangs.
- `worker-15/directed-fuzz2.mjs` — 13 re-runs of H2 cases masked by the 20/min
  rate limiter, on fresh servers (≤12 cases/boot). Results: `results-h2b.json`.

Raw results: `worker-15/results.json`, `worker-15/results-h2b.json`.

## Findings: none genuine (0 crashes, 0 hangs, 0 500s)
Four apparent anomalies were investigated and resolved as non-bugs:
1. `h1:trailing-slash` → 200 (expected 404): intended trailing-slash
   normalization, already verified-good in guild `fuzz/FINDINGS.md`.
2. `h1:trace` → client-side `TypeError`: node `fetch` does not support TRACE;
   the request never reached the server. Harness artifact.
3. 13× `h2:*` → 429 `rate_limited`: the 20/min per-address limiter working as
   designed; re-run clean on fresh servers.
4. `h2:idempotent-retry` → 201 (expected 200): intended — HTTP status is always
   201, replay signaled by `duplicate:true`; contract asserted in
   `tests/referral-mint-idempotency.test.js:53-54`.

## Verified-good (this shard)
- Auth: no-cookie/bogus/empty-cookie → 401; no-CSRF/bad-CSRF → 403;
  no/foreign Origin → 403 (H1); no/garbage/empty bearer → 401 (H2).
- Body validation (H2): missing/non-string/object/array roomId → 422;
  maxDepth string/0/negative/fraction/bool/null → 422; extra field → 422;
  `__proto__` payload → 422; requestId short/bad-chars/non-string → 422;
  malformed JSON → 400; 2MB body → 413 naming actual vs limit bytes.
- Idempotency (H2): same requestId replays the identical deterministic token
  (`duplicate:true`); different maxDepth → 409
  `referral_mint_idempotency_conflict`.
- Unknown/nonexistent roomId (H2): clean 4xx, no 500, no leak.
- Rate limits (H1 30/min, H2 20/min): 429 tail after budget, never 500.
- Method matrix (H1+H2): GET/PUT/DELETE/PATCH/HEAD/OPTIONS → 405 with `Allow`.
- Unread-body tolerance (H1): 2MB body on a handler that never reads the body
  → 200, no hang.

## Files
- `worker-15/directed-fuzz.mjs`, `worker-15/directed-fuzz2.mjs` — harnesses
- `worker-15/results.json`, `worker-15/results-h2b.json` — raw case results
- `worker-15/shard-raw.txt`, `worker-15/shard-sorted.txt` — shard enumeration
- `worker-15/SHARD.md` — this report
