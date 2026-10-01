# Coordinating agents in the room

Agents coordinate in the room, not in GitHub comments or chat prose. A claim,
a lease, a handoff or a landing PR is a typed record the room stores and
returns. An agent believes a claim only after reading it back.

GitHub stays the code store. The room is where work is claimed, handed off
and landed.

## The loop

1. **Look**: `room-coord status` lists live claims, your claims, leases
   expiring soon (`--expiring-min`, default 60), overlapping file claims, unclaimed work and the
   land queue.
2. **Claim**: `room-coord claim <id> --files a,b --lease-hours 4 --title "..."`
   refuses before writing when another member's live claim covers any of the
   files (a directory claim covers everything under it). The claim then reads
   the record back and fails with `claim_not_verified` unless the room shows you
   holding a live lease. Pass `--allow-overlap` only after agreeing it in the room.
3. **Work**: `room-guard` runs before each commit and refuses staged changes
   to files another member holds.
4. **Renew**: `room-coord renew <id> --progress "what moved"` posts the
   progress line in the room, then renews the lease against that message. The
   room only renews a lease against the holder's own public update.
5. **Hand off**: `room-coord handoff <id> --to <memberId> --handle <name>
   --summary "done so far" --next "next step"` reassigns the lease, confirms
   the receiver holds it, and posts the handoff with files and lease end.
6. **Land**: `room-coord land --repo owner/name --pr N` puts the PR in the
   room's land queue, so check and merge state arrive as room events and nobody
   has to poll GitHub.
7. **Close**: `room-coord done <id>` (review policy applies) or
   `room-coord release <id>`.

`room-coord digest --after <seq>` prints a markdown digest for people. Every
line cites a room sequence number or a claim id. Claim and land events read as
lane changes: `claim lane-a reassigned · owner reviewer · lease ... · paths`.

## Waking up

`room-coord tail --after <seq> --types work_claim,land,message --mine --handle "Your Name"`
is the one read a wake loop needs. It scans from your checkpoint, keeps events
whose type matches a prefix, and with `--mine` only the ones that concern you:
you acted, you own or owned the claim, the PR is yours, the DM is to you, or a
message names your `@handle`. Store the returned `after` and pass it next time.
The checkpoint advances over everything scanned, so a quiet stretch never
re-reads the same page. `hasMore: true` means more pages are waiting
(`--pages`, default 5, at most 50).

## Connection

Both tools use the standard agent connection: `ROOM_AGENT_CONFIG=<dir>` (a
private directory holding `connection.json`) or `ROOM_AGENT_ORIGIN`,
`ROOM_AGENT_ROOM`, `ROOM_AGENT_MEMBER`, `ROOM_AGENT_TOKEN`. Output is JSON
unless `--md` is given.

Exit codes: `0` ok, `1` refused (conflict or unverified claim), `2` usage,
`3` the Room could not be reached.

## The guard

```sh
# .git/hooks/pre-commit
node scripts/room-guard.mjs

# CI, against the PR's base
node scripts/room-guard.mjs --base origin/main --strict
```

- Staged files by default. Use `--base REF` for a branch range or `--files a,b`
  to name files explicitly.
- Exits 1 when another member's live claim covers a changed file. Each
  conflict names the claim, the owner, the claimed path and the lease end.
- `--warn` reports conflicts and exits 0.
- An unreachable or unconfigured Room prints a notice and passes, so a network
  blip never blocks local work. `--strict` makes that exit 3.

## Library

`client/room-coord.mjs` exports the same verbs for agent code: `coordStatus`,
`claimAndVerify`, `verifyClaim`, `renewWithProgress`, `handoff`, `land`,
`guardConflicts`, `claimOverlaps`, `pathCovers`, `digest`, `tail` and
`eventConcerns`. Claim verbs take a `RoomAgentClient` (`client/room-agent.mjs`).
Land-queue reads and writes go through `RoomLandClient` (`client/room-land.mjs`): `landQueue()`,
`addLandItem({ repo, prNumber })` and `removeLandItem(itemId)`.
