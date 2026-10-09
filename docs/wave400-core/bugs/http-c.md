# http.mjs lines 2501–3750 — suspected bugs (WAVE-400)

Checked: auth/fence ordering on every route in range, method-guard coverage
(405 vs 404), Allow-header accuracy, duplicate route registrations, id parsing
(`pathId`), rate-limit placement relative to `body(req)`, the funnel 404
guard / roomId chain / `route` ternary consistency, guest-scope gates, and
comment-vs-code drift. Nothing above minor was confirmed; no live correctness
bug was established. The items below are the residual suspects, all minor
except the first (structural fragility).

- `server/http.mjs:3572` (+ `server/http.mjs:4611`) — `route` fall-through
  fragility. The `route` ternary has no names for `matchmakingMatch`,
  `feedbackMatch`, `bountyMatch`, `creditsMatch`, or `boardV2Match`, so all of
  them fall through to `"ownership-transfer"`. Today this is harmless because
  every family dispatch block (`if (collabMatch)`, `if (workClaimMatch)`,
  `if (matchmakingMatch)`, `if (feedbackMatch)`, board-v2 410, …) returns
  unconditionally. But the 4611 handler `if (route === "ownership-transfer" &&
  req.method === "POST")` does not check `ownershipTransferMatch` — if any
  family dispatch ever fell through without returning, a POST to e.g. a
  matchmaking route would land in `agentRooms.transfer`. Suggest giving each
  family a real `route` name and/or adding the `ownershipTransferMatch` check
  at 4611. Not a live bug (verified all dispatch blocks return).

- `server/http.mjs:3137` — `/api/needs-me` 405 says `{ Allow: "GET" }` but the
  handler above (3122) also accepts HEAD. Same class at 2960/2980/3011/3024
  (invite-family 405s omit the `Allow` header entirely while siblings include
  it). Cosmetic.

- `server/http.mjs:2777-2793` — `/api/session` (non-POST) handles GET and
  DELETE, then 405s. A HEAD request 405s here although the GET response has
  no body sensitivity. Minor.

- `server/http.mjs:3203-3236` — `GET /api/access-requests/:id` and
  `POST /api/access-requests/:id` (cancel) have no method guard: PUT/DELETE
  etc. fall through the land/files matchers and hit the funnel 404 guard at
  3554, answering 404 rather than the file's usual 405-with-Allow. Minor
  inconsistency (also: unlike sibling POST-only routes there is no explicit
  405 twin for this family).

- `server/http.mjs:3150-3159` (`updatesQuery`) — the allowed query set
  includes `"auth"` and `"binding"` but the 422 message says "state, kinds,
  cursor, and limit are the updates query parameters". Cosmetic.

- `server/http.mjs:3040-3043`, `server/http.mjs:3205-3208` — stale comments
  describing pre-fix rate-limit state (detailed in modules/http-c.md). No
  runtime effect, but they will mislead the next reader about the threat
  model (they claim these open routes are unbounded, which they no longer
  are).
