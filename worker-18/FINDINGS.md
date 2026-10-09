# WORKER-18 fuzz report — server/http.mjs shard (index mod 50 == 17)

## Shard
Enumeration: `grep -nE 'url\.pathname ===? ' server/http.mjs | sort -t: -k2 -n` → 102 matches
(0-based indices 17, 67). Same legacy-chain interpretation as worker-9.
Raw list: `shard-handlers-raw.txt`; shard: `shard.txt`.

| # | line | handler |
|---|------|---------|
| 1 | 1631 | `GET`/`HEAD /api/ready` — readiness probe (200 ready / 503 unavailable) |
| 2 | 2529 | `POST /api/share-links/preview` — public invite-link preview (origin-gated, rate-limited 30/min) |

Note: the task's literal shard spec (`app.(get|post|…)` in server/http.mjs) yields
0 matches — this codebase registers routes via a legacy `if (url.pathname === …)`
chain plus a declarative ROUTES table in server/routes/table.mjs (different guild
slice). The ROUTES-table reading would have given this worker
`POST /api/auth/password/change` and `POST /api/inbox/quarantine/release`;
those live outside guild-02's slice and were NOT fuzzed here.

Also note: worker-9's raw enumeration (107 lines, starts at http.mjs:1073) differs
from mine (102 lines, starts at :207) — shard boundaries are not identical across
workers. Verifier should reconcile.

## Method
Local server on 127.0.0.1:41871, scratch DB `worker-18/data/room.sqlite`
(fresh, no rooms seeded). Two harnesses:
- `fuzz-shard18.mjs` — 34 baseline + malformed-input probes
- `fuzz-shard18-round2.mjs` — 36 edge-semantics probes + rate-limit burn + raw-socket OWS checks

## Results
- **Round 1: 33/34 pass.** The single miss was my own wrong expectation:
  `GET /api/ready/` returns 503, not 404 — trailing slashes are normalized up front
  (http.mjs:948-952, documented QA fix 2026-10-03 P2-1). Server behavior correct.
- **Round 2: 33/36 pass; 3 apparent misses all explained as harness artifacts:**
  1. `Origin: "<expected> "` (trailing space) → 422 not 403: undici trims OWS on
     send; raw-socket retest confirmed the server only ever sees the trimmed value
     and strict-compares it. Foreign origins (`https://evil.example`, `null`,
     trailing-slash) → 403 as designed. No bypass.
  2. Duplicate-cookie probe used a made-up cookie name → 410. Retest with the real
     `account_session` cookie → 401 `ambiguous_session_cookie` as designed.
  3. `Authorization: "Bearer "` (empty) → 403 in round 2 (undici trimmed the space,
     so `carriesBearer` saw `"Bearer"`); raw-socket with the literal trailing space
     → origin check skipped → 422 `invalid_link`. This is the documented
     headless-agent path (checkPreviewOrigin comment, #1529): Bearer <redacted> a non-browser
     flow, and the route is read-only capability-URL data. By design.
- **Rate limit:** burn loop → 429 `rate_limited` with X-RateLimit-* headers, as designed.
- **Statuses observed across ~90 requests:** 200 n/a (no seeded rooms/links),
  400, 401, 403, 410, 413, 415, 422, 429, 503, 404. **Zero 500s, zero hangs**
  (slowest single request 121ms; most < 20ms).
- **Type-confusion sweep on `linkToken`** (number/null/bool/object/array/unicode/
  newline/percent-encoded/15000-char/empty/`__proto__`/guest-agent `ga1.` kind/
  `#code/` alias): all → 410 `link_unavailable` or 422 `wrong_link_kind` /
  `invalid_link`. `classifyJoinToken` and `parseShareInviteCode` are type-tolerant;
  the `typeof token !== "string"` guard in `find()` catches the rest. No crash path.
- **Body limits:** 20KB body → 413 `too_large` naming actual vs limit (G7, #940).
  Non-JSON → 415/400 as designed. Empty/whitespace body → 400 `invalid_json`.
- **`/api/ready`:** GET/HEAD → 503 `unavailable` on empty DB (by design — no room
  seeded); POST/PUT/OPTIONS/`/API/READY` → 404 fallthrough; HEAD returns empty body.
  The 200 `ready` branch needs a seeded room (writer-fence blocks direct SQL seeding;
  branch is a trivial `{status:"ready"}` with no untrusted input — not a fuzz surface).

## Findings
**No crash, hang, or wrong-status found on either handler.** No fail-first test
written — there is no failing behavior to pin. (Per mission: repro + test only on
finding.)

## Repro
```sh
cd ~/workspace/pr-wave2000-guild-02
# boot scratch server (port 41871)
setsid nohup env PORT=41871 ROOM_DB=$PWD/worker-18/data/room.sqlite \
  GROWTH_SNAPSHOT_PATH=$PWD/worker-18/data/growth.json \
  ROOM_INSTANCE_LOCK_PATH=$PWD/worker-18/data/.lock TMPDIR=$PWD/.tmp \
  node server.mjs > worker-18/server.log 2>&1 < /dev/null & disown
sleep 16
node worker-18/fuzz-shard18.mjs        # round 1
node worker-18/fuzz-shard18-round2.mjs  # round 2 (wait 60s after round 1 for rate window)
```
Server left running on 127.0.0.1:41871 at time of writing (scratch DB only).

## Suggested follow-ups (not findings)
- Verifier: reconcile shard enumerations across workers (worker-9's 107-line list vs
  this worker's 102-line list) to confirm full coverage of the legacy chain.
- The 200-paths (`/api/ready` with a room; preview with a live link) were not
  exercised — they need seeded state via the store API; existing repo tests
  (tests/agent-setup.test.js etc.) cover them.
