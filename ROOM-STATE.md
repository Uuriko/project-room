# ROOM-STATE — machine board
<!-- generated: 2026-09-18T18:58:14Z · board: Uuriko/project-room#266 · watermark: 5734779541 · by: scripts/room rebuild · do-not-hand-edit -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-17-001 | quill-s2 | submitted | 2026-09-17T12:52:20Z | scripts/room, tests/room-prose-claims.test.js, docs/ROOM-PROTOCOL.md
RC-2026-09-16-004 | quill-s2 | submitted | 2026-09-17T18:17:54Z | ROOM-STATE.md, scripts/room, docs/ROOM-WATCH.md
RC-2026-09-16-005 | quill-s2 | submitted | 2026-09-17T18:29:38Z | docs/ROOM-ACTION-POLICY.md, scripts/room-digest, ROOM-HEALTH.md, docs/SWARM-PLUG-IN.md, docs/ROOM-WATCH.md
RC-2026-09-17-006 | quill | submitted | 2026-09-18T01:02:22Z | scripts/room
RC-2026-09-17-026 | (none) | submitted | 2026-09-18T07:09:35Z | server/bounty-disputes.mjs, tests/bounty-disputes.test.js
RC-2026-09-18-001 | (none) | submitted | 2026-09-18T07:36:18Z | server/dispute-arbiters.mjs, tests/dispute-arbiters.test.js
RC-2026-09-18-002 | (none) | submitted | 2026-09-18T07:49:58Z | server/dispute-arbiters.mjs, tests/dispute-arbiters.test.js
RC-2026-09-18-003 | (none) | submitted | 2026-09-18T08:06:37Z | server/bounty-disputes.mjs, tests/bounty-disputes.test.js
RC-2026-09-18-004 | (none) | submitted | 2026-09-18T08:23:05Z | docs/ROOM-PROTOCOL.md
RC-2026-09-18-005 | (none) | submitted | 2026-09-18T10:45:10Z | docs/README.md (Demigod / DIE matching table: one added row only)
RC-2026-09-18-006 | (none) | submitted | 2026-09-18T10:49:58Z | docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only)
RC-2026-09-18-007 | (none) | submitted | 2026-09-18T11:10:03Z | src/invite-context.js (new, side-effect-free helpers)
RC-2026-09-18-008 | quill | submitted | 2026-09-18T20:02:36Z | server/channel-adapters/sms.mjs, server/channel-adapters/messenger.mjs, server/sms-ingest.mjs, server/messenger-ingest.mjs, server/sms-outbound.mjs, server/messenger-outbound.mjs, server/channel-connection.mjs, server/channel-adapters/index.mjs, tests/channel-sms-adapter.test.js, tests/channel-messenger-adapter.test.js, tests/sms-ingest.test.js, tests/messenger-ingest.test.js, tests/sms-messenger-outbound.test.js
RC-2026-09-18-009 | quill | working | 2026-09-18T20:03:13Z | server/agent-api-keys.mjs, server/agent-directory.mjs, server/agent-plugin-manifest.mjs, server/agent-webhook-subscriptions.mjs, tests/agent-plugin-api-keys.test.js, tests/agent-plugin-directory.test.js, tests/agent-plugin-manifest.test.js, tests/agent-plugin-webhook-subs.test.js, tests/agent-plugin-loop.test.js
RC-2026-09-18-010 | quill | working | 2026-09-18T20:30:26Z | server/agent-plugin-store.mjs, server/agent-plugin-routes.mjs, server/store.mjs (agent-plugin wiring only), server/http.mjs (agent-plugin routes only), tests/agent-plugin-http.test.js
RC-2026-09-18-011 | quill | working | 2026-09-18T21:09:38Z | server/inbox-collab-store.mjs, server/inbox-collab-routes.mjs, server/inbox-handoff.mjs, server/http.mjs (collab routes only), server/store.mjs (collab wiring only), server/writer-fence.mjs (collab tables only), docs/openapi.yaml (collab route docs only), scripts/candidate-runtime-fixture.mjs (collab paths only), tests/runtime-package.test.js (count bump only), tests/inbox-collab-http.test.js
RC-2026-09-18-014 | quill | working | 2026-09-18T23:38:28Z | server/agent-card-signing.mjs, server/agent-directory.mjs, tests/agent-card-signing.test.js, docs/openapi.yaml, server/agent-plugin-routes.mjs, server/agent-plugin-store.mjs, tests/agent-plugin-directory.test.js, tests/agent-plugin-http.test.js, tests/agent-plugin-loop.test.js, tests/dogfood-agent-surface.test.js, tests/recovery.test.js
RC-2026-09-18-016 | quill | working | 2026-09-19T00:31:23Z | tests/recovery-comparison.test.js, tests/inbox-outbox.test.js

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-18-009 | quill | working | 2026-09-18T20:03:13Z | server/agent-api-keys.mjs, server/agent-directory.mjs, server/agent-plugin-manifest.mjs, server/agent-webhook-subscriptions.mjs, tests/agent-plugin-api-keys.test.js, tests/agent-plugin-directory.test.js, tests/agent-plugin-manifest.test.js, tests/agent-plugin-webhook-subs.test.js, tests/agent-plugin-loop.test.js
RC-2026-09-18-010 | quill | working | 2026-09-18T20:30:26Z | server/agent-plugin-store.mjs, server/agent-plugin-routes.mjs, server/store.mjs (agent-plugin wiring only), server/http.mjs (agent-plugin routes only), tests/agent-plugin-http.test.js
RC-2026-09-18-011 | quill | working | 2026-09-18T21:09:38Z | server/inbox-collab-store.mjs, server/inbox-collab-routes.mjs, server/inbox-handoff.mjs, server/http.mjs (collab routes only), server/store.mjs (collab wiring only), server/writer-fence.mjs (collab tables only), docs/openapi.yaml (collab route docs only), scripts/candidate-runtime-fixture.mjs (collab paths only), tests/runtime-package.test.js (count bump only), tests/inbox-collab-http.test.js
RC-2026-09-18-014 | quill | working | 2026-09-18T23:38:28Z | server/agent-card-signing.mjs, server/agent-directory.mjs, tests/agent-card-signing.test.js, docs/openapi.yaml, server/agent-plugin-routes.mjs, server/agent-plugin-store.mjs, tests/agent-plugin-directory.test.js, tests/agent-plugin-http.test.js, tests/agent-plugin-loop.test.js, tests/dogfood-agent-surface.test.js, tests/recovery.test.js
RC-2026-09-18-016 | quill | working | 2026-09-19T00:31:23Z | tests/recovery-comparison.test.js, tests/inbox-outbox.test.js

## unclaimed-lanes
lane | focus | trust
instinct | verify + infra | elevated
grokbot | merge + deploy | elevated
codex | design | standard
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
W25-2026 | none | 5734730735
W26-2026 | none | 5734455681
RC-2026-09-18-015 | 6d61cd488e06783d5740de65a11a51a67a8413f3 | 5734400834
unknown | none | 5734319452
unknown | none | 5734201175
INST-2026 | none | 5734185517
W23-2026 | none | 5734168932
INST-2026 | none | 5734141592
W22-2026 | none | 5734114047
INST-2026 | none | 5734069764

## prose-claims-needing-fence
comment-id | lane | task | at
5734779541 | Jillian | - | 2026-09-18T18:57:42Z
5734751693 | jill | - | 2026-09-18T18:55:14Z
5734701050 | Jillian | - | 2026-09-18T18:50:48Z
5734686428 | Jillian | - | 2026-09-18T18:49:30Z
5734603544 | Jillian | - | 2026-09-18T18:42:33Z
5734107950 | Jillian | - | 2026-09-18T18:01:21Z
5733245279 | quill | RC-2026-09-18-013 | 2026-09-18T16:50:12Z
5732805545 | quill | RC-2026-09-18-012 | 2026-09-18T16:13:26Z
5730776018 | quill | - | 2026-09-18T13:35:56Z
5724394766 | quill | RC-2026-09-17-029 | 2026-09-18T02:46:01Z
… +45 more

## signals
board_comments=743 threshold=1500 rotation_due=no watcher=active open_claims=18 prose_open=0 unfenced_prose=55 watermark=5734779541

