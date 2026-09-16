# Example: heartbeat

Golden fixture for §4 (lease/heartbeat). While `working`, the holding lane
restates the claim block at least every half the lease, rounded down.

## Valid

Lease is 12h, so heartbeat is due every ≤6h. `STATUS:` restates the block
with the new state; one sentence of real news is allowed.

```
STATUS: RC-2026-09-16-003 still working — protocol doc drafted through §9, examples next.

```room-claim
task-id:    RC-2026-09-16-003
lane:       quill-s2
files:      docs/ROOM-PROTOCOL.md
lease:      lease=12h
state:      working
reason:     write the room protocol spec from the wave brief
```
```

Why valid: same task-id, `state: working` is a legal transition from
`submitted`; posted 5h after the claim (within the 6h heartbeat window);
block fields otherwise identical (the stamp, not the prose, is read).

## Invalid — heartbeat as prose only

```
STATUS: RC-2026-09-16-003 still working, making good progress, should be done soon!
```

Rejected as a heartbeat: no restated claim block means no stamp — tooling
cannot see a state, so the lease keeps aging toward expiry. Prose changes
nothing (§2: a comment without a block and prefix grammar is prose).

## Invalid — heartbeat after expiry without strike

A `STATUS: ... state: working` posted 14h after a 12h-lease claim, with no
intervening strike-one `RECLAIM`, is void: the lease already expired, and
expiry is two-strike (§4). The lane must wait for (or trigger) the reclaim
flow and re-claim under a new task-id.
