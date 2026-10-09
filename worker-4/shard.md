# WORKER 4 — shard report (WAVE-2000 G02, API fuzzing)

- Worker: 4/50, shard k=4 → route-dispatch indices (0-based) with `index % 50 == 3`
- Slice: `server/http.mjs` route handlers, dispatch lines `if (url.pathname === …)` sorted by line
- Total dispatch sites: 93 → shard handlers: **index 3** and **index 53**
- Worktree: `~/workspace/pr-wave2000-guild-02` @ branch `wave2000/guild-02`
- Fuzz server: local only, `http://127.0.0.1:44217` (isolated DB `worker-4/.tmp/w4.sqlite`);
  second boot with dummy Google OAuth creds to exercise the configured path
  (`begin()` builds the authorize URL locally — zero network calls to Google).

## Shard handlers

| Idx | Line | Handler |
|-----|------|---------|
| 3   | 1106 | `GET /api/auth/google/start` (GOOGLE_START_PATH) — 405 gate, google-config check, per-IP rate limit (10), session-slot cookie, `signIn.begin()` → 302 |
| 53  | 2419 | `POST /api/guest-agent-links` — `checkOrigin` (Origin required without bearer), per-IP rate (30), `roomCredentials`, 401/422 gates, `store.guestAgentLinks.mint` |

Also exercised the sibling `POST /api/guest-agent-links/preview` (same file, shared `body()` parser)
because the mint route's auth wall (401) sits in front of body parsing — preview lets the
shared JSON body parser be fuzzed without credentials.

## Verdict

**No crashes, no hangs, no wrong-status responses on either shard handler.**
~90 cases across two rounds (wrong methods, malformed URLs/cookies/headers, oversized and
streaming bodies, deep nesting, prototype pollution, chunked/dangling/duplicate
Content-Length, HTTP/1.0, bad versions, rate hammer 25×, pending-state flood 110×).

Details: `findings.md`. Raw results: `results.json`, `results2.json`.
Fuzzers: `.tmp/fuzz.mjs`, `.tmp/fuzz2.mjs` (kept for re-runs; `/tmp` originals were reaped).

## Notes for verifier mode

- No fail-first tests were written: the mission ties tests to findings, and there were none.
- Server left running on port 44217 (setsid+nohup, survives exec-session reaps).
  Restart: `cd ~/workspace/pr-wave2000-guild-02 && TMPDIR=$PWD/.tmp ROOM_DB=$PWD/worker-4/.tmp/w4.sqlite ROOM_INSTANCE_LOCK_PATH=$PWD/worker-4/.tmp/w4.lock PORT=44217 ROOM_GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com ROOM_GOOGLE_CLIENT_SECRET=dummysecret-for-local-fuzz-only node server.mjs`
  (dummy creds are local-fuzz-only, never touch Google — `begin()` is offline).
- Two harness artifacts initially looked like bugs and are documented as non-bugs in
  `findings.md` (keep-alive socket poisoning after declared-but-unsent Content-Length;
  node client uppercasing `get`→`GET`).
