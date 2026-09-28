# Backlog — ranked, top first. One lever for John: reorder this file.

The claims board is self-declared work; this file is the fed queue.
An idle lane runs `scripts/room backlog pull`, posts the claim, works it,
opens a PR, posts `[done]`, marks the item done here. (GUPP: if there's
work on your hook, you run it.)

Sections: `## ready`, `## blocked`, `## done` (archive, newest last).
Item format (one line each):
`- [ ] BL-NNN · title · scope: ... · accept: ... · files: f1, f2`
Optional trailers: `· blocked on: ...` `· claimed: RC-...` `· shipped as: #NNNN`

## ready
- [ ] BL-003 · telegram_live_status docs · scope: document the merged SQLite telegram_live_status table · accept: docs/ section merged · files: docs/
- [ ] BL-005 · Ralph burndown loop · scope: S4 night-shift loop (cron + worker template, cap 2) · accept: cron live, first burndown PR opened · files: scripts/room · unblocked: S2 shipped as #1086

## blocked
- [ ] BL-004 · merge queue (GitHub-native vs bot) · scope: S3 from the software-factory deep-dive · accept: decision recorded, either the owner tap or a bot PR · files: docs/ · blocked on: John's tap on the GitHub merge-queue checkbox

## done
- [x] BL-000 · OTel delivery tracing R1 · shipped as #1082
- [x] BL-000 · live file-claim registry S1 · shipped as #1084
- [x] BL-001 · kb/ durable memory seed · scope: create kb/ with index.md, notes/, plans/, decisions/ + 3 seed notes from AGENTS.md lessons · accept: kb/ merged, ROOM-PROTOCOL.md §4d documents the write/read conventions · files: kb/, docs/ROOM-PROTOCOL.md · shipped as: #1085

- [x] BL-002 · openapi.yaml drift check · scope: docs/openapi.yaml vs server routes · accept: script reports zero drift or opens a PR · files: docs/openapi.yaml, scripts/openapi-method-accuracy.mjs · evidence: docs/ROOM-RELIABILITY-FOLLOWTHROUGH.md
