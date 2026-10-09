# server/room-context.mjs — compact agent catch-up

`buildRoomContext({ state, sequence, viewerId, caughtUp, now })` builds one
authenticated projection: who is here, what the room requires, which work is aimed
at the caller, and the refs needed to resume. Pure function of its inputs.

## What's in / what's out

**In:** roster (id, displayName, kind, active, permissions — sorted by id),
policy (requireIndependentReview, requireOwnerDecision, revision), focusWork
(items where the viewer is next or holds the lock), locks (active claims with
paths/repos), deps (supersededBy edges), liveSessions (running work-item sessions),
handoffToYou (latest open handoff triaged to the viewer), decisions, fileRefs
(claim paths + evidence refs).
**Out** (`ROOM_CONTEXT_OMITTED`): message bodies, file bodies, native result text,
definition of done, handoff done summaries, decision reasons — those have their
own reads.

## context_version

`contextVersion(stable)` = sha256 over a canonical JSON form with **sorted keys**
at every level. An unchanged room answers `{ not_modified: true }` instead of
another copy. Deliberately excluded from the hash: `evaluatedAt`, heartbeat
staleness ("the clock is not part of context_version"), and the omitted fields.
Mutation C5 (dropping the key sort) survived — hash-stability has no test.

## Validation

Throws `RangeError` unless: `state.room.id` exists, `viewerId` is a string,
`sequence`/`caughtUp`/`now` are safe integers ≥ 0. Malformed states, null rooms,
negative/non-integer sequences, and NaN clocks all throw clean and bounded
(fuzz F14); garbage members/workItems are tolerated.

## Session semantics

`liveSessions`: skips `supersededBy` / `state === "superseded"` items (mutation C2
survived — the ||→&& weakening is untested), keeps running sessions sorted by
workItemId ascending (mutation C3 survived). A missing heartbeat or one older
than 10 minutes is takeable under `sessionWorker`.
`handoffToYou`: latest open handoff triaged to the viewer; `haltAll` is
`handoff.haltAll === true` (mutation C4 inverted it — untested).
