# GUILD-06 (COORD-300, recovery respawn): Python SDK contract repair

## Mission (redirected)

Per Dot's room direction (muse-room seq 8263, relayed 2026-10-09 ~12:25 PDT),
this guild was re-aimed from "build new onboarding" to **repair observed
coordination failures**: offline contract fixtures and compatibility checks
for the EXISTING Python SDK built by WAVE-2000 guild-22 — not another SDK —
and closing the five contract mismatches Dot posted at muse-room seq 8227.

The guild-22 coordinator is done and its branch released, so the owner is
unavailable; per Dot's own seq-8263 note ("I can take a narrow SDK repair
handoff if its owner is unavailable"), this directory carries the repair as
**verified patches + fixtures + runnable tests**, not as a mutation of the
released `wave2000/guild-22` branch. Landing the patches is a merge decision
for Dot / the SDK owner / John.

## The five mismatches (muse-room seq 8227, verified against server source)

Contract source: `origin/main` @ `97f4edf26` (re-verified after rebase).
SDK source: `wave2000/guild-22` @ `7a427e12b12eb3c6e974c7bbe5394cd797547ae7`
(`sdk-python/`).

| # | Mismatch | SDK bug (file) | Server truth (file:line) |
|---|----------|----------------|--------------------------|
| M1 | **Envelope shape** — GET /events rows are `{"sequence": N, "event": {...}}` wrappers; the parser read type/data at the top level and lost all content | `room_sdk/models.py` — `EventPage.from_dict` parsed each wrapper row directly as a `RoomEvent` (id/type/actorId/at/data all `None`) | `server/store.mjs:4389` — `eventsAfter` returns `{events: [{sequence, event}], next, hasMore}`; `src/events.js:469` — the event body itself carries **no** sequence, so the wrapper sequence must be retained |
| M2 | **hasMore paging** — `iter_events` stopped on an empty page even when `hasMore=true`, silently truncating filtered event reads | `room_sdk/events.py` — `iter_events` returned early on `not page.events` | `server/store.mjs` (`eventsAfter`): "The cursor advances by what was SCANNED, not by what was returned" — a filter can match nothing while `hasMore` is true; the documented contract is *continue while hasMore* |
| M3 | **id/replyToId naming** — conversation records use `id`/`replyToId`; the parser expected `messageId`/`parentId` and returned `None` | `room_sdk/models.py` — `MessageRecord.from_dict` | `src/events.js:1176,1182` (`postMessage` reducer) — records are `{id, authorId, body, channelId, replyToId, createdAt, ...}`; `server/conversation-sync.mjs` returns these records verbatim |
| M4 | **replyToId payload** — `post_message(reply_to=...)` sent `data.parentId`; the server 422s unknown command fields | `room_sdk/rooms.py` — `post_message` | `server/store.mjs:711` — message.posted shape allowlist includes `replyToId`, not `parentId`; `server/store.mjs:793` — anything else fails `422 invalid_command / Unexpected field: parentId` |
| M5 | **Idempotent retry** — retrying `post_message` with the same `command_id` minted a *new* `messageId`, so the payload changed under the same idempotency key | `room_sdk/rooms.py` — `post_message` | `server/store.mjs` (`command`): the fingerprint covers the whole envelope including `data.messageId`; same id + different content → `409 idempotency_conflict` |

## Layout

```
sdk-contract-guild06/
  README.md                 this file
  fixtures/                 real server response shapes (offline, built from server source)
    events-page.json            {sequence,event} envelope page
    events-page-filtered-empty.json   empty visible page, hasMore=true, cursor advanced
    conversation-page.json      conversation window with id/replyToId records
    command-receipts.json       first / duplicate receipts + 409 conflict body
  tests/
    test_contract_compat.py     9 runnable tests (stdlib unittest, no network)
  fixes/
    guild22-sdk-contract-fixes.patch  the five fixes as a unified diff
                                      against wave2000/guild-22 sdk-python/
  run.sh                    one command: materialize SDK (read-only) -> apply
                            patch -> contract tests (patched) -> SDK's own
                            61 tests (regression) -> negative control
  INTEGRATION-DEPS.md       integration dependencies
  NOT-PROVEN.md             what is NOT proven
```

## How to run

```sh
./run.sh
```

Expected: `RESULT: PASS`. It materializes the SDK with `git archive`
(the released branch is never mutated), applies the patch to a scratch copy,
runs the 9 contract tests (patched → green), runs the SDK's own 61-test suite
(60 green; the 1 failure is the guild-22 suite's own stale-contract test
`test_reply_pins_thread_root`, which asserts the *old* buggy `parentId`
payload — see below), then runs the contract tests unpatched as a **negative
control**: exactly the 6 mismatch tests fail, proving the tests detect the bugs.

## Measured before/after (real-shape fixtures, offline)

| Check | Before (unpatched) | After (patched) |
|-------|-------------------|-----------------|
| M1 fields extracted per event row (id/sequence/type/actorId/at/data) | 1/6 (sequence only, from wrapper) | 6/6 |
| M2 events yielded across empty-filtered + full page | 0 (early return) | 2; stuck cursor raises `RoomError` instead of looping |
| M3 message fields (message_id, parent_id) from real records | 0/2 (`None`) | 2/2, unknown fields tolerated in `raw` |
| M4 reply POST payload field | `parentId` → server 422s | `replyToId` |
| M5 retry with same command_id, no message_id | silent new messageId → server 409 | `ValueError` fail-fast; documented full-envelope retry recipe |

## The stale guild-22 test (do not "fix" by reverting)

`sdk-python/tests/test_rooms.py::PostMessageTest::test_reply_pins_thread_root`
asserts `data["parentId"] == "root1"` — i.e. it encodes the buggy contract.
With the M4 fix the payload is `replyToId`, so this test errors with
`KeyError: 'parentId'`. This is the *expected, explained* delta (Dot seq 8227:
"fake tests currently reinforce the mismatched shapes"). When the patch lands,
that test must be updated to assert `data["replyToId"]`, not reverted around.

## Comms note

Per the redirect, this guild posts **one coordinator rollup at the end** (no
GUILD-CHARTER repost; the predecessor died in the 12:12 PDT daemon restart
before posting anything — no charter found in the launcher ledger or the
worktree). Room posting is done by the launcher/parent; this directory is the
evidence. No workers were launched (redirect forbids it; depth 2/2 cannot
spawn anyway). BUG CONFIRMED items are listed with file:line in the table
above for the parent to route.
