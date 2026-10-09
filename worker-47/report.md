# WORKER-47 fuzz report — WAVE-2000 GUILD-02 (server/http.mjs)

Shard basis: `server/http.mjs` has no `app.get(...)` calls; routes are a
dispatch chain of `if (url.pathname === ...)` blocks. Used the guild's
established canonical list (`worker-1/routes_all.txt`, 102 handlers;
copied here as `routes_all.txt`). Shard: 1-based line L where L mod 50 == 46
(same convention as worker-29's shard.txt).

## Shard handlers (2)
- **L=46 → server/http.mjs:2248** — `GET /api/auth/methods` (non-GET → 405; requires account session)
- **L=96 → server/http.mjs:3112** — `GET /api/agent-rooms` (identity-secret room list; 60/min/IP rate limit)

Method: real server booted in-process against an acceptance fixture
(`createAcceptanceFixture` + `createRoomServer`, loopback ephemeral port,
`TMPDIR=$worktree/.tmp`). Three fuzz rounds; every request had an 8s
abort timeout (hang detection). No crashes, no hangs, no 500s across
~130 requests. Server stayed alive (`/api/health` 200 after every round).

## Round 1 — unauthenticated + method fuzz (`fuzz.mjs`, `fuzz.log`)
H1: no/garbage/duplicate cookie → 401; POST/PUT/DELETE/PATCH/OPTIONS/HEAD → 405
(HEAD returns empty body); 8KB cookie, 2KB query → 401; `/API/AUTH/METHODS` → 404.
H2: no/bare/short/wrong-scheme/whitespace Authorization → 401; unknown
well-formed `pri_` secret → 401 "Unknown identity secret"; valid secret → 200
`{identityId, rooms, nextCursor}`; lowercase `bearer` → 200; `after` too
long/invalid/null-byte/10k chars → 422; `after=` empty → 200; POST no secret → 401;
HEAD/PUT/DELETE → 405 with `Allow: GET, POST`. Rate burst (75 req): first 429 at
request #46 (prior fuzz requests counted toward the 60/min bucket — correct),
no bad responses, server healthy after.

## Round 2 — authenticated + boundaries (`fuzz2.mjs`, `fuzz2.log`)
Real account session via `/api/auth/password/signup`: `GET /api/auth/methods`
→ 200 with shape `{methods:[{id,type,provider,label,email,createdAt,lastUsedAt,
disabled,verifiedAt}], emailVerification, providers:{github,google,passkey,mail}
.configured}`. Tampered cookie, session-in-query, cookie+suffix → 401 (no
session fixation via query param). H2: created a room (201), list shows it;
`after=<own roomId>` → 200 empty page; `after` exactly 128 chars → 200 (length
gate is `> 128`); 129 chars → 422; unknown `rak_` key → 401; empty auth header
→ 401; whitespace-only `after` → 422.

## Round 3 — bearer regex boundaries (`fuzz3.mjs`, `fuzz3.log`)
Token-length edges at every regex boundary (43/42, `pri_`+43/42/128/129,
`ga1.`+43/42, `rak_`+16/15/128, embedded dot, double space, `BEARER` scheme):
all 401 as designed, no 500s.

## Apparent findings — both investigated and cleared (NOT bugs)
1. `GET /api/auth/methods/` (trailing slash) → 401, not 404. **Intentional:**
   http.mjs:948-950 normalizes trailing slashes up front ("QA 2026-10-03 (P2-1):
   a trailing slash must reach the route, not a 404"). My 404 expectation was wrong.
2. `GET /api/agent-rooms?after=a&after=b` → 200, not 422. **Benign:**
   `URLSearchParams.get()` returns the first value — standard behavior; `after`
   is an opaque pagination cursor, never user-typed twice. No contract violated.

## Verdict
**Shard clean.** No crash, hang, or wrong-status behavior found on either
handler. No fail-first test written — nothing failed first. No code changed,
no commit, no room posts, no prod contact.
