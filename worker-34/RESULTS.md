# WORKER 34 — fuzz results: `POST /api/agent-invites/redeem`

- Shard: route-handler index 33 of the ordered `url.pathname === ... && req.method === ...`
  conditionals in `server/http.mjs` (line 2940; the task's `app.get(` grep matched 0 lines —
  this server uses manual pathname+method dispatch, so the shard was self-partitioned on
  that ordered conditional list, documented here).
- Harness: private fuzz server (`ROOM_DB=.tmp/w34-room.sqlite`, port 47834), seeded invite
  rows via `RoomStore` writer-fence connection (never touched prod data or the guild
  owner's instance).
- Raw case JSON: `fuzz-A.json`, `fuzz-B.json`, `fuzz-C.json`, `fuzz-D.json` (this dir).

## Totals
52 requests across 4 fuzz batches + 2 manual duplicate-path probes.
**Zero 500s, zero hangs/timeouts, zero crashes.** All statuses matched expectations
except where noted below (all explained as harness artifacts or deliberate code order).

## Coverage (expected → got)
- Happy path: valid code → **201**; redeem-again (new identity) → **409 invite_already_used**;
  same-identity re-redeem → **201 duplicate:true** (verified end-to-end).
- Body-shape: `{}`, missing code/displayName, extra fields (incl. `__proto__`), wrong
  types (number/null/object/array for both fields) → **422 invalid_invite** with
  field-naming diagnosis; non-object JSON (array/string/number/null/bool), invalid
  JSON, empty body with `application/json` → **400 invalid_json**; wrong/missing
  content-type → **415 json_required**; body > 16384 bytes → **413 too_large** (names
  actual vs limit bytes).
- Codes: malformed → **404 invite_unavailable** (format-teaching message); unknown
  well-formed → **404**; expired → **410 invite_expired**; revoked → **410 invite_revoked**;
  case-insensitive/confusable folding (lowercase, `I`→`1`, surrounding whitespace) →
  normalized to stored row.
- Names: 81/3000 chars → **422 invalid_invite_name**; control chars → **422
  display_name_unavailable** with suggestion; emoji/unicode → accepted; empty/whitespace
  displayName → falls back to invite display_name → **201**.
- Auth: malformed Authorization → **401 Invalid Authorization header**; well-formed
  unknown identity token → **401 Active identity credential required**.
- Methods/paths: GET/PUT/DELETE/HEAD/OPTIONS/PATCH → **405**; trailing slash and
  case-variant path → **404**.

## Observations (not defects — no fail-first test owed)
1. **Check order: expired-before-used** (`server/agent-invites.mjs:249-250`). A code that
   is both expired and already-used returns 410 `invite_expired`, not 409. Deliberate
   order; both are terminal. Integrators should treat 410 as "get a fresh code".
2. **Orphaned redeemed row** (seeded `redeemed_identity_id` with no `identity_links`
   row — unreachable through the atomic redeem transaction, only via direct DB
   tampering) → **403 access_ended**. Correct defensive behavior; verified the real
   duplicate path returns 201 `duplicate:true`.

## Notes
- Rate limiter (`invite-redeem:<ip>`, 20/min) is in-memory: server restarted between
  batches to clear it. 429s during fuzzing were the limiter working, not failures.
- Two initial "failures" in batch C (`used`, `confusable-I`, `code-with-spaces` expecting
  409) were caused by the seeded row's 60-min TTL elapsing mid-fuzz (→ 410 expired),
  and `empty-body` expecting 400 was a harness bug (no content-type sent → 415 is
  correct); re-tested properly in batch D.
- Seeded test identities/codes live only in `.tmp/w34-room.sqlite` (disposable).
