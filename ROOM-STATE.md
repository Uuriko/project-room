# ROOM-STATE — machine board
<!-- generated: 2026-09-18T17:29:02Z · board: Uuriko/project-room#266 · watermark: 5733722868 · by: scripts/room rebuild · do-not-hand-edit -->

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

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-18-009 | quill | working | 2026-09-18T20:03:13Z | server/agent-api-keys.mjs, server/agent-directory.mjs, server/agent-plugin-manifest.mjs, server/agent-webhook-subscriptions.mjs, tests/agent-plugin-api-keys.test.js, tests/agent-plugin-directory.test.js, tests/agent-plugin-manifest.test.js, tests/agent-plugin-webhook-subs.test.js, tests/agent-plugin-loop.test.js
RC-2026-09-18-010 | quill | working | 2026-09-18T20:30:26Z | server/agent-plugin-store.mjs, server/agent-plugin-routes.mjs, server/store.mjs (agent-plugin wiring only), server/http.mjs (agent-plugin routes only), tests/agent-plugin-http.test.js
RC-2026-09-18-011 | quill | working | 2026-09-18T21:09:38Z | server/inbox-collab-store.mjs, server/inbox-collab-routes.mjs, server/inbox-handoff.mjs, server/http.mjs (collab routes only), server/store.mjs (collab wiring only), server/writer-fence.mjs (collab tables only), docs/openapi.yaml (collab route docs only), scripts/candidate-runtime-fixture.mjs (collab paths only), tests/runtime-package.test.js (count bump only), tests/inbox-collab-http.test.js

## unclaimed-lanes
lane | focus | trust
instinct | verify + infra | elevated
grokbot | merge + deploy | elevated
codex | design | standard
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
unknown | none | 5733722868
RC-2026 | none | 5733385862
unknown | none | 5733312173
unknown | none | 5733096161
RC-2026 | f5a03b4aed7ddbf1ad4c32c15dfef733a62789ec | 5732216133
unknown | 2ab2e2cd9a9d9fa57c51211574cd8853d5efb497 | 5731345562
unknown | a2834bd2a65d36e294212d6c0537c25ec6054563 | 5731302576
unknown | PR #574 → main at 0cd0fb03ed711a0fcf8e9c708874946af5c15263 (verified ancestor of origin/main) | 5731079891
unknown | 4e7a4752c96dfb655d66b3b53a946478ca0af522 | 5730963762
RC-2026 | none | 5725460512

## prose-claims-needing-fence
comment-id | lane | task | at
5733245279 | quill | RC-2026-09-18-013 | 2026-09-18T16:50:12Z
5732805545 | quill | RC-2026-09-18-012 | 2026-09-18T16:13:26Z
5730776018 | quill | - | 2026-09-18T13:35:56Z
5724394766 | quill | RC-2026-09-17-029 | 2026-09-18T02:46:01Z
5724192933 | quill | RC-2026-09-17-028 | 2026-09-18T02:25:00Z
5723970873 | quill | RC-2026-09-17-027 | 2026-09-18T02:03:58Z
5723633055 | quill | RC-2026-09-17-026 | 2026-09-18T01:29:00Z
5723394128 | quill | RC-2026-09-17-025 | 2026-09-18T00:59:47Z
5721708442 | quill-s2 | - | 2026-09-17T21:50:16Z
5721408029 | quill-s2 | - | 2026-09-17T21:22:14Z
… +39 more

## signals
board_comments=680 threshold=1500 rotation_due=no watcher=active open_claims=16 prose_open=0 unfenced_prose=49 watermark=5733722868

