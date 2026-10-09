# server/work-claim-integrity.mjs

Board integrity guards (SEC-2 with the Q3-A addendum). Pure input-validation
helpers the work-claim routes call **before** the claim state machine:

- **Text**: titles, notes, review summaries are NFC-normalized; control chars
  (newline allowed in notes), bidi controls, lone surrogates, and text that is
  empty once whitespace/invisibles are stripped are refused with
  `422 invalid_claim_input` naming the field.
- **Inputs**: `dependsOn` must name claims in this room (no self-dependency);
  `leaseHours` must be 0.25–168.
- **Pull requests**: the client names a PR by URL or `owner/repo#n`; outcome,
  merge, CI, mergeable, head-sha and poll metadata are refused — only
  `claim-pr-sync` may set them.
- **Event budget**: board writes from members without claim authority stop at
  <10% of the room's lifetime event budget (`409 room_event_budget_low`).
- **Deploy status**: one GitHub read per store per 60s, single-flight, with the
  stale cached value while the GitHub budget is held.

## Public API

| Export | Behavior |
|---|---|
| `boardText(reject, field, value, {multiline})` | Normalizes (NFC, CRLF→LF for multiline) or refuses with 422 naming the field. Non-strings pass through for the state machine's own type error. |
| `boardTextFields(reject, data, fields)` | Normalizes every present named field on a copy. |
| `assertBoardLeaseHours(reject, data)` | Refuses non-numeric or out-of-range `leaseHours` (0.25–168). Absent/null passes. |
| `assertDependsOnKnown(reject, data, {selfId, has})` | Refuses self-dependency and unknown ids (message truncates the id to 128 chars). |
| `clientPullRequestInput(reject, data)` | Converts `owner/repo#n` shorthand to canonical URL; refuses any key other than `url` on PR objects. |
| `roomEventsRemaining(sequence)` | `eventsPerRoom - sequence`, floored at 0; null for non-integer input. |
| `assertBoardEventBudget(sequence, {privileged})` | Throws `409 room_event_budget_low` for non-privileged writers under 10% budget. Privileged (owner / manage_claims) always passes. |
| `readBoardDeployStatus(store, {fetchImpl, token, nowMs, force})` | Cached deploy status, single-flight per store (WeakMap), 60s freshness, stale-while-held when the GitHub budget is exhausted. |

Constants: `BOARD_LEASE_HOURS_MIN/MAX` (0.25/168), `EVENT_BUDGET_RESERVE` (0.1),
`DEPLOY_STATUS_MAX_AGE_MS` (60s), `DONE_WINDOW_MS` (7d), `LIST_HISTORY_ENTRIES` (3).

## Invariants

- Validators never mutate the caller's object (`boardTextFields`,
  `clientPullRequestInput` work on copies).
- The client can *name* a PR but never *assert* its state — any server-owned
  field on a PR object is a 422.
- Budget refusal is thrown, not returned (`assertBoardEventBudget` raises an
  `Error` with `status`/`code`/`body`), so callers must let it propagate.
- Deploy-status reads are single-flight per store object; concurrent callers
  share one GitHub fetch.

## Top callers

- `server/work-claim-routes.mjs` (only importer) — all board write paths.

## Gotchas

- `boardText` deliberately lets non-strings through so the state machine's
  type error (with its own message) wins over a normalization error.
- `readBoardDeployStatus` keys the WeakMap on the store object; a fresh store
  instance loses the in-flight dedup.
- `assertBoardEventBudget` consults `PILOT_LIMITS.eventsPerRoom` from store.mjs —
  the single source of the 10,000-event lifetime ceiling.

## Stale comments

None — the header comment's five bullets match the five export groups, and the
Q3-A / SEC-2 tags correspond to real code in the file.
