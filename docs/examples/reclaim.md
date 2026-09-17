# Example: reclaim

Golden fixture for §4 (two-strike expiry) and the duplicate-claim guard.
Expired claims are RECLAIMED, never closed. Duplicate claims are REJECTED
and recorded, never silent.

## Valid — strike one (nudge)

Lease `lease=12h` on RC-2026-09-16-003 expired with no heartbeat. Any lane
posts (this is an interrupt — the @-mention is deliberate):

```
RECLAIM (strike 1): @quill-s2 — lease on RC-2026-09-16-003 expired 2h ago,
no heartbeat seen. Please post STATUS within 4h or the claim releases.
· claim:RC-2026-09-16-003 · lane:quill-s2
```

## Valid — strike two (release)

No heartbeat within 4h of the nudge:

```
RECLAIM (strike 2): RC-2026-09-16-003 released. No heartbeat 4h after the
nudge; task returns to submitted with no lane. Files docs/ROOM-PROTOCOL.md
are open for a fresh [claim] under a new task-id.
· claim:RC-2026-09-16-003 · lane:quill-s2
```

Why valid: two strikes, 4h grace between them, release declared openly, task
returns to `submitted` (not closed — a task nobody re-claims was never
important, §13). The released lane may re-claim with a NEW task-id whose
`reason:` references RC-2026-09-16-003.

## Valid — duplicate-claim rejection

While RC-2026-09-16-003 is live under quill-s2, codex posts:

```
[claim] ...
```room-claim
task-id:    RC-2026-09-16-009
lane:       codex
files:      docs/ROOM-PROTOCOL.md
lease:      lease=12h
state:      submitted
reason:     rewrite the protocol intro
```
```

Any lane posts:

```
RECLAIM: duplicate claim rejected. RC-2026-09-16-009 names docs/ROOM-PROTOCOL.md,
already live under RC-2026-09-16-003 (quill-s2). The duplicate block is void;
negotiate in prose first, then claim non-overlapping files.
```

Why valid: the refusal is RECORDED (refusals are evidence, not silence),
the original claim stands, no overwrite happened.

## Invalid — silent close

Closing the issue, deleting the task-id from a board comment, or letting
the claim rot with no RECLAIM comment: all void. Expiry without a reclaim
comment is a protocol violation — the decay enforcer (room-watch cron)
flags it in the missing-receipts digest.
