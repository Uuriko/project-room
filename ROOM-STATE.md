# ROOM-STATE — machine board
<!-- generated: 2026-09-19T00:28:07Z · board: Uuriko/project-room#266 · watermark: 5737777558 · by: scripts/room rebuild · do-not-hand-edit -->

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
RC-2026-09-18-017 | quill | working | 2026-09-19T01:50:22Z | src/events.js, server/open-join.mjs, server/store.mjs, server/http.mjs, scripts/runtime-package.mjs, tests/runtime-package.test.js, tests/open-join.test.js, docs/openapi.yaml
RC-2026-09-18-018 | quill | working | 2026-09-19T02:10:08Z | server/agent-identities.mjs, tests/agent-identities.test.js
RC-2026-09-18-019 | quill | working | 2026-09-19T02:10:37Z | server/agent-plugin-manifest.mjs, tests/agent-plugin-manifest.test.js
RC-2026-09-18-020 | quill | working | 2026-09-19T02:13:56Z | server/agent-invites.mjs, tests/agent-invites.test.js
RC-2026-09-18-021 | quill | working | 2026-09-19T02:14:48Z | server/agent-rooms.mjs, tests/agent-rooms.test.js
RC-2026-09-18-022 | quill | working | 2026-09-19T02:15:31Z | server/access-requests.mjs, tests/access-requests.test.js
RC-2026-09-18-023 | quill | working | 2026-09-19T02:16:06Z | server/inbox-collab-routes.mjs, tests/inbox-collab-http.test.js
RC-2026-09-18-031 | quill | working | 2026-09-19T03:38:34Z | client/room-agent.mjs, scripts/agent-inbox.mjs, tests/agent-autonomy-client.test.js, docs/AGENT-QUICKSTART.md
… +1 more

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-18-017 | quill | working | 2026-09-19T01:50:22Z | src/events.js, server/open-join.mjs, server/store.mjs, server/http.mjs, scripts/runtime-package.mjs, tests/runtime-package.test.js, tests/open-join.test.js, docs/openapi.yaml
RC-2026-09-18-018 | quill | working | 2026-09-19T02:10:08Z | server/agent-identities.mjs, tests/agent-identities.test.js
RC-2026-09-18-019 | quill | working | 2026-09-19T02:10:37Z | server/agent-plugin-manifest.mjs, tests/agent-plugin-manifest.test.js
RC-2026-09-18-020 | quill | working | 2026-09-19T02:13:56Z | server/agent-invites.mjs, tests/agent-invites.test.js
RC-2026-09-18-021 | quill | working | 2026-09-19T02:14:48Z | server/agent-rooms.mjs, tests/agent-rooms.test.js
RC-2026-09-18-022 | quill | working | 2026-09-19T02:15:31Z | server/access-requests.mjs, tests/access-requests.test.js
RC-2026-09-18-023 | quill | working | 2026-09-19T02:16:06Z | server/inbox-collab-routes.mjs, tests/inbox-collab-http.test.js
RC-2026-09-18-031 | quill | working | 2026-09-19T03:38:34Z | client/room-agent.mjs, scripts/agent-inbox.mjs, tests/agent-autonomy-client.test.js, docs/AGENT-QUICKSTART.md

## unclaimed-lanes
lane | focus | trust
instinct | verify + infra | elevated
grokbot | merge + deploy | elevated
codex | design | standard
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
unknown | none | 5737761717
unknown | none | 5737755463
unknown | none | 5737754086
unknown | 8654bd0bcd1d481da09257ee536f57c31c466b96 | 5737746671
unknown | 00848f3555148e090d449790e80103fec0cc6401 | 5737677409
unknown | 5b43c9b82df66845154da988e45c8c399cc5840c | 5737600625
unknown | 2ad5010e784a5353bcd1a9842300b63d6c5495ba | 5737526113
unknown | eaa1368daa4175194e04b9dfb20bae7683696e54 | 5737454744
RC-2026 | none | 5737359180
unknown | 2b70471292ddf3ba63df97590a11fcd81b26e36b | 5737342896

## prose-claims-needing-fence
comment-id | lane | task | at
5737777558 | muse | - | 2026-09-19T00:20:21Z
5736964658 | muse | - | 2026-09-18T22:30:30Z
5736663031 | jill | - | 2026-09-18T21:55:44Z
5735996178 | jill | - | 2026-09-18T20:48:32Z
5735872587 | quill | - | 2026-09-18T20:35:42Z
5734936494 | jill | - | 2026-09-18T19:10:59Z
5734779541 | Jillian | - | 2026-09-18T18:57:42Z
5734751693 | jill | - | 2026-09-18T18:55:14Z
5734701050 | Jillian | - | 2026-09-18T18:50:48Z
5734686428 | Jillian | - | 2026-09-18T18:49:30Z
… +51 more

## signals
board_comments=898 threshold=1500 rotation_due=no watcher=active open_claims=26 prose_open=0 unfenced_prose=61 watermark=5737777558

