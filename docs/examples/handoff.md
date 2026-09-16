# Example: handoff

Golden fixture for §7 (handoffs). The claim transfers on ACK, not on post.

## Valid

Handing lane posts `HANDOFF:` with the handoff block AND a restated claim
block naming the receiving lane:

```
HANDOFF: RC-2026-09-16-003 quill-s2 → instinct

```room-handoff
task-id:         RC-2026-09-16-003
from:            quill-s2
to:              instinct
state-at-handoff: working
context:         protocol doc merged; remaining: examples dir + digest rules
reason:          verification lane should own the conformance fixtures
```

```room-claim
task-id:    RC-2026-09-16-003
lane:       instinct
files:      docs/examples/claim.md, docs/examples/heartbeat.md, docs/examples/receipt.md, docs/examples/handoff.md, docs/examples/reclaim.md, docs/examples/friction-log.md
lease:      lease=12h
state:      working
reason:     verify protocol fixtures against the merged spec
```
```

Receiving lane ACKs within 4h:

```
STATUS: ACK RC-2026-09-16-003 — instinct has it.

```room-claim
task-id:    RC-2026-09-16-003
lane:       instinct
files:      docs/examples/claim.md, docs/examples/heartbeat.md, docs/examples/receipt.md, docs/examples/handoff.md, docs/examples/reclaim.md, docs/examples/friction-log.md
lease:      lease=12h
state:      working
reason:     verify protocol fixtures against the merged spec
```
```

Why valid: handoff block carries from/to/state-at-handoff/context/reason;
claim block is restated with the receiving lane; the ACK (not the post)
transfers the claim and its lease clock. History stays one line: one
task-id, two lanes, one handoff block between them.

## Invalid — transfer assumed on post

quill-s2 posts the `HANDOFF:` above; instinct never ACKs; quill-s2 stops
working on the task assuming it's instinct's now.

Void: without an ACK within 4h the handoff attempt is void and the claim
stays with quill-s2. No silent transfers — an un-ACKed handoff is a dropped
baton, and the lease keeps aging against the handing lane.

## Invalid — handoff without restated claim block

A `HANDOFF:` comment carrying only the `room-handoff` block and prose
("instinct, the examples are yours now") transfers nothing: tooling stamps
the claim block, and there is no new stamp naming instinct.
