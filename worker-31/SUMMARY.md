# WORKER 31 — API fuzzing report

Shard: `(index mod 50) == 30` over sorted `url.pathname === "/..."` dispatch
lines in `server/http.mjs` (http.mjs is a raw `if`-dispatcher, not
`app.get(...)`; this is the faithful equivalent of the task's grep).

- Main checkout `~/workspace/project-room`: 96 dispatch lines → NR 31, 81:
  `GET /templates` (+`/templates.json`), `POST /api/referral-invites/mint`
- Guild worktree checkout: 98 dispatch lines → NR 31, 81:
  `GET /agents`, `POST /api/agent-invites/redeem`
- The two checkouts disagree, so all four routes were fuzzed locally
  (fresh isolated DB per run, `ROOM_DB=$worktree/.tmp/w31*-room.sqlite`).

## Results: 4/4 routes fuzzed, 0 crashes, 0 hangs, 0 HTTP 500s

### 1. GET /templates, /templates.json (public)
- GET/HEAD → 200, correct content types (html / json)
- POST/PUT/PATCH/DELETE/OPTIONS → 405
- `/TEMPLATES` → 404 (case-sensitive); `/templates/` → 200 (deliberate
  trailing-slash strip, http.mjs:952); `/templates.json.json` → 404
- `?ref=` with 5k chars, encoded `../`, `<script>` payload → 200, no
  unescaped reflection in HTML
- Accept header does not flip representation (fine)

### 2. POST /api/referral-invites/mint (bearer-gated, 20/min/IP)
- No auth → 401; malformed `Authorization` → 401 "Invalid Authorization header"
  (shape regex at http.mjs:717)
- Well-formed (43-char) but unknown secret + valid body → 401 "Session or key
  expired or revoked" (store rejects before minting)
- Bad shape (missing/extra/wrong-type fields) → 422 `invalid_invite`
  (message correctly names optional `requestId` per #2263)
- Non-object / malformed / empty JSON → 400 `invalid_json`; wrong methods → 405
  with `Allow: POST`; >20 POSTs/min → 429 `rate_limited` (limiter works)
- OBSERVATION (not a bug report): body-shape validation runs before the
  store auth check, so 422-vs-401 reveals body-shape validity to an
  unauthenticated caller. Standard validation-first design + rate-limited;
  noted, no test written.

### 3. GET /agents (public)
- GET/HEAD → 200 HTML; POST/PUT/DELETE → 405
- `/agents/` → 200 (trailing-slash strip); `/AGENTS` → 404
- `?cursor=` 3k chars → 422 (cursor validated); XSS `ref` → 200, not reflected

### 4. POST /api/agent-invites/redeem (unauthenticated, 20/min/IP)
- Bogus/wrong-format code → 404 `invite_unavailable` with format hint
  ("two letters, a dash, then 16 chars")
- Wrong types → 422 with per-field diagnosis (`code: wrong type`);
  missing fields → 422 naming them; extra field → 422 naming it
  (the Colony round-2 diagnoseArguments fix is live)
- Array/malformed/empty body → 400 `invalid_json`; text/plain → 415
  `json_required`; wrong methods → 405 `Allow: POST`

## Environment notes
- Two of my local server instances were SIGTERM'd by an unknown external
  actor 35s/96s after boot (no crash trace in logs); other workers' servers
  survived. Workaround: boot → health-poll → fuzz → kill inside one exec.
- All workers share 127.0.0.1, so per-IP rate limiters are shared across
  workers' fuzz traffic (my mint run self-triggered 429s).
- No fail-first test written: no crash/hang/wrong-status found.

## Files
- `worker-31/fuzz-31.mjs` — templates + mint (malformed-bearer) fuzz
- `worker-31/fuzz-31-mint.mjs` — mint with well-formed-but-unknown bearer
- `worker-31/fuzz-31b.mjs` — /agents + agent-invites/redeem fuzz
- `worker-31/fuzz-31-results.json`, `fuzz-31-mint-results.json`,
  `fuzz-31b-results.json` — raw results
- `worker-31/SUMMARY.md` — this file
