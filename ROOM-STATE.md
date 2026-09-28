# ROOM-STATE — machine board
<!-- generated: 2026-09-28T02:58:05Z · board: Uuriko/project-room#1160 · watermark: 5862298929 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=a46fcc4b1d8ab3b638fa48e8267e6ca784de9298bb5cb6f6a95da9d583d2a43d -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-1167 | codex | working | 2026-09-28T01:45:05Z | server/board-v2-sqlite.mjs, cloudflare/http.check.mjs
RC-2026-09-27-005 | instinct | working | 2026-09-28T02:04:39Z | server/referral-invites.mjs, tests/referral-invites.test.js
RC-2026-09-27-2728 | jill | working | 2026-09-28T06:28:17Z | server/grants.mjs, server/schema additions, authz scope-check path

## file-claims
file | lane | task-id | state
authz scope-check path | jill | RC-2026-09-27-2728 | working
cloudflare/http.check.mjs | codex | RC-2026-09-27-1167 | working
docs/openapi.yaml | codex | RC-2026-09-27-1165 | working
index.html | codex | RC-2026-09-27-1165 | working
scripts/access-preview-browser-check.mjs | codex | RC-2026-09-27-1165 | working
server/board-v2-sqlite.mjs | codex | RC-2026-09-27-1167 | working
server/grants.mjs | jill | RC-2026-09-27-2728 | working
server/http.mjs | codex | RC-2026-09-27-1165 | working
server/owner-attention.mjs | codex | RC-2026-09-27-1165 | working
server/referral-invites.mjs | instinct | RC-2026-09-27-005 | working
server/schema additions | jill | RC-2026-09-27-2728 | working
src/client.js | codex | RC-2026-09-27-1165 | working
src/needs-attention.js | codex | RC-2026-09-27-1165 | working
tests/owner-attention.test.js | codex | RC-2026-09-27-1165 | working
tests/referral-invites.test.js | instinct | RC-2026-09-27-005 | working

## overlap-warnings
file | lanes | task-ids
(none)

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-2728 | jill | working | 2026-09-28T06:28:17Z | server/grants.mjs, server/schema additions, authz scope-check path

## unclaimed-lanes
lane | focus | trust
quill | bugs + quality + growth | elevated
quill-s2 | Rowboat-port + room-protocol workstream | standard
grokbot | merge + deploy | elevated
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
RC-2026-09-27-2729 | bcf6d935a0f6a0567447446cc355987a2bdd7e86 | 5862178126
RC-2026-09-27-2732 | 254491bb8053a7f65fa65a703148017d486e1539 | 5862071060
RC-2026-09-27-2731 | 3de14c827d096900f54472d08f8b5d3e3b5b5ae7 | 5861944034
RC-2026-09-27-2730 | f9ce76b236c1027b20ff49470b5728b5cc67ffe3 | 5861418879
unknown | none | 5860766531
RC-2026-09-27-2726 | a33d701f08768456cf45a9b45b0c2180cb1937ef | 5860744551
RC-2026-09-27-2726 | a33d701f08768456cf45a9b45b0c2180cb1937ef | 5860743999
unknown | none | 5860691551
unknown | none | 5860668320
unknown | none | 5860628779

## prose-claims-needing-fence
comment-id | lane | task | at
(none)

## rotation
Uuriko/project-room#266 -> Uuriko/project-room#1160 · watermark 5859826064 · carried-open: RC-2026-09-27-005

## signals
board_comments=71 threshold=1500 rotation_due=no watcher=active open_claims=4 prose_open=0 unfenced_prose=0 files_claimed=15 overlap_files=0 watermark=5862298929

