# ROOM-STATE — machine board
<!-- generated: 2026-09-28T00:29:05Z · board: Uuriko/project-room#1160 · watermark: 5861253434 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=ec4d56d952e038bf6c07ffa28b486ca4326955c518ddc6cb67308a844fef5d0b -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-1167 | codex | working | 2026-09-28T01:45:05Z | server/board-v2-sqlite.mjs, cloudflare/http.check.mjs
RC-2026-09-27-005 | instinct | working | 2026-09-28T02:04:39Z | server/referral-invites.mjs, tests/referral-invites.test.js
RC-2026-09-27-2731 | jill | working | 2026-09-28T06:26:17Z | MCP tool surface, agent capability listing endpoint
RC-2026-09-27-2732 | jill | working | 2026-09-28T06:26:42Z | server boot/config validation, agent-card signing path
RC-2026-09-27-2730 | jill | working | 2026-09-28T06:26:44Z | server persistence/serialization modules, tests for row round-trips
RC-2026-09-27-2729 | jill | working | 2026-09-28T06:28:11Z | server/agent-plugin-routes.mjs, server/agent-plugin-manifest.mjs, webhook secret store
RC-2026-09-27-2728 | jill | working | 2026-09-28T06:28:17Z | server/grants.mjs, server/schema additions, authz scope-check path

## file-claims
file | lane | task-id | state
MCP tool surface | jill | RC-2026-09-27-2731 | working
agent capability listing endpoint | jill | RC-2026-09-27-2731 | working
agent-card signing path | jill | RC-2026-09-27-2732 | working
authz scope-check path | jill | RC-2026-09-27-2728 | working
cloudflare/http.check.mjs | codex | RC-2026-09-27-1167 | working
docs/openapi.yaml | codex | RC-2026-09-27-1165 | working
index.html | codex | RC-2026-09-27-1165 | working
scripts/access-preview-browser-check.mjs | codex | RC-2026-09-27-1165 | working
server boot/config validation | jill | RC-2026-09-27-2732 | working
server persistence/serialization modules | jill | RC-2026-09-27-2730 | working
server/agent-plugin-manifest.mjs | jill | RC-2026-09-27-2729 | working
server/agent-plugin-routes.mjs | jill | RC-2026-09-27-2729 | working
server/board-v2-sqlite.mjs | codex | RC-2026-09-27-1167 | working
server/grants.mjs | jill | RC-2026-09-27-2728 | working
server/http.mjs | codex | RC-2026-09-27-1165 | working
server/owner-attention.mjs | codex | RC-2026-09-27-1165 | working
server/referral-invites.mjs | instinct | RC-2026-09-27-005 | working
server/schema additions | jill | RC-2026-09-27-2728 | working
src/client.js | codex | RC-2026-09-27-1165 | working
src/needs-attention.js | codex | RC-2026-09-27-1165 | working
tests for row round-trips | jill | RC-2026-09-27-2730 | working
tests/owner-attention.test.js | codex | RC-2026-09-27-1165 | working
tests/referral-invites.test.js | instinct | RC-2026-09-27-005 | working
webhook secret store | jill | RC-2026-09-27-2729 | working

## overlap-warnings
file | lanes | task-ids
(none)

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-1167 | codex | working | 2026-09-28T01:45:05Z | server/board-v2-sqlite.mjs, cloudflare/http.check.mjs
RC-2026-09-27-005 | instinct | working | 2026-09-28T02:04:39Z | server/referral-invites.mjs, tests/referral-invites.test.js
RC-2026-09-27-2731 | jill | working | 2026-09-28T06:26:17Z | MCP tool surface, agent capability listing endpoint
RC-2026-09-27-2732 | jill | working | 2026-09-28T06:26:42Z | server boot/config validation, agent-card signing path
RC-2026-09-27-2730 | jill | working | 2026-09-28T06:26:44Z | server persistence/serialization modules, tests for row round-trips
RC-2026-09-27-2729 | jill | working | 2026-09-28T06:28:11Z | server/agent-plugin-routes.mjs, server/agent-plugin-manifest.mjs, webhook secret store
RC-2026-09-27-2728 | jill | working | 2026-09-28T06:28:17Z | server/grants.mjs, server/schema additions, authz scope-check path

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
board_comments=60 threshold=1500 rotation_due=no watcher=active open_claims=8 prose_open=0 unfenced_prose=0 files_claimed=24 overlap_files=0 watermark=5861253434

