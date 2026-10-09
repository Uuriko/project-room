# WAVE-2000 G02 Worker 46 — fuzz report

**Shard**: 2 route handlers in `server/http.mjs` (from 102 pathname-dispatch entries sorted by line number; indices where `index mod 50 == 45`):
- index 45 → `GET /api/auth/methods` (`server/http.mjs:2248`) — lists account login methods; GET-only, requires `account_session` cookie.
- index 95 → `GET /api/agent-rooms` (`server/http.mjs:3112`) — lists an identity's rooms via `AgentRooms.list(secret, after)`; identity-secret only, rate-limited 60/min/address.

**Method**: local server on `127.0.0.1:4281` against throwaway DB `/tmp/w2000-worker46/room.sqlite` (killed after run). Authenticated coverage via self-minted identity (`pri_` secret) and store-minted account session.

**Result**: 70 fuzz cases, **0 crashes, 0 hangs, 0 wrong-status** (including ~250 total HTTP requests: SQL-injection payloads in `?after`, null bytes, unicode, 4KB headers, oversized queries, tampered/truncated tokens, wrong credential types, exotic methods, concurrent rate-limit burst).

| Check | Expected | Observed |
|---|---|---|
| Route A, no/invalid cookie | 401 | 401 (18 cases) |
| Route A, wrong method (POST/PUT/DELETE/PATCH/HEAD/OPTIONS/TRACE/PROPFIND) | 405 | 405 |
| Route A, valid session | 200 `{methods, emailVerification, providers}` | 200 |
| Route A, tampered/truncated session | 401 | 401 |
| Route B, no/invalid Bearer <redacted> | 401 | 401 |
| Route B, valid secret + `after` cursor fuzz | 422 on invalid cursor (bad chars, >128 chars, SQL, null byte, unicode, `__proto__`, `constructor`, `..`) | 422 everywhere invalid; 200 everywhere valid (empty, 128-char max, colon/dot/dash/underscore) |
| Route B, `rak_` room token as Bearer | 401 `room_token_not_identity` | 401 with helpful guidance message |
| Route B, 80 concurrent requests | first 60 → 200, then 429 | 60 × 200, 20 × 429, no 500/hang |
| Route B, pagination round-trip | cursor after last room → `rooms: []`, `nextCursor: null` | exact |
| Both, `/room/api/…` prefixed | same as bare | 200 same |
| Both, case variants (`/api/Auth/Methods`) | 404 | 404 |
| Both, trailing slash (normalized) | same as bare | same |

**One anomaly that was not a bug**: `Origin: http://evil.example` on route A returned 403 (I expected 200). Verified the 403 `origin_denied` is a **global pre-route gate** (`/api/health`, `/api/version`, `/api/agent-rooms` all return the same 403) — intended behavior, out of shard.

**Observation (hardening note, not a finding)**: `GET /api/auth/methods` has no `rate()` call while sibling POST routes (`/auth/methods/disable|enable|remove`, `/auth/password/set`) do. Authenticated read-only, so low value — not filed as a bug.

**Fail-first test**: not written — trigger condition (crash/hang/wrong-status) never occurred; writing a passing test for "it works" adds no coverage.

**Files**: `fuzz.js` (34 unauthenticated cases), `fuzz-auth.js` (30 authenticated cases), `mint-session.mjs`, `mint-identity.mjs`, `debug-list.mjs`, `results.md`, `server.log`, `room-create.json`, `.creds-*.txt` (throwaway test credentials for the killed local DB only).
