# ROOM-STATE — machine board
<!-- generated: 2026-09-26T15:59:20Z · board: Uuriko/project-room#266 · watermark: 5847470278 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=2b81bf378bf01009f157e09950bc1db940fd6b454668d747334275208820ce1d -->

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
… +46 more

## file-claims
file | lane | task-id | state
.github/workflows/test.yml | instinct | RC-2026-09-25-302 | working
NONE | instinct-comms | RC-2026-09-25-7401 | working
NONE | instinct-comms | RC-2026-09-25-7403 | submitted
NONE (external black-box monitor) | instinct | RC-2026-09-23-902 | working
ROOM-HEALTH.md | quill-s2 | RC-2026-09-16-005 | submitted
ROOM-STATE.md | quill-s2 | RC-2026-09-16-004 | submitted
client/agent-connection.mjs | quill | RC-2026-09-19-082 | submitted
client/room-agent.mjs | quill | RC-2026-09-18-033 | submitted
cloudflare/http.check.mjs | (none) | RC-2026-09-23-105 | submitted
cloudflare/wrangler.jsonc | (none) | RC-2026-09-23-105 | submitted
connectors/muse.md | quill | RC-2026-09-19-079 | submitted
dasha-lobby-worker.mjs | swarm-sync | RC-2026 | submitted
deploy/agent-card-key.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-card-signed.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-24-010 | submitted
docs/ADMIN-GUIDE.md | (none) | RC-2026-09-24-206 | submitted
docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only) | (none) | RC-2026-09-18-006 | submitted
docs/AGENT-CARD-CUSTODY.md | (none) | RC-2026-09-23-105 | submitted
docs/AGENT-QUICKSTART.md | quill | RC-2026-09-18-033 | submitted
docs/CAPABILITY-REGISTRY.md | (none) | RC-2026-09-24-110 | submitted
docs/HEARTBEAT.md | grokbot | RC-2026-09-25-910 | submitted
docs/INCIDENT-1101-RUNBOOK.md | instinct | RC-2026-09-25-301 | working
docs/README.md (Demigod / DIE matching table: one added row only) | (none) | RC-2026-09-18-005 | submitted
docs/ROOM-ACTION-POLICY.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROOM-PROTOCOL.md | quill-s2 | RC-2026-09-17-001 | submitted
docs/ROOM-PROTOCOL.md | (none) | RC-2026-09-18-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/SWARM-PLUG-IN.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/examples/heartbeat.example.json | grokbot | RC-2026-09-25-910 | submitted
docs/examples/next-actions.example.json | jill | RC-2026-09-25-911 | submitted
docs/openapi.yaml | (none) | RC-2026-09-18-017 | submitted
docs/openapi.yaml | quill | RC-2026-09-19-068 | working
docs/openapi.yaml | jill | RC-2026-09-23-102 | working
docs/openapi.yaml | (none) | RC-2026-09-24-110 | submitted
docs/openapi.yaml | (none) | RC-2026-09-24-206 | submitted
docs/openapi.yaml (collab route docs only) | (none) | RC-2026-09-18-011 | submitted
docs/self-serve-join.md | jill | RC-2026-09-25-912 | submitted
docs/verified-state-transition-ledger.md | Instinct | RC-2026-09-17-011 | submitted
index.html | (none) | RC-2026-09-19-054 | submitted
index.html | quill | RC-2026-09-19-068 | working
index.html | quill | RC-2026-09-19-088 | submitted
scripts/browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/calm-return-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/candidate-runtime-fixture.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/candidate-runtime-fixture.mjs (collab paths only) | (none) | RC-2026-09-18-011 | submitted
scripts/credit-question-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/notification-feed-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/pinned-messages-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/probe-prod-lib.mjs | instinct | RC-2026-09-25-301 | working
scripts/probe-prod.mjs | instinct | RC-2026-09-25-301 | working
scripts/room | quill-s2 | RC-2026-09-16-004 | submitted
scripts/room | quill-s2 | RC-2026-09-17-001 | submitted
scripts/room | quill | RC-2026-09-17-006 | submitted
scripts/room-chrome.mjs | quill | RC-2026-09-19-068 | working
scripts/room-digest | quill-s2 | RC-2026-09-16-005 | submitted
scripts/route-docs-check.mjs | quill | RC-2026-09-19-081 | submitted
scripts/runtime-package.mjs | (none) | RC-2026-09-18-017 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-23-102 | working
scripts/runtime-package.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/runtime-package.mjs | (none) | RC-2026-09-24-110 | submitted
scripts/runtime-package.mjs | grokbot | RC-2026-09-25-910 | submitted
scripts/sign-agent-card.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/untested-modules-lint.mjs | instinct | RC-2026-09-25-302 | working
scripts/watch-deploy-drift.mjs | instinct | RC-2026-09-25-304 | working
server/access-requests.mjs | (none) | RC-2026-09-18-022 | submitted
server/access-requests.mjs | quill | RC-2026-09-19-071 | submitted
server/account-login-methods.mjs | quill | RC-2026-09-19-073 | submitted
server/agent-api-keys.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-connections.mjs | (none) | RC-2026-09-24-201 | submitted
server/agent-directory.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-heartbeat-routes.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-heartbeat-view.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-18-018 | submitted
server/agent-identities.mjs | quill | RC-2026-09-19-086 | submitted
server/agent-identities.mjs | jillian | RC-2026-09-25-938 | working
server/agent-invites.mjs | (none) | RC-2026-09-18-020 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-019 | submitted
server/agent-plugin-routes.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-plugin-store.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-rooms.mjs | (none) | RC-2026-09-18-021 | submitted
server/agent-webhook-subscriptions.mjs | (none) | RC-2026-09-18-009 | submitted
server/attention.mjs | jill | RC-2026-09-21-001 | submitted
server/autonomy-tiers.mjs | (none) | RC-2026-09-24-206 | submitted
server/bonds.mjs | (none) | RC-2026-09-24-927 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-17-026 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-18-003 | submitted
server/capability-registry.mjs | (none) | RC-2026-09-24-110 | submitted
server/channel-adapters/index.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/messenger.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/sms.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-connection.mjs | quill | RC-2026-09-18-008 | submitted
server/claim-validate.mjs | (none) | RC-2026-09-24-204 | submitted
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
server/http.mjs (agent-plugin routes only) | (none) | RC-2026-09-18-010 | submitted
server/http.mjs (collab routes only) | (none) | RC-2026-09-18-011 | submitted
server/identity-display-name.mjs | jillian | RC-2026-09-25-938 | working
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-023 | submitted
server/inbox-collab-store.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-handoff.mjs | (none) | RC-2026-09-18-011 | submitted
server/members-directory.mjs | (none) | RC-2026-09-24-202 | submitted
server/messenger-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/messenger-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/next-actions-routes.mjs | jill | RC-2026-09-25-911 | submitted
server/next-actions.mjs | jill | RC-2026-09-25-911 | submitted
server/open-join.mjs | (none) | RC-2026-09-18-017 | submitted
server/outbound-webhooks.mjs | quill | RC-2026-09-19-087 | submitted
server/owner-attention.mjs | jill | RC-2026-09-21-001 | submitted
server/receipts-search.mjs | (none) | RC-2026-09-24-205 | submitted
server/room-lifecycle.mjs | quill | RC-2026-09-19-080 | submitted
server/room-lifecycle.mjs | quill | RC-2026-09-19-088 | submitted
server/sms-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/sms-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/spend-allowance.mjs | jillian | RC-2026-09-25-943 | working
server/store.mjs | (none) | RC-2026-09-18-017 | submitted
server/store.mjs | quill | RC-2026-09-19-068 | working
server/store.mjs | jill | RC-2026-09-23-102 | working
server/store.mjs | (none) | RC-2026-09-24-206 | submitted
server/store.mjs (agent-plugin wiring only) | (none) | RC-2026-09-18-010 | submitted
server/store.mjs (collab wiring only) | (none) | RC-2026-09-18-011 | submitted
server/web-fetch.mjs (new) | jill | RC-2026-09-23-102 | working
server/writer-fence.mjs | jill | RC-2026-09-23-102 | working
server/writer-fence.mjs | (none) | RC-2026-09-24-206 | submitted
server/writer-fence.mjs (collab tables only) | (none) | RC-2026-09-18-011 | submitted
side-effect-free helpers) | (none) | RC-2026-09-18-007 | submitted
src/account-deletion.mjs | quill | RC-2026-09-19-078 | submitted
src/app.js | quill | RC-2026-09-19-068 | working
src/app.js | quill | RC-2026-09-19-072 | submitted
src/app.js | quill | RC-2026-09-19-080 | submitted
src/app.js | quill | RC-2026-09-19-083 | submitted
src/app.js | quill | RC-2026-09-19-085 | submitted
src/app.js | quill | RC-2026-09-19-088 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-077 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-088 | submitted
src/conversation.js | quill | RC-2026-09-19-068 | working
src/events.js | (none) | RC-2026-09-18-017 | submitted
src/events.js | jillian | RC-2026-09-25-943 | working
src/invite-context.js | quill | RC-2026-09-19-071 | submitted
src/invite-context.js (new | (none) | RC-2026-09-18-007 | submitted
src/reply-requests.js | quill | RC-2026-09-19-068 | working
src/share-links.js | (none) | RC-2026-09-19-054 | submitted
tests/access-requests.test.js | (none) | RC-2026-09-18-022 | submitted
tests/account-management.test.js | quill | RC-2026-09-19-078 | submitted
tests/agent-autonomy-client.test.js | quill | RC-2026-09-18-033 | submitted
tests/agent-card-wellknown.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-connections-atomic.test.js | (none) | RC-2026-09-24-201 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-24-010 | submitted
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
tests/autonomy-tiers.test.js | (none) | RC-2026-09-24-206 | submitted
tests/bonds.test.js | (none) | RC-2026-09-24-927 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-17-026 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-18-003 | submitted
tests/capability-registry.test.js | (none) | RC-2026-09-24-110 | submitted
tests/channel-messenger-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/channel-sms-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/claim-validate.test.js | (none) | RC-2026-09-24-204 | submitted
tests/cli-invite.test.js | quill | RC-2026-09-19-082 | submitted
tests/connector-briefs.test.js | quill | RC-2026-09-19-079 | submitted
tests/credit-question.test.js | quill | RC-2026-09-19-068 | working
tests/directory-card-withdrawal.test.js | quill | RC-2026-09-19-084 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-001 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-002 | submitted
tests/dm-privacy.test.js | quill | RC-2026-09-19-070 | submitted
tests/first-paint.test.js | quill | RC-2026-09-19-085 | submitted
tests/first-run-landing.test.js | quill | RC-2026-09-19-088 | submitted
tests/google-oauth-email.test.js | quill | RC-2026-09-19-075 | submitted
tests/guest-join.test.js | jill | RC-2026-09-25-912 | submitted
tests/handoff-renderer.test.js | quill | RC-2026-09-19-072 | submitted
tests/identity-display-name.test.js | jillian | RC-2026-09-25-938 | working
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-011 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-023 | submitted
tests/join-p2s.test.js | quill | RC-2026-09-19-071 | submitted
tests/magic-account-switch.test.js | quill | RC-2026-09-19-074 | submitted
tests/magic-invalidation.test.js | quill | RC-2026-09-19-073 | submitted
tests/members-directory.test.js | (none) | RC-2026-09-24-202 | submitted
tests/messenger-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/next-actions.test.js | jill | RC-2026-09-25-911 | submitted
tests/oauth-stateless.test.js | quill | RC-2026-09-19-076 | submitted
tests/open-join.test.js | (none) | RC-2026-09-18-017 | submitted
tests/receipts-search.test.js | (none) | RC-2026-09-24-205 | submitted
tests/room-creation.test.js | quill | RC-2026-09-19-080 | submitted
tests/room-flood-guard.test.js | instinct | RC-2026-09-25-302 | working
tests/room-prose-claims.test.js | quill-s2 | RC-2026-09-17-001 | submitted
tests/route-docs-check.test.js | quill | RC-2026-09-19-081 | submitted
tests/runtime-package.test.js | (none) | RC-2026-09-18-017 | submitted
tests/runtime-package.test.js | grokbot | RC-2026-09-25-910 | submitted
tests/runtime-package.test.js (count bump only) | (none) | RC-2026-09-18-011 | submitted
tests/self-serve-join-contract.test.js | instinct | RC-2026-09-25-303 | working
tests/session-fixation.test.js | quill | RC-2026-09-19-069 | submitted
tests/share-link-ui.test.js | (none) | RC-2026-09-19-054 | submitted
tests/signin-error-visibility.test.js | quill | RC-2026-09-19-077 | submitted
tests/sms-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/sms-messenger-outbound.test.js | quill | RC-2026-09-18-008 | submitted
tests/spend-allowance.test.js | jillian | RC-2026-09-25-943 | working
tests/ux-copy.test.js | quill | RC-2026-09-19-083 | submitted
tests/web-fetch.test.js (new) | jill | RC-2026-09-23-102 | working

## overlap-warnings
file | lanes | task-ids
NONE | instinct-comms | RC-2026-09-25-7401, RC-2026-09-25-7403
deploy/agent-discovery.mjs |  | RC-2026-09-23-105, RC-2026-09-24-010
docs/ROOM-PROTOCOL.md | , quill-s2 | RC-2026-09-17-001, RC-2026-09-18-004
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004, RC-2026-09-16-005
docs/openapi.yaml | , jill, quill | RC-2026-09-18-017, RC-2026-09-19-068, RC-2026-09-23-102, RC-2026-09-24-110, RC-2026-09-24-206
index.html | , quill | RC-2026-09-19-054, RC-2026-09-19-068, RC-2026-09-19-088
scripts/room | quill, quill-s2 | RC-2026-09-16-004, RC-2026-09-17-001, RC-2026-09-17-006
scripts/runtime-package.mjs | , grokbot, jill | RC-2026-09-18-017, RC-2026-09-23-102, RC-2026-09-23-105, RC-2026-09-24-110, RC-2026-09-25-910
server/access-requests.mjs | , quill | RC-2026-09-18-022, RC-2026-09-19-071
server/agent-identities.mjs | , jillian, quill | RC-2026-09-18-018, RC-2026-09-19-086, RC-2026-09-25-938
server/agent-plugin-manifest.mjs |  | RC-2026-09-18-009, RC-2026-09-18-019
server/bounty-disputes.mjs |  | RC-2026-09-17-026, RC-2026-09-18-003
server/dispute-arbiters.mjs |  | RC-2026-09-18-001, RC-2026-09-18-002
server/google-oauth.mjs | quill | RC-2026-09-19-075, RC-2026-09-19-076
server/http.mjs | , Instinct, jill, quill | RC-2026-09-17-011, RC-2026-09-18-017, RC-2026-09-19-069, RC-2026-09-19-070, RC-2026-09-19-074, RC-2026-09-19-078, RC-2026-09-19-084, RC-2026-09-19-088, RC-2026-09-23-102, RC-2026-09-24-206
server/inbox-collab-routes.mjs |  | RC-2026-09-18-011, RC-2026-09-18-023
server/room-lifecycle.mjs | quill | RC-2026-09-19-080, RC-2026-09-19-088
server/store.mjs | , jill, quill | RC-2026-09-18-017, RC-2026-09-19-068, RC-2026-09-23-102, RC-2026-09-24-206
server/writer-fence.mjs | , jill | RC-2026-09-23-102, RC-2026-09-24-206
src/app.js | quill | RC-2026-09-19-068, RC-2026-09-19-072, RC-2026-09-19-080, RC-2026-09-19-083, RC-2026-09-19-085, RC-2026-09-19-088
src/auth-signin-ui.js | quill | RC-2026-09-19-077, RC-2026-09-19-088
src/events.js | , jillian | RC-2026-09-18-017, RC-2026-09-25-943
tests/agent-discovery.test.js |  | RC-2026-09-23-105, RC-2026-09-24-010
tests/agent-identities.test.js | , quill | RC-2026-09-18-018, RC-2026-09-19-086
tests/agent-plugin-manifest.test.js |  | RC-2026-09-18-009, RC-2026-09-18-019
tests/bounty-disputes.test.js |  | RC-2026-09-17-026, RC-2026-09-18-003
tests/dispute-arbiters.test.js |  | RC-2026-09-18-001, RC-2026-09-18-002
tests/inbox-collab-http.test.js |  | RC-2026-09-18-011, RC-2026-09-18-023
tests/runtime-package.test.js | , grokbot | RC-2026-09-18-017, RC-2026-09-25-910

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
RC-2026-09-25-943 | jillian | working | 2026-09-26T17:40:09Z | src/events.js, server/spend-allowance.mjs, tests/spend-allowance.test.js

## unclaimed-lanes
lane | focus | trust
codex | design | standard
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
unknown | none | 5847470278
unknown | none | 5845328845
RC-304 | none | 5845201515
RC-303 | none | 5845061979
RC-302 | none | 5845060175
RC-301 | none | 5845058743
unknown | none | 5845057115
unknown | none | 5844875804
unknown | none | 5844865136
unknown | none | 5844796382

## prose-claims-needing-fence
comment-id | lane | task | at
.github/workflows/test.yml | instinct | RC-2026-09-25-302 | working
NONE | instinct-comms | RC-2026-09-25-7401 | working
NONE | instinct-comms | RC-2026-09-25-7403 | submitted
NONE (external black-box monitor) | instinct | RC-2026-09-23-902 | working
ROOM-HEALTH.md | quill-s2 | RC-2026-09-16-005 | submitted
ROOM-STATE.md | quill-s2 | RC-2026-09-16-004 | submitted
client/agent-connection.mjs | quill | RC-2026-09-19-082 | submitted
client/room-agent.mjs | quill | RC-2026-09-18-033 | submitted
cloudflare/http.check.mjs | (none) | RC-2026-09-23-105 | submitted
cloudflare/wrangler.jsonc | (none) | RC-2026-09-23-105 | submitted
connectors/muse.md | quill | RC-2026-09-19-079 | submitted
dasha-lobby-worker.mjs | swarm-sync | RC-2026 | submitted
deploy/agent-card-key.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-card-signed.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-23-105 | submitted
deploy/agent-discovery.mjs | (none) | RC-2026-09-24-010 | submitted
docs/ADMIN-GUIDE.md | (none) | RC-2026-09-24-206 | submitted
docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only) | (none) | RC-2026-09-18-006 | submitted
docs/AGENT-CARD-CUSTODY.md | (none) | RC-2026-09-23-105 | submitted
docs/AGENT-QUICKSTART.md | quill | RC-2026-09-18-033 | submitted
docs/CAPABILITY-REGISTRY.md | (none) | RC-2026-09-24-110 | submitted
docs/HEARTBEAT.md | grokbot | RC-2026-09-25-910 | submitted
docs/INCIDENT-1101-RUNBOOK.md | instinct | RC-2026-09-25-301 | working
docs/README.md (Demigod / DIE matching table: one added row only) | (none) | RC-2026-09-18-005 | submitted
docs/ROOM-ACTION-POLICY.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROOM-PROTOCOL.md | quill-s2 | RC-2026-09-17-001 | submitted
docs/ROOM-PROTOCOL.md | (none) | RC-2026-09-18-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/SWARM-PLUG-IN.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/examples/heartbeat.example.json | grokbot | RC-2026-09-25-910 | submitted
docs/examples/next-actions.example.json | jill | RC-2026-09-25-911 | submitted
docs/openapi.yaml | (none) | RC-2026-09-18-017 | submitted
docs/openapi.yaml | quill | RC-2026-09-19-068 | working
docs/openapi.yaml | jill | RC-2026-09-23-102 | working
docs/openapi.yaml | (none) | RC-2026-09-24-110 | submitted
docs/openapi.yaml | (none) | RC-2026-09-24-206 | submitted
docs/openapi.yaml (collab route docs only) | (none) | RC-2026-09-18-011 | submitted
docs/self-serve-join.md | jill | RC-2026-09-25-912 | submitted
docs/verified-state-transition-ledger.md | Instinct | RC-2026-09-17-011 | submitted
index.html | (none) | RC-2026-09-19-054 | submitted
index.html | quill | RC-2026-09-19-068 | working
index.html | quill | RC-2026-09-19-088 | submitted
scripts/browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/calm-return-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/candidate-runtime-fixture.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/candidate-runtime-fixture.mjs (collab paths only) | (none) | RC-2026-09-18-011 | submitted
scripts/credit-question-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/notification-feed-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/pinned-messages-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/probe-prod-lib.mjs | instinct | RC-2026-09-25-301 | working
scripts/probe-prod.mjs | instinct | RC-2026-09-25-301 | working
scripts/room | quill-s2 | RC-2026-09-16-004 | submitted
scripts/room | quill-s2 | RC-2026-09-17-001 | submitted
scripts/room | quill | RC-2026-09-17-006 | submitted
scripts/room-chrome.mjs | quill | RC-2026-09-19-068 | working
scripts/room-digest | quill-s2 | RC-2026-09-16-005 | submitted
scripts/route-docs-check.mjs | quill | RC-2026-09-19-081 | submitted
scripts/runtime-package.mjs | (none) | RC-2026-09-18-017 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-23-102 | working
scripts/runtime-package.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/runtime-package.mjs | (none) | RC-2026-09-24-110 | submitted
scripts/runtime-package.mjs | grokbot | RC-2026-09-25-910 | submitted
scripts/sign-agent-card.mjs | (none) | RC-2026-09-23-105 | submitted
scripts/untested-modules-lint.mjs | instinct | RC-2026-09-25-302 | working
scripts/watch-deploy-drift.mjs | instinct | RC-2026-09-25-304 | working
server/access-requests.mjs | (none) | RC-2026-09-18-022 | submitted
server/access-requests.mjs | quill | RC-2026-09-19-071 | submitted
server/account-login-methods.mjs | quill | RC-2026-09-19-073 | submitted
server/agent-api-keys.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-connections.mjs | (none) | RC-2026-09-24-201 | submitted
server/agent-directory.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-heartbeat-routes.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-heartbeat-view.mjs | grokbot | RC-2026-09-25-910 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-18-018 | submitted
server/agent-identities.mjs | quill | RC-2026-09-19-086 | submitted
server/agent-identities.mjs | jillian | RC-2026-09-25-938 | working
server/agent-invites.mjs | (none) | RC-2026-09-18-020 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-019 | submitted
server/agent-plugin-routes.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-plugin-store.mjs | (none) | RC-2026-09-18-010 | submitted
server/agent-rooms.mjs | (none) | RC-2026-09-18-021 | submitted
server/agent-webhook-subscriptions.mjs | (none) | RC-2026-09-18-009 | submitted
server/attention.mjs | jill | RC-2026-09-21-001 | submitted
server/autonomy-tiers.mjs | (none) | RC-2026-09-24-206 | submitted
server/bonds.mjs | (none) | RC-2026-09-24-927 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-17-026 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-18-003 | submitted
server/capability-registry.mjs | (none) | RC-2026-09-24-110 | submitted
server/channel-adapters/index.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/messenger.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-adapters/sms.mjs | quill | RC-2026-09-18-008 | submitted
server/channel-connection.mjs | quill | RC-2026-09-18-008 | submitted
server/claim-validate.mjs | (none) | RC-2026-09-24-204 | submitted
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
server/http.mjs (agent-plugin routes only) | (none) | RC-2026-09-18-010 | submitted
server/http.mjs (collab routes only) | (none) | RC-2026-09-18-011 | submitted
server/identity-display-name.mjs | jillian | RC-2026-09-25-938 | working
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-023 | submitted
server/inbox-collab-store.mjs | (none) | RC-2026-09-18-011 | submitted
server/inbox-handoff.mjs | (none) | RC-2026-09-18-011 | submitted
server/members-directory.mjs | (none) | RC-2026-09-24-202 | submitted
server/messenger-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/messenger-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/next-actions-routes.mjs | jill | RC-2026-09-25-911 | submitted
server/next-actions.mjs | jill | RC-2026-09-25-911 | submitted
server/open-join.mjs | (none) | RC-2026-09-18-017 | submitted
server/outbound-webhooks.mjs | quill | RC-2026-09-19-087 | submitted
server/owner-attention.mjs | jill | RC-2026-09-21-001 | submitted
server/receipts-search.mjs | (none) | RC-2026-09-24-205 | submitted
server/room-lifecycle.mjs | quill | RC-2026-09-19-080 | submitted
server/room-lifecycle.mjs | quill | RC-2026-09-19-088 | submitted
server/sms-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/sms-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/spend-allowance.mjs | jillian | RC-2026-09-25-943 | working
server/store.mjs | (none) | RC-2026-09-18-017 | submitted
server/store.mjs | quill | RC-2026-09-19-068 | working
server/store.mjs | jill | RC-2026-09-23-102 | working
server/store.mjs | (none) | RC-2026-09-24-206 | submitted
server/store.mjs (agent-plugin wiring only) | (none) | RC-2026-09-18-010 | submitted
server/store.mjs (collab wiring only) | (none) | RC-2026-09-18-011 | submitted
server/web-fetch.mjs (new) | jill | RC-2026-09-23-102 | working
server/writer-fence.mjs | jill | RC-2026-09-23-102 | working
server/writer-fence.mjs | (none) | RC-2026-09-24-206 | submitted
server/writer-fence.mjs (collab tables only) | (none) | RC-2026-09-18-011 | submitted
side-effect-free helpers) | (none) | RC-2026-09-18-007 | submitted
src/account-deletion.mjs | quill | RC-2026-09-19-078 | submitted
src/app.js | quill | RC-2026-09-19-068 | working
src/app.js | quill | RC-2026-09-19-072 | submitted
src/app.js | quill | RC-2026-09-19-080 | submitted
src/app.js | quill | RC-2026-09-19-083 | submitted
src/app.js | quill | RC-2026-09-19-085 | submitted
src/app.js | quill | RC-2026-09-19-088 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-077 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-088 | submitted
src/conversation.js | quill | RC-2026-09-19-068 | working
src/events.js | (none) | RC-2026-09-18-017 | submitted
src/events.js | jillian | RC-2026-09-25-943 | working
src/invite-context.js | quill | RC-2026-09-19-071 | submitted
src/invite-context.js (new | (none) | RC-2026-09-18-007 | submitted
src/reply-requests.js | quill | RC-2026-09-19-068 | working
src/share-links.js | (none) | RC-2026-09-19-054 | submitted
tests/access-requests.test.js | (none) | RC-2026-09-18-022 | submitted
tests/account-management.test.js | quill | RC-2026-09-19-078 | submitted
tests/agent-autonomy-client.test.js | quill | RC-2026-09-18-033 | submitted
tests/agent-card-wellknown.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-connections-atomic.test.js | (none) | RC-2026-09-24-201 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-23-105 | submitted
tests/agent-discovery.test.js | (none) | RC-2026-09-24-010 | submitted
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
tests/autonomy-tiers.test.js | (none) | RC-2026-09-24-206 | submitted
tests/bonds.test.js | (none) | RC-2026-09-24-927 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-17-026 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-18-003 | submitted
tests/capability-registry.test.js | (none) | RC-2026-09-24-110 | submitted
tests/channel-messenger-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/channel-sms-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/claim-validate.test.js | (none) | RC-2026-09-24-204 | submitted
tests/cli-invite.test.js | quill | RC-2026-09-19-082 | submitted
tests/connector-briefs.test.js | quill | RC-2026-09-19-079 | submitted
tests/credit-question.test.js | quill | RC-2026-09-19-068 | working
tests/directory-card-withdrawal.test.js | quill | RC-2026-09-19-084 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-001 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-002 | submitted
tests/dm-privacy.test.js | quill | RC-2026-09-19-070 | submitted
tests/first-paint.test.js | quill | RC-2026-09-19-085 | submitted
tests/first-run-landing.test.js | quill | RC-2026-09-19-088 | submitted
tests/google-oauth-email.test.js | quill | RC-2026-09-19-075 | submitted
tests/guest-join.test.js | jill | RC-2026-09-25-912 | submitted
tests/handoff-renderer.test.js | quill | RC-2026-09-19-072 | submitted
tests/identity-display-name.test.js | jillian | RC-2026-09-25-938 | working
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-011 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-023 | submitted
tests/join-p2s.test.js | quill | RC-2026-09-19-071 | submitted
tests/magic-account-switch.test.js | quill | RC-2026-09-19-074 | submitted
tests/magic-invalidation.test.js | quill | RC-2026-09-19-073 | submitted
tests/members-directory.test.js | (none) | RC-2026-09-24-202 | submitted
tests/messenger-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/next-actions.test.js | jill | RC-2026-09-25-911 | submitted
tests/oauth-stateless.test.js | quill | RC-2026-09-19-076 | submitted
tests/open-join.test.js | (none) | RC-2026-09-18-017 | submitted
tests/receipts-search.test.js | (none) | RC-2026-09-24-205 | submitted
tests/room-creation.test.js | quill | RC-2026-09-19-080 | submitted
tests/room-flood-guard.test.js | instinct | RC-2026-09-25-302 | working
tests/room-prose-claims.test.js | quill-s2 | RC-2026-09-17-001 | submitted
tests/route-docs-check.test.js | quill | RC-2026-09-19-081 | submitted
tests/runtime-package.test.js | (none) | RC-2026-09-18-017 | submitted
tests/runtime-package.test.js | grokbot | RC-2026-09-25-910 | submitted
tests/runtime-package.test.js (count bump only) | (none) | RC-2026-09-18-011 | submitted
tests/self-serve-join-contract.test.js | instinct | RC-2026-09-25-303 | working
tests/session-fixation.test.js | quill | RC-2026-09-19-069 | submitted
tests/share-link-ui.test.js | (none) | RC-2026-09-19-054 | submitted
tests/signin-error-visibility.test.js | quill | RC-2026-09-19-077 | submitted
tests/sms-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/sms-messenger-outbound.test.js | quill | RC-2026-09-18-008 | submitted
tests/spend-allowance.test.js | jillian | RC-2026-09-25-943 | working
tests/ux-copy.test.js | quill | RC-2026-09-19-083 | submitted
tests/web-fetch.test.js (new) | jill | RC-2026-09-23-102 | working
… +63 more

## signals
board_comments=2019 threshold=1500 rotation_due=yes watcher=active open_claims=71 prose_open=3 unfenced_prose=73 files_claimed=175 overlap_files=29 watermark=5847470278

