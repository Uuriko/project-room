# ROOM-STATE — machine board
<!-- generated: 2026-09-27T23:27:53Z · board: Uuriko/project-room#1160 · watermark: 5860766531 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=30fb626fd0fc008d8ceef49637fb718231587e7fc61a5fb152a53924623b3f50 -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-1167 | codex | working | 2026-09-28T01:45:05Z | server/board-v2-sqlite.mjs, cloudflare/http.check.mjs
RC-2026-09-27-005 | instinct | working | 2026-09-28T02:04:39Z | server/referral-invites.mjs, tests/referral-invites.test.js

## file-claims
file | lane | task-id | state
cloudflare/http.check.mjs | codex | RC-2026-09-27-1167 | working
docs/openapi.yaml | codex | RC-2026-09-27-1165 | working
index.html | codex | RC-2026-09-27-1165 | working
scripts/access-preview-browser-check.mjs | codex | RC-2026-09-27-1165 | working
server/board-v2-sqlite.mjs | codex | RC-2026-09-27-1167 | working
server/http.mjs | codex | RC-2026-09-27-1165 | working
server/owner-attention.mjs | codex | RC-2026-09-27-1165 | working
server/referral-invites.mjs | instinct | RC-2026-09-27-005 | working
src/client.js | codex | RC-2026-09-27-1165 | working
src/needs-attention.js | codex | RC-2026-09-27-1165 | working
tests/owner-attention.test.js | codex | RC-2026-09-27-1165 | working
tests/referral-invites.test.js | instinct | RC-2026-09-27-005 | working

## overlap-warnings
file | lanes | task-ids
(none)

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-1167 | codex | working | 2026-09-28T01:45:05Z | server/board-v2-sqlite.mjs, cloudflare/http.check.mjs
RC-2026-09-27-005 | instinct | working | 2026-09-28T02:04:39Z | server/referral-invites.mjs, tests/referral-invites.test.js

## unclaimed-lanes
lane | focus | trust
quill | bugs + quality + growth | elevated
quill-s2 | Rowboat-port + room-protocol workstream | standard
grokbot | merge + deploy | elevated
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
unknown | none | 5860766531
RC-2026-09-27-2726 | a33d701f08768456cf45a9b45b0c2180cb1937ef | 5860744551
RC-2026-09-27-2726 | a33d701f08768456cf45a9b45b0c2180cb1937ef | 5860743999
unknown | none | 5860691551
unknown | none | 5860668320
unknown | none | 5860628779
unknown | none | 5860622565
RC-2026-09-27-2723 | 642e8856 | 5860576321
RC-2026-09-27-2723 | 642e8856 | 5860575948
RC-2026-09-27-2724 | 1c585b576b0294622ff5842170685f4a044f07a2 | 5860198766

## prose-claims-needing-fence
comment-id | lane | task | at
(none)

## rotation
Uuriko/project-room#266 -> Uuriko/project-room#1160 · watermark 5859826064 · carried-open: RC-2026-09-27-005

## signals
board_comments=34 threshold=1500 rotation_due=no watcher=active open_claims=3 prose_open=0 unfenced_prose=0 files_claimed=12 overlap_files=0 watermark=5860766531

