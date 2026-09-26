# ROOM-STATE — machine board
<!-- generated: 2026-09-26T23:01:36Z · board: Uuriko/project-room#266 · watermark: 5850693692 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=1789b76925af09578dea291b231159f28da4c9f42476cc2f9597afe24d4dab47 -->

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
RC-2026-09-17-011 | Instinct (prose) | submitted | 2026-09-18T11:56:16Z | docs/verified-state-transition-ledger.md, server/http.mjs
RC-2026-09-18-008 | quill | submitted | 2026-09-18T20:02:36Z | server/channel-adapters/sms.mjs, server/channel-adapters/messenger.mjs, server/sms-ingest.mjs, server/messenger-ingest.mjs, server/sms-outbound.mjs, server/messenger-outbound.mjs, server/channel-connection.mjs, server/channel-adapters/index.mjs, tests/channel-sms-adapter.test.js, tests/channel-messenger-adapter.test.js, tests/sms-ingest.test.js, tests/messenger-ingest.test.js, tests/sms-messenger-outbound.test.js
RC-2026-09-18-009 | (none) | submitted | 2026-09-18T20:03:13Z | server/agent-api-keys.mjs, server/agent-directory.mjs, server/agent-plugin-manifest.mjs, server/agent-webhook-subscriptions.mjs, tests/agent-plugin-api-keys.test.js, tests/agent-plugin-directory.test.js, tests/agent-plugin-manifest.test.js, tests/agent-plugin-webhook-subs.test.js, tests/agent-plugin-loop.test.js
RC-2026-09-18-010 | (none) | submitted | 2026-09-18T20:30:26Z | server/agent-plugin-store.mjs, server/agent-plugin-routes.mjs, server/store.mjs (agent-plugin wiring only), server/http.mjs (agent-plugin routes only), tests/agent-plugin-http.test.js
RC-2026-09-18-011 | (none) | submitted | 2026-09-18T21:09:38Z | server/inbox-collab-store.mjs, server/inbox-collab-routes.mjs, server/inbox-handoff.mjs, server/http.mjs (collab routes only), server/store.mjs (collab wiring only), server/writer-fence.mjs (collab tables only), docs/openapi.yaml (collab route docs only), scripts/candidate-runtime-fixture.mjs (collab paths only), tests/runtime-package.test.js (count bump only), tests/inbox-collab-http.test.js
RC-2026-09-18-017 | (none) | submitted | 2026-09-19T01:50:22Z | src/events.js, server/open-join.mjs, server/store.mjs, server/http.mjs, scripts/runtime-package.mjs, tests/runtime-package.test.js, tests/open-join.test.js, docs/openapi.yaml
RC-2026-09-18-018 | (none) | submitted | 2026-09-19T02:10:08Z | server/agent-identities.mjs, tests/agent-identities.test.js
RC-2026-09-18-019 | (none) | submitted | 2026-09-19T02:10:49Z | server/agent-plugin-manifest.mjs, tests/agent-plugin-manifest.test.js
RC-2026-09-18-020 | (none) | submitted | 2026-09-19T02:13:56Z | server/agent-invites.mjs, tests/agent-invites.test.js
RC-2026-09-18-021 | (none) | submitted | 2026-09-19T02:14:48Z | server/agent-rooms.mjs, tests/agent-rooms.test.js
RC-2026-09-18-022 | (none) | submitted | 2026-09-19T02:15:31Z | server/access-requests.mjs, tests/access-requests.test.js
RC-2026-09-18-023 | (none) | submitted | 2026-09-19T02:16:06Z | server/inbox-collab-routes.mjs, tests/inbox-collab-http.test.js
RC-2026-09-18-033 | quill | submitted | 2026-09-19T04:00:11Z | client/room-agent.mjs, tests/agent-autonomy-client.test.js, docs/AGENT-QUICKSTART.md
… +53 more

## file-claims
file | lane | task-id | state
.github/workflows/act-components.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/activity-inbox.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/contribution-rollup.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/hosted-denial-conformance.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/mcp-registry-publish.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/member-capabilities.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/schema-gate.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/test.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/test.yml | jill | RC-2026-09-26-965 | working
NONE | instinct-comms | RC-2026-09-25-7403 | submitted
NONE (external black-box monitor) | instinct | RC-2026-09-23-902 | working
ROOM-HEALTH.md | quill-s2 | RC-2026-09-16-005 | submitted
ROOM-STATE.md | quill-s2 | RC-2026-09-16-004 | submitted
client/agent-connection.mjs | quill | RC-2026-09-19-082 | submitted
client/agent-connection.mjs | jill | RC-2026-09-26-965 | working
client/begin-work.mjs | jill | RC-2026-09-26-965 | working
client/mcp-stdio.mjs | codex | RC-2026-09-26-1120 | working
client/mcp-stdio.mjs | jill | RC-2026-09-26-965 | working
client/reply-actions.mjs | codex | RC-2026-09-26-1120 | working
client/room-agent.mjs | quill | RC-2026-09-18-033 | submitted
client/room-agent.mjs | codex | RC-2026-09-26-1120 | working
client/work-preparation.mjs | jill | RC-2026-09-26-965 | working
cloudflare/http.check.mjs | (none) | RC-2026-09-23-105 | submitted
cloudflare/package.json | jill | RC-2026-09-26-965 | working
cloudflare/room.mjs | jill | RC-2026-09-26-965 | working
cloudflare/version-signal.check.mjs | jill | RC-2026-09-26-965 | working
cloudflare/wrangler.jsonc | (none) | RC-2026-09-23-105 | submitted
cloudflare/wrangler.jsonc | jill | RC-2026-09-26-965 | working
connectors/muse.md | quill | RC-2026-09-19-079 | submitted
dasha-lobby-worker.mjs | swarm-sync | RC-2026 | submitted
deploy/agent-card-key.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-card-signed.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-24-010 | submitted
deploy/agent-discovery.mjs | jill | RC-2026-09-26-965 | working
docs/ADMIN-GUIDE.md | (none) | RC-2026-09-24-206 | submitted
docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only) | (none) | RC-2026-09-18-006 | submitted
docs/AGENT-CARD-CUSTODY.md | (none) | RC-2026-09-23-105 | submitted
docs/AGENT-QUICKSTART.md | quill | RC-2026-09-18-033 | submitted
docs/AGENT-QUICKSTART.md | codex | RC-2026-09-26-1120 | working
docs/BOARD-ROTATION-READINESS.md | jill | RC-2026-09-26-1113 | submitted
docs/BOARD-V2-DESIGN.md | jill | RC-2026-09-26-1114 | submitted
docs/CAPABILITY-REGISTRY.md | (none) | RC-2026-09-24-110 | submitted
docs/HEARTBEAT.md | grokbot | RC-2026-09-25-910 | submitted
docs/INVITE-ONLY-CHECKLIST.md | jill | RC-2026-09-26-965 | working
docs/README.md (Demigod / DIE matching table: one added row only) | (none) | RC-2026-09-18-005 | submitted
docs/RELEASE-CHECKPOINT.md | jill | RC-2026-09-26-965 | working
docs/ROOM-ACTION-POLICY.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-1132 | submitted
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-965 | working
docs/ROOM-MUTATION-TESTING.md | jill | RC-2026-09-26-1112 | working
docs/ROOM-PROTOCOL.md | quill-s2 | RC-2026-09-17-001 | submitted
docs/ROOM-PROTOCOL.md | (none) | RC-2026-09-18-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROUTE-AUTH-TABLE.md | jill | RC-2026-09-26-965 | working
docs/SAVED-AGENT-RECOVERY.md | jill | RC-2026-09-26-965 | working
docs/SWARM-PLUG-IN.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/SWARM-PLUG-IN.md | jill | RC-2026-09-26-965 | working
docs/examples/heartbeat.example.json | grokbot | RC-2026-09-25-910 | submitted
docs/examples/next-actions.example.json | jill | RC-2026-09-25-911 | submitted
docs/openapi.yaml | (none) | RC-2026-09-18-017 | submitted
docs/openapi.yaml | quill | RC-2026-09-19-068 | working
docs/openapi.yaml | jill | RC-2026-09-23-102 | working
docs/openapi.yaml | (none) | RC-2026-09-24-110 | submitted
docs/openapi.yaml | (none) | RC-2026-09-24-206 | submitted
docs/openapi.yaml | codex | RC-2026-09-26-1120 | working
docs/openapi.yaml | jill | RC-2026-09-26-965 | working
docs/openapi.yaml (collab route docs only) | (none) | RC-2026-09-18-011 | submitted
docs/room-health.html | jill | RC-2026-09-26-1116 | submitted
docs/self-serve-join.md | jill | RC-2026-09-25-912 | submitted
docs/verified-state-transition-ledger.md | Instinct | RC-2026-09-17-011 | submitted
index.html | (none) | RC-2026-09-19-054 | submitted
index.html | quill | RC-2026-09-19-068 | working
index.html | quill | RC-2026-09-19-088 | submitted
index.html | jill | RC-2026-09-26-965 | working
package.json | jill | RC-2026-09-26-1115 | working
scripts/accessibility-check.mjs | jill | RC-2026-09-26-965 | working
scripts/action-recovery-browser-check.mjs | jill | RC-2026-09-26-965 | working
scripts/agent-inbox.mjs | codex | RC-2026-09-26-1120 | working
scripts/auth-return-browser-check.mjs | jill | RC-2026-09-26-965 | working
scripts/browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/calm-return-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/candidate-runtime-fixture.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/candidate-runtime-fixture.mjs (collab paths only) | (none) | RC-2026-09-18-011 | submitted
scripts/connect-agent-first-screen-check.mjs | jill | RC-2026-09-26-965 | working
scripts/credit-question-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/deploy-live.py | jill | RC-2026-09-26-1132 | submitted
scripts/notification-feed-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/open-routes.mjs | jill | RC-2026-09-26-965 | working
scripts/openapi-method-accuracy.mjs | jill | RC-2026-09-26-965 | working
scripts/pinned-messages-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/quiet-copy-browser-check.mjs | jill | RC-2026-09-26-965 | working
scripts/ralph-loop.mjs | jill | RC-2026-09-26-1131 | submitted
scripts/release-checkpoint.mjs | jill | RC-2026-09-26-965 | working
scripts/room | quill-s2 | RC-2026-09-16-004 | submitted
scripts/room | quill-s2 | RC-2026-09-17-001 | submitted
scripts/room | quill | RC-2026-09-17-006 | submitted
scripts/room | jill | RC-2026-09-26-1130 | submitted
scripts/room | jill | RC-2026-09-26-1133 | submitted
scripts/room-chrome.mjs | quill | RC-2026-09-19-068 | working
scripts/room-chrome.mjs | jill | RC-2026-09-26-965 | working
scripts/room-digest | quill-s2 | RC-2026-09-16-005 | submitted
scripts/room-health.mjs | jill | RC-2026-09-26-1116 | submitted
scripts/room-mutate.mjs | jill | RC-2026-09-26-1112 | working
scripts/rotation-cutover.sh | jill | RC-2026-09-26-1113 | submitted
scripts/rotation-rehearse.sh | jill | RC-2026-09-26-1113 | submitted
scripts/route-docs-check.mjs | quill | RC-2026-09-19-081 | submitted
scripts/route-docs-check.mjs | jill | RC-2026-09-26-965 | working
scripts/runtime-package.mjs | (none) | RC-2026-09-18-017 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-23-102 | working
scripts/runtime-package.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/runtime-package.mjs | (none) | RC-2026-09-24-110 | submitted
scripts/runtime-package.mjs | grokbot | RC-2026-09-25-910 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-26-965 | working
scripts/sign-agent-card.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/workflow-browser-check.mjs | jill | RC-2026-09-26-965 | working
server/access-requests.mjs | (none) | RC-2026-09-18-022 | submitted
server/access-requests.mjs | quill | RC-2026-09-19-071 | submitted
server/access-requests.mjs | jill | RC-2026-09-26-965 | working
server/account-login-methods.mjs | quill | RC-2026-09-19-073 | submitted
server/activity.mjs | codex | RC-2026-09-26-1120 | working
server/agent-api-keys.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-connections.mjs | (none) | RC-2026-09-24-201 | submitted
server/agent-directory.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-heartbeat-routes.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-heartbeat-view.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-18-018 | submitted
server/agent-identities.mjs | quill | RC-2026-09-19-086 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-25-938 | submitted
server/agent-identities.mjs | jill | RC-2026-09-26-965 | working
server/agent-invites.mjs | (none) | RC-2026-09-18-020 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-019 | submitted
server/agent-plugin-routes.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-plugin-store.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-rooms.mjs | (none) | RC-2026-09-18-021 | submitted
server/agent-webhook-subscriptions.mjs | (none) | RC-2026-09-18-009 | submitted
server/attention.mjs | jill | RC-2026-09-21-001 | submitted
server/autonomy-tiers.mjs | (none) | RC-2026-09-24-206 | submitted
server/board-v2.mjs | jill | RC-2026-09-26-1114 | submitted
server/bonds.mjs | (none) | RC-2026-09-24-927 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-17-026 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-18-003 | submitted
server/capability-registry.mjs | (none) | RC-2026-09-24-110 | submitted
server/channel-adapters/index.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/messenger.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/sms.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-connection.mjs | quill | RC-2026-09-18-008 | submitted
server/claim-validate.mjs | (none) | RC-2026-09-24-204 | submitted
server/discoverability.mjs | jill | RC-2026-09-26-965 | working
server/dispute-arbiters.mjs | (none) | RC-2026-09-18-001 | submitted
server/dispute-arbiters.mjs | (none) | RC-2026-09-18-002 | submitted
server/github-oauth.mjs | quill | RC-2026-09-19-076 | submitted
server/google-oauth.mjs | quill | RC-2026-09-19-075 | submitted
server/google-oauth.mjs | quill | RC-2026-09-19-076 | submitted
server/guest-join-routes.mjs | jill | RC-2026-09-25-912 | submitted
server/guest-join.mjs | jill | RC-2026-09-25-912 | submitted
server/http.mjs | Instinct | RC-2026-09-17-011 | submitted
server/http.mjs | (none) | RC-2026-09-18-017 | submitted
server/http.mjs | quill | RC-2026-09-19-069 | submitted
server/http.mjs | quill | RC-2026-09-19-070 | submitted
server/http.mjs | quill | RC-2026-09-19-074 | submitted
server/http.mjs | quill | RC-2026-09-19-078 | submitted
server/http.mjs | quill | RC-2026-09-19-084 | submitted
server/http.mjs | quill | RC-2026-09-19-088 | submitted
server/http.mjs | jill | RC-2026-09-23-102 | working
server/http.mjs | (none) | RC-2026-09-24-206 | submitted
server/http.mjs | codex | RC-2026-09-26-1120 | working
server/http.mjs | jill | RC-2026-09-26-965 | working
server/http.mjs (agent-plugin routes only) | (none) | RC-2026-09-18-010 | submitted
server/http.mjs (collab routes only) | (none) | RC-2026-09-18-011 | submitted
server/identity-display-name.mjs | (none) | RC-2026-09-25-938 | submitted
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-023 | submitted
server/inbox-collab-store.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-handoff.mjs | (none) | RC-2026-09-18-011 | submitted
server/mcp-arg-errors.mjs | jill | RC-2026-09-26-965 | working
server/mcp-full-profile.mjs | jill | RC-2026-09-26-965 | working
server/mcp-hosted-tools.mjs | codex | RC-2026-09-26-1120 | working
server/mcp-room-profile.mjs | codex | RC-2026-09-26-1120 | working
server/mcp-room-profile.mjs | jill | RC-2026-09-26-965 | working
server/members-directory.mjs | (none) | RC-2026-09-24-202 | submitted
server/mention-lifecycle.mjs | codex | RC-2026-09-26-1120 | working
server/messenger-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/messenger-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/next-actions-routes.mjs | jill | RC-2026-09-25-911 | submitted
server/next-actions.mjs | jill | RC-2026-09-25-911 | submitted
server/open-join.mjs | (none) | RC-2026-09-18-017 | submitted
server/outbound-webhooks.mjs | quill | RC-2026-09-19-087 | submitted
server/owner-attention.mjs | jill | RC-2026-09-21-001 | submitted
server/receipts-search.mjs | (none) | RC-2026-09-24-205 | submitted
server/reply-requests.mjs | codex | RC-2026-09-26-1120 | working
server/room-lifecycle.mjs | quill | RC-2026-09-19-080 | submitted
server/room-lifecycle.mjs | quill | RC-2026-09-19-088 | submitted
server/sms-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/sms-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/spend-allowance.mjs | jillian | RC-2026-09-25-943 | working
server/store.mjs | (none) | RC-2026-09-18-017 | submitted
server/store.mjs | quill | RC-2026-09-19-068 | working
server/store.mjs | jill | RC-2026-09-23-102 | working
server/store.mjs | (none) | RC-2026-09-24-206 | submitted
server/store.mjs | codex | RC-2026-09-26-1120 | working
server/store.mjs (agent-plugin wiring only) | (none) | RC-2026-09-18-010 | submitted
server/store.mjs (collab wiring only) | (none) | RC-2026-09-18-011 | submitted
server/web-fetch.mjs (new) | jill | RC-2026-09-23-102 | working
server/work-context.mjs | codex | RC-2026-09-26-1120 | working
server/work-discussion.mjs | codex | RC-2026-09-26-1120 | working
server/writer-fence.mjs | jill | RC-2026-09-23-102 | working
server/writer-fence.mjs | (none) | RC-2026-09-24-206 | submitted
server/writer-fence.mjs (collab tables only) | (none) | RC-2026-09-18-011 | submitted
side-effect-free helpers) | (none) | RC-2026-09-18-007 | submitted
skills/ProjectRoom/AUTO-INVOKE.md | jill | RC-2026-09-26-965 | working
skills/ProjectRoom/SKILL.md | jill | RC-2026-09-26-965 | working
skills/project-room-onboarding/SKILL.md | codex | RC-2026-09-26-1120 | working
skills/project-room-onboarding/SKILL.md | jill | RC-2026-09-26-965 | working
skills/project-room/SKILL.md | jill | RC-2026-09-26-965 | working
skills/project-room/references/deep-connection.md | jill | RC-2026-09-26-965 | working
skills/project-room/references/tools.md | jill | RC-2026-09-26-965 | working
src/account-deletion.mjs | quill | RC-2026-09-19-078 | submitted
src/agent-error.mjs | jill | RC-2026-09-26-965 | working
src/app.js | quill | RC-2026-09-19-068 | working
src/app.js | quill | RC-2026-09-19-072 | submitted
src/app.js | quill | RC-2026-09-19-080 | submitted
src/app.js | quill | RC-2026-09-19-083 | submitted
src/app.js | quill | RC-2026-09-19-085 | submitted
src/app.js | quill | RC-2026-09-19-088 | submitted
src/app.js | jill | RC-2026-09-26-965 | working
src/auth-signin-ui.js | quill | RC-2026-09-19-077 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-088 | submitted
src/auth-signin-ui.js | jill | RC-2026-09-26-965 | working
src/conversation.js | quill | RC-2026-09-19-068 | working
src/events.js | (none) | RC-2026-09-18-017 | submitted
src/events.js | jillian | RC-2026-09-25-943 | working
src/invite-context.js | quill | RC-2026-09-19-071 | submitted
src/invite-context.js (new | (none) | RC-2026-09-18-007 | submitted
src/reply-requests.js | quill | RC-2026-09-19-068 | working
src/room-deep-link.js | jill | RC-2026-09-26-965 | working
src/room-mcp-join.js | jill | RC-2026-09-26-965 | working
src/share-links.js | (none) | RC-2026-09-19-054 | submitted
src/styles.css | jill | RC-2026-09-26-965 | working
src/workflow.js | jill | RC-2026-09-26-965 | working
tests/access-request-cancel.test.js | jill | RC-2026-09-26-965 | working
tests/access-requests.test.js | (none) | RC-2026-09-18-022 | submitted
tests/account-management.test.js | quill | RC-2026-09-19-078 | submitted
tests/agent-autonomy-client.test.js | quill | RC-2026-09-18-033 | submitted
tests/agent-card-wellknown.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-connection.test.js | jill | RC-2026-09-26-965 | working
tests/agent-connections-atomic.test.js | (none) | RC-2026-09-24-201 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-24-010 | submitted
tests/agent-error-next.test.js | jill | RC-2026-09-26-965 | working
tests/agent-heartbeat-view.test.js | grokbot | RC-2026-09-25-910 | submitted
tests/agent-identities.test.js | (none) | RC-2026-09-18-018 | submitted
tests/agent-identities.test.js | quill | RC-2026-09-19-086 | submitted
tests/agent-invites.test.js | (none) | RC-2026-09-18-020 | submitted
tests/agent-plugin-api-keys.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-directory.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-http.test.js | (none) | RC-2026-09-18-010 | submitted
tests/agent-plugin-loop.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-019 | submitted
tests/agent-plugin-webhook-subs.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-rooms.test.js | (none) | RC-2026-09-18-021 | submitted
tests/agent-work-search.test.js | jill | RC-2026-09-26-965 | working
tests/autonomy-tiers.test.js | (none) | RC-2026-09-24-206 | submitted
tests/backlog.test.js | jill | RC-2026-09-26-1133 | submitted
tests/begin-scope-retry.test.js | jill | RC-2026-09-26-965 | working
tests/begin-work.test.js | jill | RC-2026-09-26-965 | working
tests/board-v2.test.js | jill | RC-2026-09-26-1114 | submitted
tests/bonds.test.js | (none) | RC-2026-09-24-927 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-17-026 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-18-003 | submitted
tests/capability-registry.test.js | (none) | RC-2026-09-24-110 | submitted
tests/channel-messenger-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/channel-sms-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/claim-validate.test.js | (none) | RC-2026-09-24-204 | submitted
tests/claims-state-machine.property.test.js | jill | RC-2026-09-26-1115 | working
tests/cli-invite.test.js | quill | RC-2026-09-19-082 | submitted
tests/cold-start-friction.test.js | jill | RC-2026-09-26-965 | working
tests/connector-briefs.test.js | quill | RC-2026-09-19-079 | submitted
tests/credit-question.test.js | quill | RC-2026-09-19-068 | working
tests/current-attention-integration.test.js | jill | RC-2026-09-26-965 | working
tests/directory-card-withdrawal.test.js | quill | RC-2026-09-19-084 | submitted
tests/discoverability.test.js | jill | RC-2026-09-26-965 | working
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-001 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-002 | submitted
tests/dm-privacy.test.js | quill | RC-2026-09-19-070 | submitted
tests/first-paint.test.js | quill | RC-2026-09-19-085 | submitted
tests/first-run-landing.test.js | quill | RC-2026-09-19-088 | submitted
tests/focused-orientation.test.js | jill | RC-2026-09-26-965 | working
tests/google-oauth-email.test.js | quill | RC-2026-09-19-075 | submitted
tests/guest-agent-links.test.js | jill | RC-2026-09-26-965 | working
tests/guest-join.test.js | jill | RC-2026-09-25-912 | submitted
tests/handoff-renderer.test.js | quill | RC-2026-09-19-072 | submitted
tests/help-discovery.test.js | jill | RC-2026-09-26-965 | working
tests/identity-display-name.test.js | (none) | RC-2026-09-25-938 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-011 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-023 | submitted
tests/job-heartbeat.test.js | jill | RC-2026-09-26-965 | working
tests/join-p2s.test.js | quill | RC-2026-09-19-071 | submitted
tests/magic-account-switch.test.js | quill | RC-2026-09-19-074 | submitted
tests/magic-invalidation.test.js | quill | RC-2026-09-19-073 | submitted
tests/mcp-integration.test.js | jill | RC-2026-09-26-965 | working
tests/mcp-stdio.test.js | jill | RC-2026-09-26-965 | working
tests/members-directory.test.js | (none) | RC-2026-09-24-202 | submitted
tests/mention-lifecycle.test.js | codex | RC-2026-09-26-1120 | working
tests/messenger-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/next-actions.test.js | jill | RC-2026-09-25-911 | submitted
tests/oauth-stateless.test.js | quill | RC-2026-09-19-076 | submitted
tests/open-join.test.js | (none) | RC-2026-09-18-017 | submitted
tests/ralph-loop.test.js | jill | RC-2026-09-26-1131 | submitted
tests/receipts-search.test.js | (none) | RC-2026-09-24-205 | submitted
tests/release-checkpoint.test.js | jill | RC-2026-09-26-965 | working
tests/reply-requests.test.js | codex | RC-2026-09-26-1120 | working
tests/room-creation.test.js | quill | RC-2026-09-19-080 | submitted
tests/room-deep-link.test.js | jill | RC-2026-09-26-965 | working
tests/room-prose-claims.test.js | quill-s2 | RC-2026-09-17-001 | submitted
tests/room-protocol-mutation.test.js | jill | RC-2026-09-26-1112 | working
tests/room-roster.test.js | jill | RC-2026-09-26-965 | working
tests/room-watch-enforcer.test.sh | jill | RC-2026-09-26-1130 | submitted
tests/route-docs-check.test.js | quill | RC-2026-09-19-081 | submitted
tests/route-docs-check.test.js | jill | RC-2026-09-26-965 | working
tests/runtime-package.test.js | (none) | RC-2026-09-18-017 | submitted
tests/runtime-package.test.js | grokbot | RC-2026-09-25-910 | submitted
tests/runtime-package.test.js | jill | RC-2026-09-26-965 | working
tests/runtime-package.test.js (count bump only) | (none) | RC-2026-09-18-011 | submitted
tests/session-fixation.test.js | quill | RC-2026-09-19-069 | submitted
tests/share-link-ui.test.js | (none) | RC-2026-09-19-054 | submitted
tests/signin-error-visibility.test.js | quill | RC-2026-09-19-077 | submitted
tests/sms-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/sms-messenger-outbound.test.js | quill | RC-2026-09-18-008 | submitted
tests/spend-allowance.test.js | jillian | RC-2026-09-25-943 | working
tests/ux-copy.test.js | quill | RC-2026-09-19-083 | submitted
tests/web-fetch.test.js (new) | jill | RC-2026-09-23-102 | working
tests/work-context.test.js | codex | RC-2026-09-26-1120 | working
tests/work-discussion.test.js | codex | RC-2026-09-26-1120 | working
tests/work-discussion.test.js | jill | RC-2026-09-26-965 | working
tests/work-preparation.test.js | jill | RC-2026-09-26-965 | working
tests/workflow.test.js | jill | RC-2026-09-26-965 | working

## overlap-warnings
file | lanes | task-ids
.github/workflows/test.yml | jill | RC-2026-09-26-1121, RC-2026-09-26-965
client/agent-connection.mjs | jill, quill | RC-2026-09-19-082, RC-2026-09-26-965
client/mcp-stdio.mjs | codex, jill | RC-2026-09-26-1120, RC-2026-09-26-965
client/room-agent.mjs | codex, quill | RC-2026-09-18-033, RC-2026-09-26-1120
cloudflare/wrangler.jsonc | , jill | RC-2026-09-23-105, RC-2026-09-26-965
deploy/agent-discovery.mjs | , jill | RC-2026-09-23-105, RC-2026-09-24-010, RC-2026-09-26-965
docs/AGENT-QUICKSTART.md | codex, quill | RC-2026-09-18-033, RC-2026-09-26-1120
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-1132, RC-2026-09-26-965
docs/ROOM-PROTOCOL.md | , quill-s2 | RC-2026-09-17-001, RC-2026-09-18-004
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004, RC-2026-09-16-005
docs/SWARM-PLUG-IN.md | jill, quill-s2 | RC-2026-09-16-005, RC-2026-09-26-965
docs/openapi.yaml | , codex, jill, quill | RC-2026-09-18-017, RC-2026-09-19-068, RC-2026-09-23-102, RC-2026-09-24-110, RC-2026-09-24-206, RC-2026-09-26-1120, RC-2026-09-26-965
index.html | , jill, quill | RC-2026-09-19-054, RC-2026-09-19-068, RC-2026-09-19-088, RC-2026-09-26-965
scripts/room | jill, quill, quill-s2 | RC-2026-09-16-004, RC-2026-09-17-001, RC-2026-09-17-006, RC-2026-09-26-1130, RC-2026-09-26-1133
scripts/room-chrome.mjs | jill, quill | RC-2026-09-19-068, RC-2026-09-26-965
scripts/route-docs-check.mjs | jill, quill | RC-2026-09-19-081, RC-2026-09-26-965
scripts/runtime-package.mjs | , grokbot, jill | RC-2026-09-18-017, RC-2026-09-23-102, RC-2026-09-23-105, RC-2026-09-24-110, RC-2026-09-25-910, RC-2026-09-26-965
server/access-requests.mjs | , jill, quill | RC-2026-09-18-022, RC-2026-09-19-071, RC-2026-09-26-965
server/agent-identities.mjs | , jill, quill | RC-2026-09-18-018, RC-2026-09-19-086, RC-2026-09-25-938, RC-2026-09-26-965
server/agent-plugin-manifest.mjs |  | RC-2026-09-18-009, RC-2026-09-18-019
server/bounty-disputes.mjs |  | RC-2026-09-17-026, RC-2026-09-18-003
server/dispute-arbiters.mjs |  | RC-2026-09-18-001, RC-2026-09-18-002
server/google-oauth.mjs | quill | RC-2026-09-19-075, RC-2026-09-19-076
server/http.mjs | , Instinct, codex, jill, quill | RC-2026-09-17-011, RC-2026-09-18-017, RC-2026-09-19-069, RC-2026-09-19-070, RC-2026-09-19-074, RC-2026-09-19-078, RC-2026-09-19-084, RC-2026-09-19-088, RC-2026-09-23-102, RC-2026-09-24-206, RC-2026-09-26-1120, RC-2026-09-26-965
server/inbox-collab-routes.mjs |  | RC-2026-09-18-011, RC-2026-09-18-023
server/mcp-room-profile.mjs | codex, jill | RC-2026-09-26-1120, RC-2026-09-26-965
server/room-lifecycle.mjs | quill | RC-2026-09-19-080, RC-2026-09-19-088
server/store.mjs | , codex, jill, quill | RC-2026-09-18-017, RC-2026-09-19-068, RC-2026-09-23-102, RC-2026-09-24-206, RC-2026-09-26-1120
server/writer-fence.mjs | , jill | RC-2026-09-23-102, RC-2026-09-24-206
skills/project-room-onboarding/SKILL.md | codex, jill | RC-2026-09-26-1120, RC-2026-09-26-965
src/app.js | jill, quill | RC-2026-09-19-068, RC-2026-09-19-072, RC-2026-09-19-080, RC-2026-09-19-083, RC-2026-09-19-085, RC-2026-09-19-088, RC-2026-09-26-965
src/auth-signin-ui.js | jill, quill | RC-2026-09-19-077, RC-2026-09-19-088, RC-2026-09-26-965
src/events.js | , jillian | RC-2026-09-18-017, RC-2026-09-25-943
tests/agent-discovery.test.js |  | RC-2026-09-23-105, RC-2026-09-24-010
tests/agent-identities.test.js | , quill | RC-2026-09-18-018, RC-2026-09-19-086
tests/agent-plugin-manifest.test.js |  | RC-2026-09-18-009, RC-2026-09-18-019
tests/bounty-disputes.test.js |  | RC-2026-09-17-026, RC-2026-09-18-003
tests/dispute-arbiters.test.js |  | RC-2026-09-18-001, RC-2026-09-18-002
tests/inbox-collab-http.test.js |  | RC-2026-09-18-011, RC-2026-09-18-023
tests/route-docs-check.test.js | jill, quill | RC-2026-09-19-081, RC-2026-09-26-965
tests/runtime-package.test.js | , grokbot, jill | RC-2026-09-18-017, RC-2026-09-25-910, RC-2026-09-26-965
tests/work-discussion.test.js | codex, jill | RC-2026-09-26-1120, RC-2026-09-26-965

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-26-1120 | codex | working | 2026-09-26T23:29:08Z | server/mention-lifecycle.mjs, server/activity.mjs, server/store.mjs, server/work-context.mjs, server/work-discussion.mjs, server/http.mjs, client/reply-actions.mjs, client/room-agent.mjs, server/reply-requests.mjs, server/mcp-room-profile.mjs, client/mcp-stdio.mjs, server/mcp-hosted-tools.mjs, scripts/agent-inbox.mjs, docs/AGENT-QUICKSTART.md, docs/openapi.yaml, skills/project-room-onboarding/SKILL.md, tests/mention-lifecycle.test.js, tests/work-context.test.js, tests/work-discussion.test.js, tests/reply-requests.test.js
RC-2026-09-25-943 | jillian | working | 2026-09-27T00:40:39Z | src/events.js, server/spend-allowance.mjs, tests/spend-allowance.test.js
RC-2026-09-26-965 | jill | working | 2026-09-27T01:48:56Z | .github/workflows/test.yml, client/agent-connection.mjs, client/begin-work.mjs, client/mcp-stdio.mjs, client/work-preparation.mjs, cloudflare/package.json, cloudflare/room.mjs, cloudflare/version-signal.check.mjs, cloudflare/wrangler.jsonc, deploy/agent-discovery.mjs, docs/INVITE-ONLY-CHECKLIST.md, docs/RELEASE-CHECKPOINT.md, docs/ROOM-DEPLOYMENT.md, docs/ROUTE-AUTH-TABLE.md, docs/SAVED-AGENT-RECOVERY.md, docs/SWARM-PLUG-IN.md, docs/openapi.yaml, index.html, scripts/accessibility-check.mjs, scripts/action-recovery-browser-check.mjs, scripts/auth-return-browser-check.mjs, scripts/connect-agent-first-screen-check.mjs, scripts/open-routes.mjs, scripts/openapi-method-accuracy.mjs, scripts/quiet-copy-browser-check.mjs, scripts/release-checkpoint.mjs, scripts/room-chrome.mjs, scripts/route-docs-check.mjs, scripts/runtime-package.mjs, scripts/workflow-browser-check.mjs, server/access-requests.mjs, server/agent-identities.mjs, server/discoverability.mjs, server/http.mjs, server/mcp-arg-errors.mjs, server/mcp-full-profile.mjs, server/mcp-room-profile.mjs, skills/ProjectRoom/AUTO-INVOKE.md, skills/ProjectRoom/SKILL.md, skills/project-room-onboarding/SKILL.md, skills/project-room/SKILL.md, skills/project-room/references/deep-connection.md, skills/project-room/references/tools.md, src/agent-error.mjs, src/app.js, src/auth-signin-ui.js, src/room-deep-link.js, src/room-mcp-join.js, src/styles.css, src/workflow.js, tests/access-request-cancel.test.js, tests/agent-connection.test.js, tests/agent-error-next.test.js, tests/agent-work-search.test.js, tests/begin-scope-retry.test.js, tests/begin-work.test.js, tests/cold-start-friction.test.js, tests/current-attention-integration.test.js, tests/discoverability.test.js, tests/focused-orientation.test.js, tests/guest-agent-links.test.js, tests/help-discovery.test.js, tests/job-heartbeat.test.js, tests/mcp-integration.test.js, tests/mcp-stdio.test.js, tests/release-checkpoint.test.js, tests/room-deep-link.test.js, tests/room-roster.test.js, tests/route-docs-check.test.js, tests/runtime-package.test.js, tests/work-discussion.test.js, tests/work-preparation.test.js, tests/workflow.test.js
RC-2026-09-26-1115 | jill | working | 2026-09-27T03:26:23Z | tests/claims-state-machine.property.test.js, package.json
RC-2026-09-26-1112 | jill | working | 2026-09-27T03:29:16Z | tests/room-protocol-mutation.test.js, scripts/room-mutate.mjs, docs/ROOM-MUTATION-TESTING.md
RC-2026-09-26-1121 | jill | working | 2026-09-27T03:53:23Z | .github/workflows/test.yml, .github/workflows/act-components.yml, .github/workflows/activity-inbox.yml, .github/workflows/contribution-rollup.yml, .github/workflows/hosted-denial-conformance.yml, .github/workflows/mcp-registry-publish.yml, .github/workflows/member-capabilities.yml, .github/workflows/schema-gate.yml

## unclaimed-lanes
lane | focus | trust
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
RC-2026-09-26-1110 | ca1a174cb76c446062178aa5e339e5a4393ad418 | 5850416896
RC-2026-09-26-1110 | ca1a174cb76c446062178aa5e339e5a4393ad418 | 5850415704
RC-2026-09-26-1117 | 304fffc7b8b2c39ace4cf2fe5e1a3264f966462e | 5850318678
RC-2026-09-26-1117 | 304fffc7b8b2c39ace4cf2fe5e1a3264f966462e | 5850296794
RC-2026-09-26-1117 | 304fffc7b8b2c39ace4cf2fe5e1a3264f966462e | 5850295901
RC-2026-09-25-304 | fb2ef7aa7811b7beab62f1fdd39203748ac17851 | 5850220126
RC-2026-09-25-303 | 70baf7d1dced374cd3d4083a0027036294890058 | 5850219368
RC-2026-09-26-966 | 008d95758e54803d31319fb567512b4ae749e35e | 5850118285
RC-2026-09-26-969 | cd05f2e743cf27e2b89b8460c81c4b32ce092ff3 | 5850117681
RC-2026-09-26-962 | 2ca51653fe382d6b45ad77ac8878bdeb578bd0a6 | 5850117193

## prose-claims-needing-fence
comment-id | lane | task | at
.github/workflows/act-components.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/activity-inbox.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/contribution-rollup.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/hosted-denial-conformance.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/mcp-registry-publish.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/member-capabilities.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/schema-gate.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/test.yml | jill | RC-2026-09-26-1121 | working
.github/workflows/test.yml | jill | RC-2026-09-26-965 | working
NONE | instinct-comms | RC-2026-09-25-7403 | submitted
NONE (external black-box monitor) | instinct | RC-2026-09-23-902 | working
ROOM-HEALTH.md | quill-s2 | RC-2026-09-16-005 | submitted
ROOM-STATE.md | quill-s2 | RC-2026-09-16-004 | submitted
client/agent-connection.mjs | quill | RC-2026-09-19-082 | submitted
client/agent-connection.mjs | jill | RC-2026-09-26-965 | working
client/begin-work.mjs | jill | RC-2026-09-26-965 | working
client/mcp-stdio.mjs | codex | RC-2026-09-26-1120 | working
client/mcp-stdio.mjs | jill | RC-2026-09-26-965 | working
client/reply-actions.mjs | codex | RC-2026-09-26-1120 | working
client/room-agent.mjs | quill | RC-2026-09-18-033 | submitted
client/room-agent.mjs | codex | RC-2026-09-26-1120 | working
client/work-preparation.mjs | jill | RC-2026-09-26-965 | working
cloudflare/http.check.mjs | (none) | RC-2026-09-23-105 | submitted
cloudflare/package.json | jill | RC-2026-09-26-965 | working
cloudflare/room.mjs | jill | RC-2026-09-26-965 | working
cloudflare/version-signal.check.mjs | jill | RC-2026-09-26-965 | working
cloudflare/wrangler.jsonc | (none) | RC-2026-09-23-105 | submitted
cloudflare/wrangler.jsonc | jill | RC-2026-09-26-965 | working
connectors/muse.md | quill | RC-2026-09-19-079 | submitted
dasha-lobby-worker.mjs | swarm-sync | RC-2026 | submitted
deploy/agent-card-key.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-card-signed.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-24-010 | submitted
deploy/agent-discovery.mjs | jill | RC-2026-09-26-965 | working
docs/ADMIN-GUIDE.md | (none) | RC-2026-09-24-206 | submitted
docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only) | (none) | RC-2026-09-18-006 | submitted
docs/AGENT-CARD-CUSTODY.md | (none) | RC-2026-09-23-105 | submitted
docs/AGENT-QUICKSTART.md | quill | RC-2026-09-18-033 | submitted
docs/AGENT-QUICKSTART.md | codex | RC-2026-09-26-1120 | working
docs/BOARD-ROTATION-READINESS.md | jill | RC-2026-09-26-1113 | submitted
docs/BOARD-V2-DESIGN.md | jill | RC-2026-09-26-1114 | submitted
docs/CAPABILITY-REGISTRY.md | (none) | RC-2026-09-24-110 | submitted
docs/HEARTBEAT.md | grokbot | RC-2026-09-25-910 | submitted
docs/INVITE-ONLY-CHECKLIST.md | jill | RC-2026-09-26-965 | working
docs/README.md (Demigod / DIE matching table: one added row only) | (none) | RC-2026-09-18-005 | submitted
docs/RELEASE-CHECKPOINT.md | jill | RC-2026-09-26-965 | working
docs/ROOM-ACTION-POLICY.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-1132 | submitted
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-965 | working
docs/ROOM-MUTATION-TESTING.md | jill | RC-2026-09-26-1112 | working
docs/ROOM-PROTOCOL.md | quill-s2 | RC-2026-09-17-001 | submitted
docs/ROOM-PROTOCOL.md | (none) | RC-2026-09-18-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROUTE-AUTH-TABLE.md | jill | RC-2026-09-26-965 | working
docs/SAVED-AGENT-RECOVERY.md | jill | RC-2026-09-26-965 | working
docs/SWARM-PLUG-IN.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/SWARM-PLUG-IN.md | jill | RC-2026-09-26-965 | working
docs/examples/heartbeat.example.json | grokbot | RC-2026-09-25-910 | submitted
docs/examples/next-actions.example.json | jill | RC-2026-09-25-911 | submitted
docs/openapi.yaml | (none) | RC-2026-09-18-017 | submitted
docs/openapi.yaml | quill | RC-2026-09-19-068 | working
docs/openapi.yaml | jill | RC-2026-09-23-102 | working
docs/openapi.yaml | (none) | RC-2026-09-24-110 | submitted
docs/openapi.yaml | (none) | RC-2026-09-24-206 | submitted
docs/openapi.yaml | codex | RC-2026-09-26-1120 | working
docs/openapi.yaml | jill | RC-2026-09-26-965 | working
docs/openapi.yaml (collab route docs only) | (none) | RC-2026-09-18-011 | submitted
docs/room-health.html | jill | RC-2026-09-26-1116 | submitted
docs/self-serve-join.md | jill | RC-2026-09-25-912 | submitted
docs/verified-state-transition-ledger.md | Instinct | RC-2026-09-17-011 | submitted
index.html | (none) | RC-2026-09-19-054 | submitted
index.html | quill | RC-2026-09-19-068 | working
index.html | quill | RC-2026-09-19-088 | submitted
index.html | jill | RC-2026-09-26-965 | working
package.json | jill | RC-2026-09-26-1115 | working
scripts/accessibility-check.mjs | jill | RC-2026-09-26-965 | working
scripts/action-recovery-browser-check.mjs | jill | RC-2026-09-26-965 | working
scripts/agent-inbox.mjs | codex | RC-2026-09-26-1120 | working
scripts/auth-return-browser-check.mjs | jill | RC-2026-09-26-965 | working
scripts/browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/calm-return-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/candidate-runtime-fixture.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/candidate-runtime-fixture.mjs (collab paths only) | (none) | RC-2026-09-18-011 | submitted
scripts/connect-agent-first-screen-check.mjs | jill | RC-2026-09-26-965 | working
scripts/credit-question-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/deploy-live.py | jill | RC-2026-09-26-1132 | submitted
scripts/notification-feed-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/open-routes.mjs | jill | RC-2026-09-26-965 | working
scripts/openapi-method-accuracy.mjs | jill | RC-2026-09-26-965 | working
scripts/pinned-messages-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/quiet-copy-browser-check.mjs | jill | RC-2026-09-26-965 | working
scripts/ralph-loop.mjs | jill | RC-2026-09-26-1131 | submitted
scripts/release-checkpoint.mjs | jill | RC-2026-09-26-965 | working
scripts/room | quill-s2 | RC-2026-09-16-004 | submitted
scripts/room | quill-s2 | RC-2026-09-17-001 | submitted
scripts/room | quill | RC-2026-09-17-006 | submitted
scripts/room | jill | RC-2026-09-26-1130 | submitted
scripts/room | jill | RC-2026-09-26-1133 | submitted
scripts/room-chrome.mjs | quill | RC-2026-09-19-068 | working
scripts/room-chrome.mjs | jill | RC-2026-09-26-965 | working
scripts/room-digest | quill-s2 | RC-2026-09-16-005 | submitted
scripts/room-health.mjs | jill | RC-2026-09-26-1116 | submitted
scripts/room-mutate.mjs | jill | RC-2026-09-26-1112 | working
scripts/rotation-cutover.sh | jill | RC-2026-09-26-1113 | submitted
scripts/rotation-rehearse.sh | jill | RC-2026-09-26-1113 | submitted
scripts/route-docs-check.mjs | quill | RC-2026-09-19-081 | submitted
scripts/route-docs-check.mjs | jill | RC-2026-09-26-965 | working
scripts/runtime-package.mjs | (none) | RC-2026-09-18-017 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-23-102 | working
scripts/runtime-package.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/runtime-package.mjs | (none) | RC-2026-09-24-110 | submitted
scripts/runtime-package.mjs | grokbot | RC-2026-09-25-910 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-26-965 | working
scripts/sign-agent-card.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/workflow-browser-check.mjs | jill | RC-2026-09-26-965 | working
server/access-requests.mjs | (none) | RC-2026-09-18-022 | submitted
server/access-requests.mjs | quill | RC-2026-09-19-071 | submitted
server/access-requests.mjs | jill | RC-2026-09-26-965 | working
server/account-login-methods.mjs | quill | RC-2026-09-19-073 | submitted
server/activity.mjs | codex | RC-2026-09-26-1120 | working
server/agent-api-keys.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-connections.mjs | (none) | RC-2026-09-24-201 | submitted
server/agent-directory.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-heartbeat-routes.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-heartbeat-view.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-18-018 | submitted
server/agent-identities.mjs | quill | RC-2026-09-19-086 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-25-938 | submitted
server/agent-identities.mjs | jill | RC-2026-09-26-965 | working
server/agent-invites.mjs | (none) | RC-2026-09-18-020 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-019 | submitted
server/agent-plugin-routes.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-plugin-store.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-rooms.mjs | (none) | RC-2026-09-18-021 | submitted
server/agent-webhook-subscriptions.mjs | (none) | RC-2026-09-18-009 | submitted
server/attention.mjs | jill | RC-2026-09-21-001 | submitted
server/autonomy-tiers.mjs | (none) | RC-2026-09-24-206 | submitted
server/board-v2.mjs | jill | RC-2026-09-26-1114 | submitted
server/bonds.mjs | (none) | RC-2026-09-24-927 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-17-026 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-18-003 | submitted
server/capability-registry.mjs | (none) | RC-2026-09-24-110 | submitted
server/channel-adapters/index.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/messenger.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/sms.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-connection.mjs | quill | RC-2026-09-18-008 | submitted
server/claim-validate.mjs | (none) | RC-2026-09-24-204 | submitted
server/discoverability.mjs | jill | RC-2026-09-26-965 | working
server/dispute-arbiters.mjs | (none) | RC-2026-09-18-001 | submitted
server/dispute-arbiters.mjs | (none) | RC-2026-09-18-002 | submitted
server/github-oauth.mjs | quill | RC-2026-09-19-076 | submitted
server/google-oauth.mjs | quill | RC-2026-09-19-075 | submitted
server/google-oauth.mjs | quill | RC-2026-09-19-076 | submitted
server/guest-join-routes.mjs | jill | RC-2026-09-25-912 | submitted
server/guest-join.mjs | jill | RC-2026-09-25-912 | submitted
server/http.mjs | Instinct | RC-2026-09-17-011 | submitted
server/http.mjs | (none) | RC-2026-09-18-017 | submitted
server/http.mjs | quill | RC-2026-09-19-069 | submitted
server/http.mjs | quill | RC-2026-09-19-070 | submitted
server/http.mjs | quill | RC-2026-09-19-074 | submitted
server/http.mjs | quill | RC-2026-09-19-078 | submitted
server/http.mjs | quill | RC-2026-09-19-084 | submitted
server/http.mjs | quill | RC-2026-09-19-088 | submitted
server/http.mjs | jill | RC-2026-09-23-102 | working
server/http.mjs | (none) | RC-2026-09-24-206 | submitted
server/http.mjs | codex | RC-2026-09-26-1120 | working
server/http.mjs | jill | RC-2026-09-26-965 | working
server/http.mjs (agent-plugin routes only) | (none) | RC-2026-09-18-010 | submitted
server/http.mjs (collab routes only) | (none) | RC-2026-09-18-011 | submitted
server/identity-display-name.mjs | (none) | RC-2026-09-25-938 | submitted
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-023 | submitted
server/inbox-collab-store.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-handoff.mjs | (none) | RC-2026-09-18-011 | submitted
server/mcp-arg-errors.mjs | jill | RC-2026-09-26-965 | working
server/mcp-full-profile.mjs | jill | RC-2026-09-26-965 | working
server/mcp-hosted-tools.mjs | codex | RC-2026-09-26-1120 | working
server/mcp-room-profile.mjs | codex | RC-2026-09-26-1120 | working
server/mcp-room-profile.mjs | jill | RC-2026-09-26-965 | working
server/members-directory.mjs | (none) | RC-2026-09-24-202 | submitted
server/mention-lifecycle.mjs | codex | RC-2026-09-26-1120 | working
server/messenger-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/messenger-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/next-actions-routes.mjs | jill | RC-2026-09-25-911 | submitted
server/next-actions.mjs | jill | RC-2026-09-25-911 | submitted
server/open-join.mjs | (none) | RC-2026-09-18-017 | submitted
server/outbound-webhooks.mjs | quill | RC-2026-09-19-087 | submitted
server/owner-attention.mjs | jill | RC-2026-09-21-001 | submitted
server/receipts-search.mjs | (none) | RC-2026-09-24-205 | submitted
server/reply-requests.mjs | codex | RC-2026-09-26-1120 | working
server/room-lifecycle.mjs | quill | RC-2026-09-19-080 | submitted
server/room-lifecycle.mjs | quill | RC-2026-09-19-088 | submitted
server/sms-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/sms-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/spend-allowance.mjs | jillian | RC-2026-09-25-943 | working
server/store.mjs | (none) | RC-2026-09-18-017 | submitted
server/store.mjs | quill | RC-2026-09-19-068 | working
server/store.mjs | jill | RC-2026-09-23-102 | working
server/store.mjs | (none) | RC-2026-09-24-206 | submitted
server/store.mjs | codex | RC-2026-09-26-1120 | working
server/store.mjs (agent-plugin wiring only) | (none) | RC-2026-09-18-010 | submitted
server/store.mjs (collab wiring only) | (none) | RC-2026-09-18-011 | submitted
server/web-fetch.mjs (new) | jill | RC-2026-09-23-102 | working
server/work-context.mjs | codex | RC-2026-09-26-1120 | working
server/work-discussion.mjs | codex | RC-2026-09-26-1120 | working
server/writer-fence.mjs | jill | RC-2026-09-23-102 | working
server/writer-fence.mjs | (none) | RC-2026-09-24-206 | submitted
server/writer-fence.mjs (collab tables only) | (none) | RC-2026-09-18-011 | submitted
side-effect-free helpers) | (none) | RC-2026-09-18-007 | submitted
skills/ProjectRoom/AUTO-INVOKE.md | jill | RC-2026-09-26-965 | working
skills/ProjectRoom/SKILL.md | jill | RC-2026-09-26-965 | working
skills/project-room-onboarding/SKILL.md | codex | RC-2026-09-26-1120 | working
skills/project-room-onboarding/SKILL.md | jill | RC-2026-09-26-965 | working
skills/project-room/SKILL.md | jill | RC-2026-09-26-965 | working
skills/project-room/references/deep-connection.md | jill | RC-2026-09-26-965 | working
skills/project-room/references/tools.md | jill | RC-2026-09-26-965 | working
src/account-deletion.mjs | quill | RC-2026-09-19-078 | submitted
src/agent-error.mjs | jill | RC-2026-09-26-965 | working
src/app.js | quill | RC-2026-09-19-068 | working
src/app.js | quill | RC-2026-09-19-072 | submitted
src/app.js | quill | RC-2026-09-19-080 | submitted
src/app.js | quill | RC-2026-09-19-083 | submitted
src/app.js | quill | RC-2026-09-19-085 | submitted
src/app.js | quill | RC-2026-09-19-088 | submitted
src/app.js | jill | RC-2026-09-26-965 | working
src/auth-signin-ui.js | quill | RC-2026-09-19-077 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-088 | submitted
src/auth-signin-ui.js | jill | RC-2026-09-26-965 | working
src/conversation.js | quill | RC-2026-09-19-068 | working
src/events.js | (none) | RC-2026-09-18-017 | submitted
src/events.js | jillian | RC-2026-09-25-943 | working
src/invite-context.js | quill | RC-2026-09-19-071 | submitted
src/invite-context.js (new | (none) | RC-2026-09-18-007 | submitted
src/reply-requests.js | quill | RC-2026-09-19-068 | working
src/room-deep-link.js | jill | RC-2026-09-26-965 | working
src/room-mcp-join.js | jill | RC-2026-09-26-965 | working
src/share-links.js | (none) | RC-2026-09-19-054 | submitted
src/styles.css | jill | RC-2026-09-26-965 | working
src/workflow.js | jill | RC-2026-09-26-965 | working
tests/access-request-cancel.test.js | jill | RC-2026-09-26-965 | working
tests/access-requests.test.js | (none) | RC-2026-09-18-022 | submitted
tests/account-management.test.js | quill | RC-2026-09-19-078 | submitted
tests/agent-autonomy-client.test.js | quill | RC-2026-09-18-033 | submitted
tests/agent-card-wellknown.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-connection.test.js | jill | RC-2026-09-26-965 | working
tests/agent-connections-atomic.test.js | (none) | RC-2026-09-24-201 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-24-010 | submitted
tests/agent-error-next.test.js | jill | RC-2026-09-26-965 | working
tests/agent-heartbeat-view.test.js | grokbot | RC-2026-09-25-910 | submitted
tests/agent-identities.test.js | (none) | RC-2026-09-18-018 | submitted
tests/agent-identities.test.js | quill | RC-2026-09-19-086 | submitted
tests/agent-invites.test.js | (none) | RC-2026-09-18-020 | submitted
tests/agent-plugin-api-keys.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-directory.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-http.test.js | (none) | RC-2026-09-18-010 | submitted
tests/agent-plugin-loop.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-019 | submitted
tests/agent-plugin-webhook-subs.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-rooms.test.js | (none) | RC-2026-09-18-021 | submitted
tests/agent-work-search.test.js | jill | RC-2026-09-26-965 | working
tests/autonomy-tiers.test.js | (none) | RC-2026-09-24-206 | submitted
tests/backlog.test.js | jill | RC-2026-09-26-1133 | submitted
tests/begin-scope-retry.test.js | jill | RC-2026-09-26-965 | working
tests/begin-work.test.js | jill | RC-2026-09-26-965 | working
tests/board-v2.test.js | jill | RC-2026-09-26-1114 | submitted
tests/bonds.test.js | (none) | RC-2026-09-24-927 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-17-026 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-18-003 | submitted
tests/capability-registry.test.js | (none) | RC-2026-09-24-110 | submitted
tests/channel-messenger-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/channel-sms-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/claim-validate.test.js | (none) | RC-2026-09-24-204 | submitted
tests/claims-state-machine.property.test.js | jill | RC-2026-09-26-1115 | working
tests/cli-invite.test.js | quill | RC-2026-09-19-082 | submitted
tests/cold-start-friction.test.js | jill | RC-2026-09-26-965 | working
tests/connector-briefs.test.js | quill | RC-2026-09-19-079 | submitted
tests/credit-question.test.js | quill | RC-2026-09-19-068 | working
tests/current-attention-integration.test.js | jill | RC-2026-09-26-965 | working
tests/directory-card-withdrawal.test.js | quill | RC-2026-09-19-084 | submitted
tests/discoverability.test.js | jill | RC-2026-09-26-965 | working
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-001 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-002 | submitted
tests/dm-privacy.test.js | quill | RC-2026-09-19-070 | submitted
tests/first-paint.test.js | quill | RC-2026-09-19-085 | submitted
tests/first-run-landing.test.js | quill | RC-2026-09-19-088 | submitted
tests/focused-orientation.test.js | jill | RC-2026-09-26-965 | working
tests/google-oauth-email.test.js | quill | RC-2026-09-19-075 | submitted
tests/guest-agent-links.test.js | jill | RC-2026-09-26-965 | working
tests/guest-join.test.js | jill | RC-2026-09-25-912 | submitted
tests/handoff-renderer.test.js | quill | RC-2026-09-19-072 | submitted
tests/help-discovery.test.js | jill | RC-2026-09-26-965 | working
tests/identity-display-name.test.js | (none) | RC-2026-09-25-938 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-011 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-023 | submitted
tests/job-heartbeat.test.js | jill | RC-2026-09-26-965 | working
tests/join-p2s.test.js | quill | RC-2026-09-19-071 | submitted
tests/magic-account-switch.test.js | quill | RC-2026-09-19-074 | submitted
tests/magic-invalidation.test.js | quill | RC-2026-09-19-073 | submitted
tests/mcp-integration.test.js | jill | RC-2026-09-26-965 | working
tests/mcp-stdio.test.js | jill | RC-2026-09-26-965 | working
tests/members-directory.test.js | (none) | RC-2026-09-24-202 | submitted
tests/mention-lifecycle.test.js | codex | RC-2026-09-26-1120 | working
tests/messenger-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/next-actions.test.js | jill | RC-2026-09-25-911 | submitted
tests/oauth-stateless.test.js | quill | RC-2026-09-19-076 | submitted
tests/open-join.test.js | (none) | RC-2026-09-18-017 | submitted
tests/ralph-loop.test.js | jill | RC-2026-09-26-1131 | submitted
tests/receipts-search.test.js | (none) | RC-2026-09-24-205 | submitted
tests/release-checkpoint.test.js | jill | RC-2026-09-26-965 | working
tests/reply-requests.test.js | codex | RC-2026-09-26-1120 | working
tests/room-creation.test.js | quill | RC-2026-09-19-080 | submitted
tests/room-deep-link.test.js | jill | RC-2026-09-26-965 | working
tests/room-prose-claims.test.js | quill-s2 | RC-2026-09-17-001 | submitted
tests/room-protocol-mutation.test.js | jill | RC-2026-09-26-1112 | working
tests/room-roster.test.js | jill | RC-2026-09-26-965 | working
tests/room-watch-enforcer.test.sh | jill | RC-2026-09-26-1130 | submitted
tests/route-docs-check.test.js | quill | RC-2026-09-19-081 | submitted
tests/route-docs-check.test.js | jill | RC-2026-09-26-965 | working
tests/runtime-package.test.js | (none) | RC-2026-09-18-017 | submitted
tests/runtime-package.test.js | grokbot | RC-2026-09-25-910 | submitted
tests/runtime-package.test.js | jill | RC-2026-09-26-965 | working
tests/runtime-package.test.js (count bump only) | (none) | RC-2026-09-18-011 | submitted
tests/session-fixation.test.js | quill | RC-2026-09-19-069 | submitted
tests/share-link-ui.test.js | (none) | RC-2026-09-19-054 | submitted
tests/signin-error-visibility.test.js | quill | RC-2026-09-19-077 | submitted
tests/sms-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/sms-messenger-outbound.test.js | quill | RC-2026-09-18-008 | submitted
tests/spend-allowance.test.js | jillian | RC-2026-09-25-943 | working
tests/ux-copy.test.js | quill | RC-2026-09-19-083 | submitted
tests/web-fetch.test.js (new) | jill | RC-2026-09-23-102 | working
tests/work-context.test.js | codex | RC-2026-09-26-1120 | working
tests/work-discussion.test.js | codex | RC-2026-09-26-1120 | working
tests/work-discussion.test.js | jill | RC-2026-09-26-965 | working
tests/work-preparation.test.js | jill | RC-2026-09-26-965 | working
tests/workflow.test.js | jill | RC-2026-09-26-965 | working
… +63 more

## signals
board_comments=2160 threshold=1500 rotation_due=yes watcher=active open_claims=78 prose_open=3 unfenced_prose=73 files_claimed=260 overlap_files=42 watermark=5850693692

