# WORKER 5 — shard 5/50 fuzz report (guild-02, server/http.mjs)

- Mode: worker (guild.log has no GUILD DONE) — normal fuzz mission.
- Date: 2026-10-09. Local server only (127.0.0.1:4195, disposable sqlite DB). No prod, no deploys, no room posts, no commits.

## Shard
The task's `app.(get|post|...)` grep matches **zero** lines in this revision of
`server/http.mjs` — routes are a flat `if (url.pathname === ...)` dispatch.
Shard = those dispatch lines, sorted by line number, 0-based indices with
`(index mod 50) == 4` → 2 routes of 89:

| idx | http.mjs line | route |
|-----|---------------|-------|
| 4   | 1214 | `POST /api/auth/email/verify/resend` |
| 54  | 2474 | `POST /api/guest-invites/preview` |

## Battery
`worker-5/fuzz.mjs` — 66 adversarial cases via node:http (fresh connection each;
fetch was unusable: it silently drops `Origin`/`Cookie` forbidden headers).
Final run: **66/66 pass** — no crash, no hang, no wrong-status from the server.
Results: `worker-5/fuzz-results.json`. Seed script for 4 synthetic account
sessions: `worker-5/seed-session.mjs` (+ `worker-5/seeds.json`).

Covered per route:
- preview: method fallthrough (GET→404), missing/wrong Origin→403, 415/400/413
  body validation, `{}`/extra-field/type-confusion (number/null/bool/array/object)
  inviteCode→422, malformed/short/unicode/NUL/lone-surrogate/15KB codes→410,
  valid-format nonexistent→410, oversized body→413, 2000-deep JSON→422,
  charset content-type, trailing-slash normalization→route, case-sensitive path,
  query-string ignored, duplicate JSON keys, IP rate flood→429 with
  `Retry-After: 60` + `X-RateLimit-*` headers.
- resend: GET→405, missing/wrong Origin→403, no/bogus/short/duplicate
  cookie→401, missing/wrong CSRF→403, valid session+CSRF→503
  (mail_not_configured, expected locally), garbage/100KB bodies ignored without
  hang (route never reads the body), verified account→200 already_verified,
  no-email account→422, malformed stored email→422, per-account flood→429 on
  the 6th request in the minute window.

## Findings
1. **No server-attributable crash/hang/wrong-status.** Every status matched the
   code's contract. No fail-first regression test written — there is no bug to guard.
2. **Observation (not a bug): keep-alive race after 413 drain.** The 413 handler
   (http.mjs ~4995) drains then half-closes the socket; a keep-alive client that
   races its next request onto that socket gets `socket hang up` client-side.
   Server stays healthy (next request → normal status). Repro:
   `worker-5/repro-keepalive-race.mjs`. Standard HTTP behavior; clients must
   retry on a fresh connection.
3. **By-design notes:** trailing slashes are stripped before routing (line 952),
   so `/api/guest-invites/preview/` reaches the route; lone-surrogate escapes are
   valid JSON and fail the invite-code pattern → 410 (correct); the resend route
   never calls `body()`, so malformed/oversized bodies are ignored (no hang).

## Coverage gaps (not reachable locally without heavier seeding)
- preview → 200 success path and expired/revoked invite → 410 need a live room +
  guest invite seeded (room state too heavy to forge here).
- resend → 200 "resent" needs a configured mailer; the non-401 rethrow path
  inside `authenticateAccountSession` was not triggered.

## Environment notes (for sibling workers)
- `node_modules` was absent; ran `npm ci` in the worktree (ok).
- Background servers get reaped on this VM (~15 min); keep-alive across exec
  calls is unreliable — start the server and fuzz in one exec chain.
- Direct DB writes from outside fail on the writer fence
  (`no such function: project_room_writer_v38`); register it in the seeding
  connection: `db.function("project_room_writer_v38", () => 38)`.
- Use one `ROOM_INSTANCE_LOCK_PATH` per worker; the default lock
  (`.tmp/.project-room.lock`) is shared across all DBs in `.tmp`.
- `/tmp` files vanish (another agent wipes it); keep everything under the worktree.
