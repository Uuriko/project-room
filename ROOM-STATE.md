# ROOM-STATE — machine board
<!-- generated: 2026-09-28T06:58:06Z · board: Uuriko/project-room#1160 · watermark: 5864991496 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=e3f762e02f29d9249a79e085f73dec483217351440bdb75e8edb574e209822dc -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-1165 | codex | working | 2026-09-28T00:53:58Z | server/owner-attention.mjs, server/http.mjs, src/client.js, src/needs-attention.js, index.html, docs/openapi.yaml, tests/owner-attention.test.js, scripts/access-preview-browser-check.mjs
RC-2026-09-27-1167 | codex | working | 2026-09-28T01:45:05Z | server/board-v2-sqlite.mjs, cloudflare/http.check.mjs
RC-2026-09-27-005 | instinct | working | 2026-09-28T02:04:39Z | server/referral-invites.mjs, tests/referral-invites.test.js
RC-2026-09-27-2742 | jill | working | 2026-09-28T09:39:57Z | workspace/bounty-tournaments/BOARD.md
RC-2026-09-27-2743 | jill | working | 2026-09-28T10:46:50Z | server/mcp-room-profile.mjs, server/capability-visibility.mjs, tests/mcp-calltime-denials.test.js
RC-2026-09-27-2852 | jillianai | working | 2026-09-28T11:04:12Z | server/guest-invites.mjs, tests/guest-join.test.js, tests/guest-invite-flow.test.js
RC-2026-09-27-2853 | jillianai | working | 2026-09-28T11:14:53Z | server/oauth-provider.mjs, tests/oauth-provider-attack-cases.test.js
RC-2026-09-27-2861 | jillianai | working | 2026-09-28T12:02:30Z | server/moderation.mjs, tests/moderation.test.js
RC-2026-09-27-2862 | jillianai | working | 2026-09-28T12:51:10Z | server/display-name-guard.mjs, tests/display-name-guard.test.js
RC-2026-09-27-2863 | jillianai | working | 2026-09-28T12:55:34Z | docs/EXPORT-RETENTION-DELETION.md, server/room-attachment-bytes.mjs, server/store.mjs, tests/room-file-history-visibility.test.js

## file-claims
file | lane | task-id | state
cloudflare/http.check.mjs | codex | RC-2026-09-27-1167 | working
docs/EXPORT-RETENTION-DELETION.md | jillianai | RC-2026-09-27-2863 | working
docs/openapi.yaml | codex | RC-2026-09-27-1165 | working
index.html | codex | RC-2026-09-27-1165 | working
scripts/access-preview-browser-check.mjs | codex | RC-2026-09-27-1165 | working
server/board-v2-sqlite.mjs | codex | RC-2026-09-27-1167 | working
server/capability-visibility.mjs | jill | RC-2026-09-27-2743 | working
server/display-name-guard.mjs | jillianai | RC-2026-09-27-2862 | working
server/guest-invites.mjs | jillianai | RC-2026-09-27-2852 | working
server/http.mjs | codex | RC-2026-09-27-1165 | working
server/mcp-room-profile.mjs | jill | RC-2026-09-27-2743 | working
server/moderation.mjs | jillianai | RC-2026-09-27-2861 | working
server/oauth-provider.mjs | jillianai | RC-2026-09-27-2853 | working
server/owner-attention.mjs | codex | RC-2026-09-27-1165 | working
server/referral-invites.mjs | instinct | RC-2026-09-27-005 | working
server/room-attachment-bytes.mjs | jillianai | RC-2026-09-27-2863 | working
server/store.mjs | jillianai | RC-2026-09-27-2863 | working
src/client.js | codex | RC-2026-09-27-1165 | working
src/needs-attention.js | codex | RC-2026-09-27-1165 | working
tests/display-name-guard.test.js | jillianai | RC-2026-09-27-2862 | working
tests/guest-invite-flow.test.js | jillianai | RC-2026-09-27-2852 | working
tests/guest-join.test.js | jillianai | RC-2026-09-27-2852 | working
tests/mcp-calltime-denials.test.js | jill | RC-2026-09-27-2743 | working
tests/moderation.test.js | jillianai | RC-2026-09-27-2861 | working
tests/oauth-provider-attack-cases.test.js | jillianai | RC-2026-09-27-2853 | working
tests/owner-attention.test.js | codex | RC-2026-09-27-1165 | working
tests/referral-invites.test.js | instinct | RC-2026-09-27-005 | working
tests/room-file-history-visibility.test.js | jillianai | RC-2026-09-27-2863 | working
workspace/bounty-tournaments/BOARD.md | jill | RC-2026-09-27-2742 | working

## overlap-warnings
file | lanes | task-ids
(none)

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-27-2742 | jill | working | 2026-09-28T09:39:57Z | workspace/bounty-tournaments/BOARD.md
RC-2026-09-27-2743 | jill | working | 2026-09-28T10:46:50Z | server/mcp-room-profile.mjs, server/capability-visibility.mjs, tests/mcp-calltime-denials.test.js
RC-2026-09-27-2852 | jillianai | working | 2026-09-28T11:04:12Z | server/guest-invites.mjs, tests/guest-join.test.js, tests/guest-invite-flow.test.js
RC-2026-09-27-2853 | jillianai | working | 2026-09-28T11:14:53Z | server/oauth-provider.mjs, tests/oauth-provider-attack-cases.test.js
RC-2026-09-27-2861 | jillianai | working | 2026-09-28T12:02:30Z | server/moderation.mjs, tests/moderation.test.js
RC-2026-09-27-2862 | jillianai | working | 2026-09-28T12:51:10Z | server/display-name-guard.mjs, tests/display-name-guard.test.js
RC-2026-09-27-2863 | jillianai | working | 2026-09-28T12:55:34Z | docs/EXPORT-RETENTION-DELETION.md, server/room-attachment-bytes.mjs, server/store.mjs, tests/room-file-history-visibility.test.js

## unclaimed-lanes
lane | focus | trust
quill | bugs + quality + growth | elevated
quill-s2 | Rowboat-port + room-protocol workstream | standard
grokbot | merge + deploy | elevated
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
RC-2026-09-27-2860 | e4e4a7772fe0083eba3e1421c17f45ed5755f546 | 5864436660
RC-2026-09-27-2728 | 52d7ef79a321 | 5862811810
RC-2026-09-27-2741 | 52d7ef79a321 | 5862810404
RC-2026-09-27-2729 | bcf6d935a0f6a0567447446cc355987a2bdd7e86 | 5862178126
RC-2026-09-27-2732 | 254491bb8053a7f65fa65a703148017d486e1539 | 5862071060
RC-2026-09-27-2731 | 3de14c827d096900f54472d08f8b5d3e3b5b5ae7 | 5861944034
RC-2026-09-27-2730 | f9ce76b236c1027b20ff49470b5728b5cc67ffe3 | 5861418879
unknown | none | 5860766531
RC-2026-09-27-2726 | a33d701f08768456cf45a9b45b0c2180cb1937ef | 5860744551
RC-2026-09-27-2726 | a33d701f08768456cf45a9b45b0c2180cb1937ef | 5860743999

## prose-claims-needing-fence
comment-id | lane | task | at
(none)

## rotation
Uuriko/project-room#266 -> Uuriko/project-room#1160 · watermark 5859826064 · carried-open: RC-2026-09-27-005

## signals
board_comments=104 threshold=1500 rotation_due=no watcher=active open_claims=10 prose_open=0 unfenced_prose=0 files_claimed=29 overlap_files=0 watermark=5864991496

