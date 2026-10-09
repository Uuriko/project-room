# WORKER 33 report — WAVE-2000 guild-02 (shard 33/50)

## Shard derivation
`server/http.mjs` has zero `app.(get|post|…)` registrations — routing is a manual
dispatch chain, so the shard was built from the sorted `url.pathname`/`inboundPath`
dispatch conditions (104 of them, by file order). `(index mod 50) == 32` → conditions
#33 and #83:

- **line 1925**: `GET|HEAD /join.html` and `/room/join.html` → `301` redirect to the
  `.html`-less path (query preserved).
- **line 2846**: `POST /api/web/research` — room knowledge router (plan + evidence).
  Auth: 405 for non-POST, then room-credential auth (401), guest gate (403), CSRF
  for cookie sessions, per-credential rate limit, typed 422/400/415/413 body errors,
  `WebFetchError` mapped to 429/typed statuses, everything else re-thrown.

## Fuzzing (local server, throwaway sqlite DB, port 43331)
Three harnesses, **85/85 cases green. No crash, no hang, no wrong-status found —
no fail-first test warranted** (nothing to guard).

1. `fuzz.mjs` — unauthenticated surface, 30/30:
   - `/join.html` + `/room/join.html`: GET/HEAD → 301 with correct `Location`
     (query preserved, encoded chars preserved); POST/PUT/DELETE/OPTIONS/TRACE →
     404; 1 MB unread POST body → fast 404 (no hang); `/join.html/` → 301 and
     `/api/web/research/` → 401 (both deliberate: QA 2026-10-03 trailing-slash
     normalization at http.mjs:952); `/join.html.html`, `/JOIN.HTML`, `/join.htm`,
     `/join%2ehtml` → 404; 16 KB query → client-side node parser limit (not server).
   - `/api/web/research`: GET/HEAD/PUT/DELETE/OPTIONS → 405; POST without auth →
     401; junk Bearer <redacted> → 401; malformed JSON / 3 MB body / garbage
     content-type without auth → 401 (auth precedes body parsing — intended);
     uppercase path → 404.
2. `fuzz-auth.mjs` — authenticated as room owner (identity → room → agent session →
   `Authorization: Bearer <session-token>`; cookie path verified to require
   `x-csrf-token`, 403 `csrf_denied` without it — intended), 45/45:
   - valid `planOnly` → 200; body edges: empty/malformed/null/array/string/number
     → 400; missing content-type / text/plain → 415; charset-suffixed JSON → 200;
     17 KB body → 413 naming the limit.
   - every `validateResearchInput` field fuzzed: missing/empty/non-string/2001-char
     question → 422 (2000-char → 200); unknown field incl. `__proto__` → 422;
     sources not-array/empty/bogus/[null] → 422, dupes → 200; urls not-array/
     non-string/11 entries → 422, 10 → 200; maxEvidence 0/1.5/"5"/21 → 422,
     20 → 200; maxAgeMs −1/1.5 → 422, 2^53 → 200; tags not-array/21 → 422;
     `planOnly:"yes"` (truthy) → 200 plan; unicode/control-char questions → 200;
     planOnly latency ~60 ms (no hang).
3. `fuzz-exec.mjs` — execution path (planOnly falsy, real legs, local-only), 10/10:
   - fetch leg with loopback URL, closed port, 169.254.169.254, garbage URL →
     200 with `fetch_errors` (SSRF blocklist in `server/ip-blocklist.mjs` holds;
     nothing fetched, no 500); fetch with no urls → 200 skipped; provider leg
     unconfigured → 200 `unconfigured`; all-sources exec → 200 in ~1.1 s;
     repeated execs → 200 (no quota crash).

## Notable intended behaviors confirmed (not bugs)
- Identity secrets and `rak_` API keys 401 on this route because
  `store.authenticate(token, undefined, …)` cannot resolve a room from them —
  **documented** in the comment above `/api/web/fetch` ("use a room Bearer <redacted>
  instead"); `/api/web/research` shares the posture by design.
- `planOnly` is free and bills nothing; execution bills research quota —
  verified no external calls were made (loopback-blocked URLs, no provider key).

## Files
- `worker-33/fuzz.mjs`, `worker-33/fuzz-auth.mjs`, `worker-33/fuzz-exec.mjs` —
  harnesses (runnable against any local server on :43331).
- `worker-33/setup-auth.mjs` — identity → room → agent-session credential setup.
- `worker-33/results.json`, `results-auth.json`, `results-exec.json` — raw results.
- `worker-33/report.md` — this file.

Secrets hygiene: the throwaway DB, session cookie, and identity secrets used for
fuzzing were deleted after the run (`worker-33/.tmp/` is empty); no secrets in
results files. Test server on :43331 stopped. No git commit, no push, no PR,
no room posts — per task rules.
