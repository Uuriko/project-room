# WAVE-400 endpoint catalog — partition r4 (feedback · matchmaking · next-actions)

All claims verified against the code on 2026-10-08. Mount paths confirmed in `server/http.mjs`
(line refs given). No docs were copied from; openapi.yaml spot-checks matched code (0 stale flags found).

---

## server/feedback-routes.mjs

Mount prefix: `/api/rooms/{roomId}/feedback` (http.mjs:3479–3488; dispatch 3825–3845).
Route-id mapping in http.mjs: base+GET/HEAD → `list`, base+other methods → `submit`;
literal segments (`queue`, `notifications`) are matched before the `{id}` template so they can
never be mistaken for a feedback id (http.mjs:3822–3824). Feedback ids must match
`/^[A-Za-z0-9_-]{1,64}$/` (feedback-store.mjs:25) or the item read returns 404.

Auth: mounted inside the authenticated room block (credential, fence, rate-limit, API-key scope
checks — http.mjs:3822). GET/HEAD routes need `rooms:read`; everything else needs `rooms:write`.
Additionally: member id must match `LANE_RE` (`/^[A-Za-z0-9_-]{1,64}$/`) or 401 `unauthenticated`
(feedback-routes.mjs:171–173); guest members may read but get 403 `guest_scope_denied` on any
write (feedback-routes.mjs:174–176, and again in http.mjs reauthorize); every non-GET route
additionally enforces the caller's autonomy tier (feedback-routes.mjs:177–183).
Domain errors are `FeedbackError` codes mapped to statuses by `STATUS_FOR_CODE`
(feedback-routes.mjs:48–55); unknown errors rethrow as 500 with no internal detail.

| Method | Path | Auth | Params | Success | Errors |
|---|---|---|---|---|---|
| POST | /api/rooms/{roomId}/feedback | member, `rooms:write`, non-guest, autonomy tier | Body (all required): `agent` (lane, + card_uri or key_id), `endpoint.method`, `endpoint.path`, `attempt` (goal + request/response repro pair), `observed`, `expected`, `severity` (bug\|perf\|missing-feature\|docs) — feedback-store.mjs:116–133 | 202 `{feedback_id, outcome: accepted\|duplicate\|reopened, cluster_key, verdict_url, mark_balance?}` (`mark_balance` absent on duplicate) — feedback-routes.mjs:199–206 | 422 invalid_feedback / invalid_agent / invalid_repro (attempt lacks request/response pair) · 403 lane_mismatch (body agent.lane ≠ auth lane) · 429 rate_limited (10 filings/lane/hour, room-keyed) · 402 insufficient_mark · 405 wrong method |
| GET/HEAD | /api/rooms/{roomId}/feedback | member (guests ok), `rooms:read` | none | 200 `{roomId, clusters, your_mark}` — clusters deduped by triage weight; your_mark = caller's Mark balance — feedback-routes.mjs:208–211 | 405 (PUT/DELETE/PATCH route to submit and 405) |
| GET/HEAD | /api/rooms/{roomId}/feedback/queue | member, `rooms:read` | none | 200 `{roomId, queue}` — triage queue, fast-track first — feedback-routes.mjs:212–215 | 405 non-GET/HEAD |
| GET | /api/rooms/{roomId}/feedback/notifications | member, `rooms:read` | none | 200 `{notifications}` — drain-on-read: the GET consumes the lane's queued events — feedback-routes.mjs:216–223 | 405 non-GET/HEAD |
| HEAD | /api/rooms/{roomId}/feedback/notifications | member, `rooms:read` | none | 200 `{notifications: [], drained: false}` — HEAD does NOT drain (H-22 guard: HEAD is a metadata probe, never a read) — feedback-routes.mjs:219–221 | — |
| GET/HEAD | /api/rooms/{roomId}/feedback/{id} | member, `rooms:read` | path `id` (must match id pattern) | 200 `{feedback_id, status: open\|triaged\|<closed>, verdict, triaged_at, severity, route, cluster_key}` — internal `new`→`open`, `promoted`→`triaged`; `route` = severity routing — feedback-routes.mjs:224–241 | 404 feedback_not_found (bad pattern or unknown id) |
| POST | /api/rooms/{roomId}/feedback/{id}/triage | `rooms:write`, non-guest, autonomy tier; lane must be reviewer (room owner or moderator) | Body: `verdict` required (real\|junk\|user-error) — feedback-routes.mjs:245 | 200 `{feedback_id, status, verdict, mark_balance, suspended, promoted_task}` — real verdict on bug/perf promotes a claims-board task — feedback-routes.mjs:246–250 | 422 invalid_verdict · 403 not_reviewer · 409 invalid_transition |
| POST | /api/rooms/{roomId}/feedback/{id}/appeal | `rooms:write`, non-guest, autonomy tier; caller must be the filer | Body: none (appeal priced in Mark automatically) — feedback-routes.mjs:254 | 202 `{feedback_id, status, mark_balance}` — feedback-routes.mjs:255–257 | 403 not_filer · 409 already_appealed / not_appealable / appeal_window_closed |
| POST | /api/rooms/{roomId}/feedback/{id}/appeal/decision | `rooms:write`, non-guest, autonomy tier; lane must be reviewer AND not the original triager | Body: `decision` required — feedback-routes.mjs:261 | 200 `{feedback_id, status, mark_balance, promoted_task?}` — feedback-routes.mjs:262–266 | 422 same_reviewer / invalid_decision · 403 not_reviewer |
| POST | /api/rooms/{roomId}/feedback/{id}/outcome | `rooms:write`, non-guest, autonomy tier; lane must be room owner (release authority) | Body: `kind` (merged\|adopted…), `ref`; the path id is wrapped as `feedbackIds: [id]` — feedback-routes.mjs:268–271 | 200 `{attributions}` — closes the loop, mints Mark to the filer — feedback-routes.mjs:271 | 403 not_release_authority · 422 unverified_merge_ref / invalid_outcome |

### Behavioral notes
- `agent.lane` is stamped from the authenticated member; a body-claimed lane that disagrees is
  rejected 403 (spoofing becomes junk by construction) — feedback-routes.mjs:194–197.
- Status map: `invalid_*`→422, `invalid_transition|not_appealable|already_appealed|appeal_window_closed`→409,
  `not_found`→404, `not_filer|not_reviewer|not_release_authority|suspended`→403,
  `insufficient_mark`→402, `rate_limited`→429 — feedback-routes.mjs:48–55.
- The store is a process-level per-room singleton; durable SQLite persistence is an open item
  (file header). Feedback IDs and reads are room-keyed — one room can never see another's filings.
- `sweepFeedbackVerdicts` (feedback-routes.mjs:269–271) settles unchallenged verdicts after the
  appeal window and ages never-shipped promotions stale — wired for a scheduler, not per-request.
- GET `/.well-known/feedback` discovery metadata is served directly from http.mjs:1387–1397, not
  from this module.

---

## server/matchmaking-routes.mjs

Mount prefix: `/api/rooms/{roomId}/matchmaking` (http.mjs:3444–3450; dispatch 3779–3812).
Full paths: `/seeker`, `/openings`, `/match`, `/decisions`, `/decisions/{decisionId}`,
`/decisions/{decisionId}/answer`.

Auth: mounted inside the authenticated room block (credential, fence, rate-limit; API-key
`rooms:read` for GET/HEAD, `rooms:write` otherwise; guests blocked on writes — http.mjs:3802–3811).
The seeker/agent is ALWAYS `auth.member.id` — never read from the body (matchmaking-routes.mjs:65–66).
Pure-module errors (plain `Error`, no status) map to 422 `invalid_matchmaking_input`; unknown
decision → 404; no declaration → 409 (matchmaking-routes.mjs:67–71).

| Method | Path | Auth | Params | Success | Errors |
|---|---|---|---|---|---|
| POST | /api/rooms/{roomId}/matchmaking/seeker | member, `rooms:write` | Body: `motives` (required, ≥1, enum of the MOTIVES vocab) · `appetiteMinutes` (required, integer 1–10080) · `capabilities` (optional, string list) · `trustTier` (optional, default min tier) — work-matchmaking.mjs:54–60 | 201 `{roomId, seeker}` (row form) — matchmaking-routes.mjs:99–101 | 422 invalid_matchmaking_input (missing motives, bad appetiteMinutes, unknown motive) |
| POST | /api/rooms/{roomId}/matchmaking/openings | member, `rooms:write` | Body: `workId` (required → openingId) · `title` (required) · `rewardKind` (required, same MOTIVES vocab) · `sizeMinutes` (required, integer 1–10080) · `rewardAmount` (optional, ≥0, default 0) · `requires` (optional, string list) · `trustFloor` (optional, default min) · `open` (optional, default true) · `deadline` (optional, ISO timestamp or null) — work-matchmaking.mjs:71–87 | 201 `{roomId, opening}` — matchmaking-routes.mjs:118–121 | 422 (e.g. `rewardKind=fun` with a nonzero rewardAmount → invalid_input; non-ISO deadline) |
| POST | /api/rooms/{roomId}/matchmaking/match | member, `rooms:write` | none | 200 `{roomId, match, alternatives (≤3), rejected (coded reasons), undeclared}` — one match + alternatives + a coded reason for every opening passed over; `undeclared` = rows skipped as non-matchable — matchmaking-routes.mjs:124–134 | 409 not_declared (call /seeker first — sequencing, not validation) · 422 from the matcher |
| POST | /api/rooms/{roomId}/matchmaking/decisions | member, `rooms:write` | Body: `decisionId` (required) · `question` (required, ≤2000 chars) · `needsAuthority` (required, enum AUTHORITIES) · `notAfter` (optional, ISO or null) · `blocking` (optional, list of ids this holds up) · `wakingHours` (optional, default true — routing-only, not stored) — agent-lanes.mjs:83–89 | 201 `{roomId, decision, chain, setAside, unreachable, expired, opening}` — the lane chain routed + the decision re-expressed as a matchable opening (2-minute work packet) — matchmaking-routes.mjs:146–151 | 422 invalid_matchmaking_input |
| GET | /api/rooms/{roomId}/matchmaking/decisions/{decisionId} | member, `rooms:read` | path `decisionId` (≤128 chars, http.mjs:3449) | 200 `{roomId, decision, answer}` (`answer` null if unanswered) — matchmaking-routes.mjs:174–178 | 404 decision_not_found |
| POST | /api/rooms/{roomId}/matchmaking/decisions/{decisionId}/answer | member, `rooms:write` | Body: `answer` (required: accept\|decline\|cancel) · `answeredBy` (required; the human, never the courier — must differ from courier agentId) · `note` (optional, ≤2000 chars) — agent-lanes.mjs:147–159 | 200 `{roomId, answer}` — relayed answer record incl. `unblocks` (decision.blocking) — matchmaking-routes.mjs:166–171 | 404 decision_not_found · 403 lane_not_registered (caller must be a registered courier lane) |

### Behavioral notes
- No method enforcement lives in `handleMatchmakingCore` — the http.mjs comment (3790–3794) is
  explicit that the `req.method === "POST"` gate is static for the routes-inventory docs gate;
  the canonical set is POST (declare/offer/match/decision-open/decision-answer), GET/HEAD
  (decision-read). Runtime serves all methods; GET on body-less routes like `match` works.
- `decision-open` rejects authority mismatches through the courier chain at answer time, not at
  open time: a courier may only carry authorities in its `relaysFor`, and never its own
  decision (agent-lanes.mjs:150–157).
- The registry is process-level in-memory (`createMatchmakingRegistry`; `store.matchmaking` is
  never populated anywhere, so the default in-memory registry always wins — http.mjs:3803): data
  does not survive restarts.
- BUG? server/matchmaking-routes.mjs:41 — `putLane` is defined but never called by any route or
  production module, so `registry.lanes(roomId)` is always empty in production and `decision-answer`
  can never pass its courier check (403 `lane_not_registered`, matchmaking-routes.mjs:164–165)
  unless the registry is seeded out-of-band. Lane registration appears to have no HTTP surface.
- Dead code: the trailing `return json(null, 500, {})` after the switch (matchmaking-routes.mjs:183)
  is unreachable — every branch returns and `default` rejects (throws).

---

## server/next-actions-routes.mjs

Mount prefix: self-mounted via `ROUTE = /^\/api\/rooms\/([^\/]{1,384})\/(next-actions|next-actions-dismiss|next-actions-suppressions|next-actions-dismissals)$/` (next-actions-routes.mjs:22),
served from http.mjs:2746 BEFORE the authenticated room block. Auth is self-contained:
`roomCredentials(req, url)` (Bearer identity secret or room cookie) — 401 `unauthenticated` without
a token; binding fence = `accountBinding` in account mode else `expectedBinding`
(next-actions-routes.mjs:56–61); the `NextActions` class re-authenticates per call.
Rate limits: 120/min per member on reads (`memberKey`), 60/min on writes
(next-actions-routes.mjs:65, 75, 89).
Error translation: `NextActionsError`→422; `ServiceError`-shaped errors keep their status
(next-actions-routes.mjs:27–35). No HEAD handling — HEAD falls through to other routes.

| Method | Path | Auth | Params | Success | Errors |
|---|---|---|---|---|---|
| GET | /api/rooms/{roomId}/next-actions | member credential (self-auth), read limit 120/min | Query: `limit` (optional, default 10) · `kinds` (optional, passed through) — next-actions-routes.mjs:66–71 | 200 ranked per-agent list (`na.list` shape: items array with action.api naming real routes) | 401 unauthenticated · 500 next_actions_unavailable (not attached to store) · 422 NextActionsError |
| POST | /api/rooms/{roomId}/next-actions-dismiss | member credential (self-auth), write limit 60/min | Body (required object): `actionId` (required, 1–128 chars) · `expiresInDays` (optional, 1–365, default 14 — next-actions.mjs:59,371) · `forever` (optional, default false) · `reason` (optional, ≤280 chars) — next-actions.mjs:336–342 | 200 `{dismissed: true, id, roomId, duplicate}` — dismiss is per-member private; re-dismiss of an already-dismissed id is idempotent and refreshes the window (`duplicate: true`); unknown ids 404 (`unknown_action` — usually means the item already lapsed) — next-actions.mjs:343–369 | 422 invalid_input (bad body shape, expiresInDays, forever, reason, actionId) · 404 unknown_action |
| GET | /api/rooms/{roomId}/next-actions-suppressions | member credential (self-auth), read limit 120/min | none | 200 `{roomId, viewerId, suppressions}` — newest first (ORDER BY updated_at DESC) — next-actions.mjs:372–379 | 401 unauthenticated |
| PUT | /api/rooms/{roomId}/next-actions-suppressions | member credential (self-auth), write limit 60/min | Body (required object): `suppressions` (optional, default []) — list of `{kind (required, 1–64 chars), reason? (≤280)}` — next-actions.mjs:381–397 | 200 `{roomId, viewerId, kinds}` — replace-all semantics (DELETE then upsert) — next-actions.mjs:393–396 | 422 invalid_input (non-list, bad kind, long reason) |
| GET | /api/rooms/{roomId}/next-actions-dismissals | member credential (self-auth), read limit 120/min | none | 200 `na.readDismissals(...)` — dismissal read-back including lapsed rows — next-actions.mjs:399+ | 401 unauthenticated |

### Behavioral notes
- Dismiss membership check: the action id must be in the caller's live list (`list` limit 50),
  checked BEFORE insert — the would-be dismissal row is queried separately so it doesn't filter
  its own validation list (next-actions.mjs:343–363).
- Unlike feedback, next-actions has no autonomy-tier gate and no guest distinction — any
  credentialed member may write.
- The mount is flat per room (`/api/rooms/{roomId}/next-actions-*`), not nested under
  `/next-actions/...`.

---

DONE: 20 endpoints, 0 stale flags, 1 suspected bug
