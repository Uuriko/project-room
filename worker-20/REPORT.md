# WAVE-2000 guild-02 — worker-20 report (shard 19/50)

**Scope.** Route handlers in `server/http.mjs` at sorted dispatch positions where `(index mod 50)==19`
(dispatch lines = `if/else if (... url.pathname ...)` in file order). Shard members:

- **A** — `GET /api/oauth/sessions` (http.mjs:1598) — list the signed-in account's OAuth token families; cookie-auth required, returns 401 without.
- **B** — `POST /api/guest-agent-links/preview` (http.mjs:2434) — public guest-agent link preview; strict Origin required, bounded JSON body, exact-shape `{"linkToken"}` envelope.

**Method.** Local server booted on 127.0.0.1:4550 with isolated DB (`worker-20`-scoped, `--allow-unsigned`),
boot ~11s, `/api/health` 200. Two fuzz rounds, 56 cases total, live against the running server.
Fuzz covered: cookie malformations (empty/garbage/10KB/SQLi/unicode), method variants
(POST/PUT/DELETE/PATCH/HEAD/OPTIONS), path edges (trailing slash, uppercase, 20k-char suffix,
128-char DELETE :id, 200-char :id, encoded slashes), Origin edges (missing/evil/"null"/trailing-slash),
body edges (wrong/missing content-type, charset suffix, invalid JSON, empty, array, null, string,
trailing garbage, duplicate keys, 20KB oversize), token edges (missing/extra keys, null/number/bool/
array/object linkToken, prefix-only, invalid chars, well-formed-but-unknown ga1 token,
human-share-shaped token, 100KB token, unicode token, proto-pollution keys, nested bodies).

**Result: CLEAN — 0 findings.** All 56 cases returned expected statuses, no 5xx, no hangs, no crashes;
server stayed alive (health 200 after each round). Notable behaviors, all correct-by-design:

- Unauthenticated `GET /api/oauth/sessions` → 401 `account_session_required` (garbage/long/malformed cookies too).
- Wrong methods on both paths → 404 fall-through (no 405 — consistent with the app's dispatch style).
- Preview Origin gating: missing/foreign/"null"/trailing-slash Origin → 403 `origin_denied` (strict, before rate).
- Non-object JSON bodies → 400 `invalid_json`; wrong/missing content-type → 415; >16KB body → 413 `too_large`.
- Extra/missing keys → 422 `invalid_link`; non-string linkToken → 410 `link_unavailable` (type-safe via `classifyJoinToken`); human-share-shaped token → 422 `wrong_link_kind`.
- 100KB token → 413 at body limit (no hang); 20k path → 431; slow-client bounds exist (`requestTimeout=15000`, `headersTimeout=10000` at http.mjs:5029-5031).

No fail-first tests written: mission rule is findings → repro + test; there were no findings to pin.

**Files (worker-20/):**
- `fuzz.mjs` — round-1 harness (43 cases)
- `fuzz2.mjs` — round-2 edge harness (13 cases)
- `fuzz-results.json`, `fuzz2-results.json` — full per-case records (status, code, ms)
- `REPORT.md` — this file

**Environment note for the guild:** backgrounded `node server.mjs` processes get SIGTERM'd ~15 min
after launch when started via plain `exec background:true`; the surviving pattern used by sibling
workers is `setsid nohup env ... node server.mjs ... & disown` (server kept listening, but was
reaped from the launching session anyway when issued through a single exec — relaunch survived
once the session stayed warm). My instance (PORT 4550, lock `.tmp/w20-instance.lock`) was stopped
after the run; port free. Also: first boot attempt hit the shared-instance lock — used a
per-worker `ROOM_INSTANCE_LOCK_PATH`.
