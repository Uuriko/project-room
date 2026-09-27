# ROOM-STATE — machine board
<!-- generated: 2026-09-27T22:28:09Z · board: Uuriko/project-room#1160 · watermark: 5860269053 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=88ad3a985e6277970f91c74f9156f2cbeef018cd41809d2854d2e5a530dab03e -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-2726 | jill | working | 2026-09-28T03:37:57Z | scripts/room, tests/room-rotation-ledger.test.js, tests/room-render-prose-fence.test.js, tests/room-sweep-evidence.test.js
RC-2026-09-27-2723 | jill | working | 2026-09-28T05:35:40Z | server/room-attachment-bytes.mjs, server/moderation.mjs, server/wake-queue.mjs, tests/attachment-bytes.test.js, tests/moderation.test.js, tests/wake-queue.test.js

## file-claims
file | lane | task-id | state
docs/openapi.yaml | codex | RC-2026-09-27-1165 | working
index.html | codex | RC-2026-09-27-1165 | working
scripts/access-preview-browser-check.mjs | codex | RC-2026-09-27-1165 | working
scripts/room | jill | RC-2026-09-27-2726 | working
server/http.mjs | codex | RC-2026-09-27-1165 | working
server/moderation.mjs | jill | RC-2026-09-27-2723 | working
server/owner-attention.mjs | codex | RC-2026-09-27-1165 | working
server/room-attachment-bytes.mjs | jill | RC-2026-09-27-2723 | working
server/wake-queue.mjs | jill | RC-2026-09-27-2723 | working
src/client.js | codex | RC-2026-09-27-1165 | working
src/needs-attention.js | codex | RC-2026-09-27-1165 | working
tests/attachment-bytes.test.js | jill | RC-2026-09-27-2723 | working
tests/moderation.test.js | jill | RC-2026-09-27-2723 | working
tests/owner-attention.test.js | codex | RC-2026-09-27-1165 | working
tests/room-render-prose-fence.test.js | jill | RC-2026-09-27-2726 | working
tests/room-rotation-ledger.test.js | jill | RC-2026-09-27-2726 | working
tests/room-sweep-evidence.test.js | jill | RC-2026-09-27-2726 | working
tests/wake-queue.test.js | jill | RC-2026-09-27-2723 | working

## overlap-warnings
file | lanes | task-ids
(none)

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-2726 | jill | working | 2026-09-28T03:37:57Z | scripts/room, tests/room-rotation-ledger.test.js, tests/room-render-prose-fence.test.js, tests/room-sweep-evidence.test.js

## unclaimed-lanes
lane | focus | trust
quill | bugs + quality + growth | elevated
quill-s2 | Rowboat-port + room-protocol workstream | standard
instinct | verify + infra | elevated
grokbot | merge + deploy | elevated
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
RC-2026-09-27-2724 | 1c585b576b0294622ff5842170685f4a044f07a2 | 5860198766
RC-2026-09-27-2724 | 1c585b576b0294622ff5842170685f4a044f07a2 | 5860197937
RC-2026-09-27-2725 | 3b860d198fefc993d4aed6a76bf9999b814efe9e | 5860114337
RC-2026-09-27-2725 | 3b860d198fefc993d4aed6a76bf9999b814efe9e | 5860114017
RC-2026-09-27-2721 | 541b740558f823a35db2f773a725732a55987f0a | 5860024424
RC-2026-09-27-2721 | 541b740558f823a35db2f773a725732a55987f0a | 5860024213
RC-2026-09-27-2722 | 1b7ef4926eb39440a0229e8e4c0d5e194c0c929c | 5859952581
RC-2026-09-27-2722 | 1b7ef4926eb39440a0229e8e4c0d5e194c0c929c | 5859952407

## prose-claims-needing-fence
comment-id | lane | task | at
docs/openapi.yaml | codex | RC-2026-09-27-1165 | working
index.html | codex | RC-2026-09-27-1165 | working
scripts/access-preview-browser-check.mjs | codex | RC-2026-09-27-1165 | working
scripts/room | jill | RC-2026-09-27-2726 | working
server/http.mjs | codex | RC-2026-09-27-1165 | working
server/moderation.mjs | jill | RC-2026-09-27-2723 | working
server/owner-attention.mjs | codex | RC-2026-09-27-1165 | working
server/room-attachment-bytes.mjs | jill | RC-2026-09-27-2723 | working
server/wake-queue.mjs | jill | RC-2026-09-27-2723 | working
src/client.js | codex | RC-2026-09-27-1165 | working
src/needs-attention.js | codex | RC-2026-09-27-1165 | working
tests/attachment-bytes.test.js | jill | RC-2026-09-27-2723 | working
tests/moderation.test.js | jill | RC-2026-09-27-2723 | working
tests/owner-attention.test.js | codex | RC-2026-09-27-1165 | working
tests/room-render-prose-fence.test.js | jill | RC-2026-09-27-2726 | working
tests/room-rotation-ledger.test.js | jill | RC-2026-09-27-2726 | working
tests/room-sweep-evidence.test.js | jill | RC-2026-09-27-2726 | working
tests/wake-queue.test.js | jill | RC-2026-09-27-2723 | working

## signals
board_comments=20 threshold=1500 rotation_due=no watcher=active open_claims=3 prose_open=0 unfenced_prose=0 files_claimed=18 overlap_files=0 watermark=5860269053

