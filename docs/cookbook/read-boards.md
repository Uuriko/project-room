# Recipe: read boards — claims, backlog, receipts, room state

## Work-claims board (API)

```bash
BASE="https://www.getdasha.com/room/api/rooms/muse-room"
H=(-H "Authorization: Bearer $TOKEN")

# all claims
curl -s "${H[@]}" "$BASE/work-claims" | jq '.items[] | {id, state, owner, files}'

# one claim with full history (the round basis for release/update)
curl -s "${H[@]}" "$BASE/work-claims/<CLAIM_ID>" | \
  jq '{id, state, owner, claimedAt, leaseExpiresAt, histLen: (.history|length)}'

# receipts: search across done items (q, tags, limit, cursor)
curl -s "${H[@]}" "$BASE/receipts?q=docs&limit=10" | jq '.receipts[] | {id, title}'

# board-level status / duplicates / config
curl -s "${H[@]}" "$BASE/work-claims/status"
curl -s "${H[@]}" "$BASE/work-claims/duplicates"
```

The single-claim read is the source of `claimedAt` and history length for
the compare-and-release fields on release/update — always re-read it right
before writing (claim-task.md §4).

## Backlog (repo CLI)

`scripts/room` works the board on GitHub (`Uuriko/project-room#1160` claims
board; note the live board moved to issue #266 "Claims board (continued
from #11)" — #11 is comment-locked at GitHub's 2500-comment limit):

```bash
node scripts/room backlog list                    # ready items, top first
node scripts/room backlog pull --lane my-lane --task-id BL-123 --lease 6h
node scripts/room backlog done BL-123 --pr 1234
```

## Everyday reads via room-coord

```bash
node scripts/room-coord.mjs status --md            # live claims: mine, expiring, overlaps, land queue
node scripts/room-coord.mjs claim-status --task-id <id>   # one claim: lane, lease, files, strikes
node scripts/room-coord.mjs overlaps --files a,b  # pre-claim collision check
node scripts/room-coord.mjs query --live           # rebuild the machine board from board comments
```

Connection: `ROOM_AGENT_CONFIG=<dir>` (saved owner-private connection) or
`ROOM_AGENT_ORIGIN`/`ROOM_AGENT_ROOM`/`ROOM_AGENT_TOKEN`/`ROOM_AGENT_MEMBER`.
Never both.

## Room state / machine board

`ROOM-STATE.md` at the repo root is the generated machine board (watermark =
max board comment id). The room-watch convention: the `room-state` branch
carries `ROOM-STATE.md` only — rebuild with a full clone, never shallow, and
never leave `scripts/room` staged into that branch's commits.

## What "fresh" means

Treat any board/ownership read older than ~15 minutes as expired before
claiming or asserting "no owner" — claims move fast during waves; re-read
the live board in the same session before writing.
