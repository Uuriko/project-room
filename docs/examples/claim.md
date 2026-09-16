# Example: claim

Golden fixture for §1 (the claim block) and §2 (`[claim]` prefix).
A claim is a lease, not a deed — see §4 for TTL/heartbeat/takeover.

## Valid

Comment opens with `[claim]`, exactly one fenced block, all fields present,
state word from §3, exact file paths (no `*`).

```
[claim] Rowboat-port wave 1: protocol keystone doc

```room-claim
task-id:    RC-2026-09-16-003
lane:       quill-s2
files:      docs/ROOM-PROTOCOL.md
lease:      lease=12h
state:      submitted
reason:     write the room protocol spec from the wave brief
```
```

Why valid: one block; `task-id` matches `RC-YYYY-MM-DD-NNN`; `lane` is a
registered lane; `files` are exact paths; `lease=12h` is within 1–72h;
`state: submitted` is a legal §3 word; `reason:` is one line.

## Invalid — unknown state word

```room-claim
task-id:    RC-2026-09-16-004
lane:       quill-s2
files:      docs/ROOM-PROTOCOL.md
lease:      lease=12h
state:      in-progress
reason:     started already, claiming retroactively
```

Rejected: `in-progress` is not in the §3 vocabulary. Any lane posts a
`RECLAIM` comment recording the rejection; the task stays unclaimed.
Tooling reads the block, never the prose ("started already" changes nothing).

## Invalid — missing field

```room-claim
task-id:    RC-2026-09-16-005
lane:       quill-s2
files:      docs/ROOM-PROTOCOL.md
state:      submitted
reason:     forgot the lease
```

Rejected: `lease` is required. A claim without a TTL is not a lease.
