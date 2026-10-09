# server/work-claim-integrity.mjs — board integrity guards

SEC-2 with the Q3-A addendum. Pure helpers the work-claim routes call
**before** the claim state machine.

## Text guards

`boardText(reject, field, value, {multiline})` → normalized text. Absent or
non-string values pass through unchanged (the state machine reports the
type error). Otherwise:

1. Must be well-formed (no lone surrogates) — else 422.
2. NFC-normalized; `\r\n`/`\r` → `\n` in multiline mode.
3. Control characters refused — all C0/C1 in titles; everything except `\n`
   in notes (multiline).
4. Bidi control characters refused.
5. Empty once whitespace + invisible characters are stripped → refused
   ("must contain visible text").

Invisible characters are stripped **only for the emptiness test**: `"a\u200bb"`
keeps its visible letters and is legal; only invisible-*only* text is refused.
`boardTextFields(reject, data, fields)` applies this to each named field in
place on a copy.

## Input guards

- `assertBoardLeaseHours(reject, data)`: `leaseHours` must be a finite number
  in `0.25..168` (`BOARD_LEASE_HOURS_MIN/MAX`), or null/absent (null = opt
  out where the route allows). Boundary-pinned: 0.25 and 168 accepted,
  0.249/168.0001 refused. (The pure machine separately allows any `> 0` —
  this is the stricter board layer.)
- `assertDependsOnKnown(reject, data, {selfId, has})`: every string
  `dependsOn` entry must name a claim in this room (`no claim "…" in this
  room`); self-dependency refused. Non-string entries are skipped — the
  state machine reports the shape.
- `clientPullRequestInput(reject, data)`: the client names a PR by URL or
  `owner/repo#n` shorthand (expanded to the canonical URL). Objects may
  carry **only** `url` — `outcome`, `merged`, CI, mergeable, head sha, poll
  metadata are refused ("recorded by the server from GitHub"). Merge/CI
  facts are set only by claim-pr-sync.

## Event budget

- `roomEventsRemaining(sequence)`: `max(0, PILOT_LIMITS.eventsPerRoom -
  sequence)`; null for non-integer sequences.
- `assertBoardEventBudget(sequence, {privileged})`: board writes from members
  without claim authority stop when less than 10% (`EVENT_BUDGET_RESERVE`)
  of the room's lifetime event budget remains → 409 `room_event_budget_low`
  with a hint and next-step. Room owner and `manage_claims` holders can
  still write (so they can wind the room down).

## Deploy status

`readBoardDeployStatus(store, {fetchImpl, token, nowMs, force})` — one
GitHub read per store per 60s (`DEPLOY_STATUS_MAX_AGE_MS`), single-flight
(shared promise in a WeakMap). Only board writers may force a refresh.
While the GitHub budget is held, returns the cached value with `stale: true`
and `heldUntil`; nothing is fetched.

## Constants

`DONE_WINDOW_MS` (7 days — receipts/done queries), `LIST_HISTORY_ENTRIES`
(3 — board-list history trim).
