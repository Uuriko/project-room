# ROOM-STATE — machine board
<!-- generated: 2026-09-27T19:58:51Z · board: Uuriko/project-room#266 · watermark: 5859322518 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=27fed73633e4a6c84ff0bb485e09ed4ecaf690fa764812345d38d297fba2cf44 -->

## open
task-id | lane | state | lease-expires-utc | files
RC-2026-09-17-001 | quill-s2 | submitted | 2026-09-17T12:52:20Z | scripts/room, tests/room-prose-claims.test.js, docs/ROOM-PROTOCOL.md
RC-2026-09-16-004 | quill-s2 | submitted | 2026-09-17T18:17:54Z | ROOM-STATE.md, scripts/room, docs/ROOM-WATCH.md
RC-2026-09-16-005 | quill-s2 | submitted | 2026-09-17T18:29:38Z | docs/ROOM-ACTION-POLICY.md, scripts/room-digest, ROOM-HEALTH.md, docs/SWARM-PLUG-IN.md, docs/ROOM-WATCH.md
RC-2026-09-17-026 | (none) | submitted | 2026-09-18T07:09:35Z | server/bounty-disputes.mjs, tests/bounty-disputes.test.js
RC-2026-09-18-001 | (none) | submitted | 2026-09-18T07:36:18Z | server/dispute-arbiters.mjs, tests/dispute-arbiters.test.js
RC-2026-09-18-002 | (none) | submitted | 2026-09-18T07:49:58Z | server/dispute-arbiters.mjs, tests/dispute-arbiters.test.js
RC-2026-09-18-003 | (none) | submitted | 2026-09-18T08:06:37Z | server/bounty-disputes.mjs, tests/bounty-disputes.test.js
RC-2026-09-18-005 | (none) | submitted | 2026-09-18T10:45:10Z | docs/README.md (Demigod / DIE matching table: one added row only)
RC-2026-09-18-006 | (none) | submitted | 2026-09-18T10:49:58Z | docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only)
RC-2026-09-18-007 | (none) | submitted | 2026-09-18T11:10:03Z | src/invite-context.js (new, side-effect-free helpers)
RC-2026-09-17-011 | Instinct (prose) | submitted | 2026-09-18T11:56:16Z | docs/verified-state-transition-ledger.md, server/http.mjs
RC-2026-09-18-008 | quill | submitted | 2026-09-18T20:02:36Z | server/channel-adapters/sms.mjs, server/channel-adapters/messenger.mjs, server/sms-ingest.mjs, server/messenger-ingest.mjs, server/sms-outbound.mjs, server/messenger-outbound.mjs, server/channel-connection.mjs, server/channel-adapters/index.mjs, tests/channel-sms-adapter.test.js, tests/channel-messenger-adapter.test.js, tests/sms-ingest.test.js, tests/messenger-ingest.test.js, tests/sms-messenger-outbound.test.js
RC-2026-09-18-009 | (none) | submitted | 2026-09-18T20:03:13Z | server/agent-api-keys.mjs, server/agent-directory.mjs, server/agent-plugin-manifest.mjs, server/agent-webhook-subscriptions.mjs, tests/agent-plugin-api-keys.test.js, tests/agent-plugin-directory.test.js, tests/agent-plugin-manifest.test.js, tests/agent-plugin-webhook-subs.test.js, tests/agent-plugin-loop.test.js
RC-2026-09-18-018 | (none) | submitted | 2026-09-19T02:10:08Z | server/agent-identities.mjs, tests/agent-identities.test.js
RC-2026-09-18-019 | (none) | submitted | 2026-09-19T02:10:49Z | server/agent-plugin-manifest.mjs, tests/agent-plugin-manifest.test.js
RC-2026-09-18-020 | (none) | submitted | 2026-09-19T02:13:56Z | server/agent-invites.mjs, tests/agent-invites.test.js
RC-2026-09-18-021 | (none) | submitted | 2026-09-19T02:14:48Z | server/agent-rooms.mjs, tests/agent-rooms.test.js
RC-2026-09-18-022 | (none) | submitted | 2026-09-19T02:15:31Z | server/access-requests.mjs, tests/access-requests.test.js
RC-2026-09-18-023 | (none) | submitted | 2026-09-19T02:16:06Z | server/inbox-collab-routes.mjs, tests/inbox-collab-http.test.js
RC-2026-09-18-033 | quill | submitted | 2026-09-19T04:00:11Z | client/room-agent.mjs, tests/agent-autonomy-client.test.js, docs/AGENT-QUICKSTART.md
RC-2026-09-19-054 | (none) | submitted | 2026-09-19T14:09:41Z | src/share-links.js, tests/share-link-ui.test.js, index.html
RC-2026-09-19-071 | quill | submitted | 2026-09-20T03:07:10Z | src/invite-context.js, server/access-requests.mjs, tests/join-p2s.test.js
RC-2026-09-19-072 | quill | submitted | 2026-09-20T03:07:21Z | src/app.js, tests/handoff-renderer.test.js
RC-2026-09-19-073 | quill | submitted | 2026-09-20T03:18:56Z | server/account-login-methods.mjs, tests/magic-invalidation.test.js
RC-2026-09-19-075 | quill | submitted | 2026-09-20T03:19:19Z | server/google-oauth.mjs, tests/google-oauth-email.test.js
… +33 more

## file-claims
file | lane | task-id | state
NONE (external black-box monitor) | instinct | RC-2026-09-23-902 | working
ROOM-HEALTH.md | quill-s2 | RC-2026-09-16-005 | submitted
ROOM-STATE.md | quill-s2 | RC-2026-09-16-004 | submitted
client/agent-connection.mjs | quill | RC-2026-09-19-082 | submitted
client/room-agent.mjs | quill | RC-2026-09-18-033 | submitted
cloudflare/http.check.mjs | jill | RC-2026-09-23-105 | working
cloudflare/wrangler.jsonc | jill | RC-2026-09-23-105 | working
connectors/muse.md | quill | RC-2026-09-19-079 | submitted
dasha-lobby-worker.mjs | swarm-sync | RC-2026 | submitted
deploy/agent-card-key.mjs | jill | RC-2026-09-23-105 | working
deploy/agent-card-key.mjs | jill | RC-2026-09-27-2715 | submitted
deploy/agent-card-signed.mjs | jill | RC-2026-09-23-105 | working
deploy/agent-card-signed.mjs | jill | RC-2026-09-27-2715 | submitted
deploy/agent-discovery.mjs | jill | RC-2026-09-23-105 | working
deploy/agent-discovery.mjs | jill | RC-2026-09-27-2715 | submitted
docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only) | (none) | RC-2026-09-18-006 | submitted
docs/AGENT-CARD-CUSTODY.md | jill | RC-2026-09-23-105 | working
docs/AGENT-QUICKSTART.md | quill | RC-2026-09-18-033 | submitted
docs/BOARD-ROTATION-READINESS.md | jill | RC-2026-09-26-1113 | submitted
docs/BOARD-V2-DESIGN.md | jill | RC-2026-09-26-1114 | submitted
docs/README.md (Demigod / DIE matching table: one added row only) | (none) | RC-2026-09-18-005 | submitted
docs/ROOM-ACTION-POLICY.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-1132 | submitted
docs/ROOM-PROTOCOL.md | quill-s2 | RC-2026-09-17-001 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/SWARM-PLUG-IN.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/examples/next-actions.example.json | jill | RC-2026-09-25-911 | submitted
docs/openapi.yaml | quill | RC-2026-09-19-068 | working
docs/room-health.html | jill | RC-2026-09-26-1116 | submitted
docs/self-serve-join.md | jill | RC-2026-09-25-912 | submitted
docs/verified-state-transition-ledger.md | Instinct | RC-2026-09-17-011 | submitted
index.html | (none) | RC-2026-09-19-054 | submitted
index.html | quill | RC-2026-09-19-068 | working
scripts/browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/calm-return-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/candidate-runtime-fixture.mjs | jill | RC-2026-09-23-105 | working
scripts/credit-question-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/deploy-live.py | jill | RC-2026-09-26-1132 | submitted
scripts/notification-feed-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/pinned-messages-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/ralph-loop.mjs | jill | RC-2026-09-26-1131 | submitted
scripts/ralph-loop.mjs | jill | RC-2026-09-27-1153 | submitted
scripts/room | quill-s2 | RC-2026-09-16-004 | submitted
scripts/room | quill-s2 | RC-2026-09-17-001 | submitted
scripts/room-chrome.mjs | quill | RC-2026-09-19-068 | working
scripts/room-digest | quill-s2 | RC-2026-09-16-005 | submitted
scripts/room-health.mjs | jill | RC-2026-09-26-1116 | submitted
scripts/rotation-cutover.sh | jill | RC-2026-09-26-1113 | submitted
scripts/rotation-rehearse.sh | jill | RC-2026-09-26-1113 | submitted
scripts/route-docs-check.mjs | quill | RC-2026-09-19-081 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-23-105 | working
scripts/sign-agent-card.mjs | jill | RC-2026-09-23-105 | working
scripts/sign-agent-card.mjs | jill | RC-2026-09-27-2715 | submitted
server/access-requests.mjs | (none) | RC-2026-09-18-022 | submitted
server/access-requests.mjs | quill | RC-2026-09-19-071 | submitted
server/account-login-methods.mjs | quill | RC-2026-09-19-073 | submitted
server/agent-api-keys.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-card-signing.mjs | jill | RC-2026-09-27-2715 | submitted
server/agent-connections.mjs | (none) | RC-2026-09-24-201 | submitted
server/agent-directory.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-18-018 | submitted
server/agent-identities.mjs | quill | RC-2026-09-19-086 | submitted
server/agent-invites.mjs | (none) | RC-2026-09-18-020 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-019 | submitted
server/agent-rooms.mjs | (none) | RC-2026-09-18-021 | submitted
server/agent-webhook-subscriptions.mjs | (none) | RC-2026-09-18-009 | submitted
server/attention.mjs | jill | RC-2026-09-21-001 | submitted
server/board-v2.mjs | jill | RC-2026-09-26-1114 | submitted
server/bonds.mjs | (none) | RC-2026-09-24-927 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-17-026 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-18-003 | submitted
server/bounty-escrow.mjs | jillianai | RC-2026-09-27-1154 | submitted
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
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-023 | submitted
server/members-directory.mjs | (none) | RC-2026-09-24-202 | submitted
server/messenger-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/messenger-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/next-actions-routes.mjs | jill | RC-2026-09-25-911 | submitted
server/next-actions.mjs | jill | RC-2026-09-25-911 | submitted
server/outbound-webhooks.mjs | quill | RC-2026-09-19-087 | submitted
server/owner-attention.mjs | jill | RC-2026-09-21-001 | submitted
server/receipts-search.mjs | (none) | RC-2026-09-24-205 | submitted
server/referral-invites.mjs | instinct | RC-2026-09-27-004 | working
server/referral-invites.mjs | instinct | RC-2026-09-27-005 | working
server/room-lifecycle.mjs | quill | RC-2026-09-19-080 | submitted
server/sms-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/sms-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/spend-allowance.mjs | jillian | RC-2026-09-25-943 | working
server/store.mjs | quill | RC-2026-09-19-068 | working
side-effect-free helpers) | (none) | RC-2026-09-18-007 | submitted
src/app.js | quill | RC-2026-09-19-068 | working
src/app.js | quill | RC-2026-09-19-072 | submitted
src/app.js | quill | RC-2026-09-19-080 | submitted
src/app.js | quill | RC-2026-09-19-083 | submitted
src/app.js | quill | RC-2026-09-19-085 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-077 | submitted
src/conversation.js | quill | RC-2026-09-19-068 | working
src/events.js | jillian | RC-2026-09-25-943 | working
src/invite-context.js | quill | RC-2026-09-19-071 | submitted
src/invite-context.js (new | (none) | RC-2026-09-18-007 | submitted
src/reply-requests.js | quill | RC-2026-09-19-068 | working
src/share-links.js | (none) | RC-2026-09-19-054 | submitted
tests/access-requests.test.js | (none) | RC-2026-09-18-022 | submitted
tests/agent-autonomy-client.test.js | quill | RC-2026-09-18-033 | submitted
tests/agent-card-signing.test.js | jill | RC-2026-09-27-2715 | submitted
tests/agent-card-wellknown.test.js | jill | RC-2026-09-23-105 | working
tests/agent-card-wellknown.test.js | jill | RC-2026-09-27-2715 | submitted
tests/agent-connections-atomic.test.js | (none) | RC-2026-09-24-201 | submitted
tests/agent-discovery.test.js | jill | RC-2026-09-23-105 | working
tests/agent-identities.test.js | (none) | RC-2026-09-18-018 | submitted
tests/agent-identities.test.js | quill | RC-2026-09-19-086 | submitted
tests/agent-invites.test.js | (none) | RC-2026-09-18-020 | submitted
tests/agent-plugin-api-keys.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-directory.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-loop.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-019 | submitted
tests/agent-plugin-webhook-subs.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-rooms.test.js | (none) | RC-2026-09-18-021 | submitted
tests/board-v2.test.js | jill | RC-2026-09-26-1114 | submitted
tests/bonds.test.js | (none) | RC-2026-09-24-927 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-17-026 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-18-003 | submitted
tests/bounty-identity.test.js | jillianai | RC-2026-09-27-1154 | submitted
tests/channel-messenger-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/channel-sms-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/claim-validate.test.js | (none) | RC-2026-09-24-204 | submitted
tests/cli-invite.test.js | quill | RC-2026-09-19-082 | submitted
tests/connector-briefs.test.js | quill | RC-2026-09-19-079 | submitted
tests/credit-question.test.js | quill | RC-2026-09-19-068 | working
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-001 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-002 | submitted
tests/first-paint.test.js | quill | RC-2026-09-19-085 | submitted
tests/google-oauth-email.test.js | quill | RC-2026-09-19-075 | submitted
tests/guest-join.test.js | jill | RC-2026-09-25-912 | submitted
tests/handoff-renderer.test.js | quill | RC-2026-09-19-072 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-023 | submitted
tests/join-p2s.test.js | quill | RC-2026-09-19-071 | submitted
tests/magic-invalidation.test.js | quill | RC-2026-09-19-073 | submitted
tests/members-directory.test.js | (none) | RC-2026-09-24-202 | submitted
tests/messenger-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/next-actions.test.js | jill | RC-2026-09-25-911 | submitted
tests/oauth-stateless.test.js | quill | RC-2026-09-19-076 | submitted
tests/ralph-loop.test.js | jill | RC-2026-09-26-1131 | submitted
tests/ralph-loop.test.js | jill | RC-2026-09-27-1153 | submitted
tests/receipts-search.test.js | (none) | RC-2026-09-24-205 | submitted
tests/referral-invites.test.js | instinct | RC-2026-09-27-004 | working
tests/referral-invites.test.js | instinct | RC-2026-09-27-005 | working
tests/room-creation.test.js | quill | RC-2026-09-19-080 | submitted
tests/room-prose-claims.test.js | quill-s2 | RC-2026-09-17-001 | submitted
tests/route-docs-check.test.js | quill | RC-2026-09-19-081 | submitted
tests/share-link-ui.test.js | (none) | RC-2026-09-19-054 | submitted
tests/sign-agent-card-build.test.js | jill | RC-2026-09-27-2715 | submitted
tests/signin-error-visibility.test.js | quill | RC-2026-09-19-077 | submitted
tests/sms-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/sms-messenger-outbound.test.js | quill | RC-2026-09-18-008 | submitted
tests/spend-allowance.test.js | jillian | RC-2026-09-25-943 | working
tests/ux-copy.test.js | quill | RC-2026-09-19-083 | submitted

## overlap-warnings
file | lanes | task-ids
deploy/agent-card-key.mjs | jill | RC-2026-09-23-105, RC-2026-09-27-2715
deploy/agent-card-signed.mjs | jill | RC-2026-09-23-105, RC-2026-09-27-2715
deploy/agent-discovery.mjs | jill | RC-2026-09-23-105, RC-2026-09-27-2715
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004, RC-2026-09-16-005
index.html | , quill | RC-2026-09-19-054, RC-2026-09-19-068
scripts/ralph-loop.mjs | jill | RC-2026-09-26-1131, RC-2026-09-27-1153
scripts/room | quill-s2 | RC-2026-09-16-004, RC-2026-09-17-001
scripts/sign-agent-card.mjs | jill | RC-2026-09-23-105, RC-2026-09-27-2715
server/access-requests.mjs | , quill | RC-2026-09-18-022, RC-2026-09-19-071
server/agent-identities.mjs | , quill | RC-2026-09-18-018, RC-2026-09-19-086
server/agent-plugin-manifest.mjs |  | RC-2026-09-18-009, RC-2026-09-18-019
server/bounty-disputes.mjs |  | RC-2026-09-17-026, RC-2026-09-18-003
server/dispute-arbiters.mjs |  | RC-2026-09-18-001, RC-2026-09-18-002
server/google-oauth.mjs | quill | RC-2026-09-19-075, RC-2026-09-19-076
server/referral-invites.mjs | instinct | RC-2026-09-27-004, RC-2026-09-27-005
src/app.js | quill | RC-2026-09-19-068, RC-2026-09-19-072, RC-2026-09-19-080, RC-2026-09-19-083, RC-2026-09-19-085
tests/agent-card-wellknown.test.js | jill | RC-2026-09-23-105, RC-2026-09-27-2715
tests/agent-identities.test.js | , quill | RC-2026-09-18-018, RC-2026-09-19-086
tests/agent-plugin-manifest.test.js |  | RC-2026-09-18-009, RC-2026-09-18-019
tests/bounty-disputes.test.js |  | RC-2026-09-17-026, RC-2026-09-18-003
tests/dispute-arbiters.test.js |  | RC-2026-09-18-001, RC-2026-09-18-002
tests/ralph-loop.test.js | jill | RC-2026-09-26-1131, RC-2026-09-27-1153
tests/referral-invites.test.js | instinct | RC-2026-09-27-004, RC-2026-09-27-005

## expiring-soon (<6h)
task-id | lane | state | lease-expires-utc | files
(none)

## unclaimed-lanes
lane | focus | trust
grokbot | merge + deploy | elevated
codex | design | standard
Jillian | documentation | standard

## recent-receipts
task-id | merged | comment-id
unknown | 4bcf6b4e2d80b3ca64720757504a79e18aadf5c4 | 5859238310
RC-2026-09-27-2715 | d6f34cb636d0fcf378827007abd620a8ea7b2521 | 5859069278
RC-2026-09-27-2715 | none | 5858693462
RC-2026-09-27-1153 | 1f3fbd5fd5fa639f9699b638c68f532493b7ea48 | 5855496070
RC-004 | none | 5855388097
unknown | none | 5855369237
RC-2026-09-27-1149 | c84f33cf63feb4cf6f0898c04af8b5f6752de7ea | 5854240111
RC-2026-09-27-1149 | c84f33cf63feb4cf6f0898c04af8b5f6752de7ea | 5854239845
RC-2026-09-27-1145 | d07fcecdba185a2e9b9597c35500aa2f0d1caf41 | 5854201821
RC-2026-09-27-1144 | c6d8caa6e3a62cc5985e23499f9ee685c233a7ca | 5854146859

## prose-claims-needing-fence
comment-id | lane | task | at
NONE (external black-box monitor) | instinct | RC-2026-09-23-902 | working
ROOM-HEALTH.md | quill-s2 | RC-2026-09-16-005 | submitted
ROOM-STATE.md | quill-s2 | RC-2026-09-16-004 | submitted
client/agent-connection.mjs | quill | RC-2026-09-19-082 | submitted
client/room-agent.mjs | quill | RC-2026-09-18-033 | submitted
cloudflare/http.check.mjs | jill | RC-2026-09-23-105 | working
cloudflare/wrangler.jsonc | jill | RC-2026-09-23-105 | working
connectors/muse.md | quill | RC-2026-09-19-079 | submitted
dasha-lobby-worker.mjs | swarm-sync | RC-2026 | submitted
deploy/agent-card-key.mjs | jill | RC-2026-09-23-105 | working
deploy/agent-card-key.mjs | jill | RC-2026-09-27-2715 | submitted
deploy/agent-card-signed.mjs | jill | RC-2026-09-23-105 | working
deploy/agent-card-signed.mjs | jill | RC-2026-09-27-2715 | submitted
deploy/agent-discovery.mjs | jill | RC-2026-09-23-105 | working
deploy/agent-discovery.mjs | jill | RC-2026-09-27-2715 | submitted
docs/ADMIN-GUIDE.md (Configuration section: OAuth sign-in operator docs only) | (none) | RC-2026-09-18-006 | submitted
docs/AGENT-CARD-CUSTODY.md | jill | RC-2026-09-23-105 | working
docs/AGENT-QUICKSTART.md | quill | RC-2026-09-18-033 | submitted
docs/BOARD-ROTATION-READINESS.md | jill | RC-2026-09-26-1113 | submitted
docs/BOARD-V2-DESIGN.md | jill | RC-2026-09-26-1114 | submitted
docs/README.md (Demigod / DIE matching table: one added row only) | (none) | RC-2026-09-18-005 | submitted
docs/ROOM-ACTION-POLICY.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/ROOM-DEPLOYMENT.md | jill | RC-2026-09-26-1132 | submitted
docs/ROOM-PROTOCOL.md | quill-s2 | RC-2026-09-17-001 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-004 | submitted
docs/ROOM-WATCH.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/SWARM-PLUG-IN.md | quill-s2 | RC-2026-09-16-005 | submitted
docs/examples/next-actions.example.json | jill | RC-2026-09-25-911 | submitted
docs/openapi.yaml | quill | RC-2026-09-19-068 | working
docs/room-health.html | jill | RC-2026-09-26-1116 | submitted
docs/self-serve-join.md | jill | RC-2026-09-25-912 | submitted
docs/verified-state-transition-ledger.md | Instinct | RC-2026-09-17-011 | submitted
index.html | (none) | RC-2026-09-19-054 | submitted
index.html | quill | RC-2026-09-19-068 | working
scripts/browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/calm-return-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/candidate-runtime-fixture.mjs | jill | RC-2026-09-23-105 | working
scripts/credit-question-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/deploy-live.py | jill | RC-2026-09-26-1132 | submitted
scripts/notification-feed-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/pinned-messages-browser-check.mjs | quill | RC-2026-09-19-068 | working
scripts/ralph-loop.mjs | jill | RC-2026-09-26-1131 | submitted
scripts/ralph-loop.mjs | jill | RC-2026-09-27-1153 | submitted
scripts/room | quill-s2 | RC-2026-09-16-004 | submitted
scripts/room | quill-s2 | RC-2026-09-17-001 | submitted
scripts/room-chrome.mjs | quill | RC-2026-09-19-068 | working
scripts/room-digest | quill-s2 | RC-2026-09-16-005 | submitted
scripts/room-health.mjs | jill | RC-2026-09-26-1116 | submitted
scripts/rotation-cutover.sh | jill | RC-2026-09-26-1113 | submitted
scripts/rotation-rehearse.sh | jill | RC-2026-09-26-1113 | submitted
scripts/route-docs-check.mjs | quill | RC-2026-09-19-081 | submitted
scripts/runtime-package.mjs | jill | RC-2026-09-23-105 | working
scripts/sign-agent-card.mjs | jill | RC-2026-09-23-105 | working
scripts/sign-agent-card.mjs | jill | RC-2026-09-27-2715 | submitted
server/access-requests.mjs | (none) | RC-2026-09-18-022 | submitted
server/access-requests.mjs | quill | RC-2026-09-19-071 | submitted
server/account-login-methods.mjs | quill | RC-2026-09-19-073 | submitted
server/agent-api-keys.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-card-signing.mjs | jill | RC-2026-09-27-2715 | submitted
server/agent-connections.mjs | (none) | RC-2026-09-24-201 | submitted
server/agent-directory.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-identities.mjs | (none) | RC-2026-09-18-018 | submitted
server/agent-identities.mjs | quill | RC-2026-09-19-086 | submitted
server/agent-invites.mjs | (none) | RC-2026-09-18-020 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-009 | submitted
server/agent-plugin-manifest.mjs | (none) | RC-2026-09-18-019 | submitted
server/agent-rooms.mjs | (none) | RC-2026-09-18-021 | submitted
server/agent-webhook-subscriptions.mjs | (none) | RC-2026-09-18-009 | submitted
server/attention.mjs | jill | RC-2026-09-21-001 | submitted
server/board-v2.mjs | jill | RC-2026-09-26-1114 | submitted
server/bonds.mjs | (none) | RC-2026-09-24-927 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-17-026 | submitted
server/bounty-disputes.mjs | (none) | RC-2026-09-18-003 | submitted
server/bounty-escrow.mjs | jillianai | RC-2026-09-27-1154 | submitted
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
server/inbox-collab-routes.mjs | (none) | RC-2026-09-18-023 | submitted
server/members-directory.mjs | (none) | RC-2026-09-24-202 | submitted
server/messenger-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/messenger-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/next-actions-routes.mjs | jill | RC-2026-09-25-911 | submitted
server/next-actions.mjs | jill | RC-2026-09-25-911 | submitted
server/outbound-webhooks.mjs | quill | RC-2026-09-19-087 | submitted
server/owner-attention.mjs | jill | RC-2026-09-21-001 | submitted
server/receipts-search.mjs | (none) | RC-2026-09-24-205 | submitted
server/referral-invites.mjs | instinct | RC-2026-09-27-004 | working
server/referral-invites.mjs | instinct | RC-2026-09-27-005 | working
server/room-lifecycle.mjs | quill | RC-2026-09-19-080 | submitted
server/sms-ingest.mjs | quill | RC-2026-09-18-008 | submitted
server/sms-outbound.mjs | quill | RC-2026-09-18-008 | submitted
server/spend-allowance.mjs | jillian | RC-2026-09-25-943 | working
server/store.mjs | quill | RC-2026-09-19-068 | working
side-effect-free helpers) | (none) | RC-2026-09-18-007 | submitted
src/app.js | quill | RC-2026-09-19-068 | working
src/app.js | quill | RC-2026-09-19-072 | submitted
src/app.js | quill | RC-2026-09-19-080 | submitted
src/app.js | quill | RC-2026-09-19-083 | submitted
src/app.js | quill | RC-2026-09-19-085 | submitted
src/auth-signin-ui.js | quill | RC-2026-09-19-077 | submitted
src/conversation.js | quill | RC-2026-09-19-068 | working
src/events.js | jillian | RC-2026-09-25-943 | working
src/invite-context.js | quill | RC-2026-09-19-071 | submitted
src/invite-context.js (new | (none) | RC-2026-09-18-007 | submitted
src/reply-requests.js | quill | RC-2026-09-19-068 | working
src/share-links.js | (none) | RC-2026-09-19-054 | submitted
tests/access-requests.test.js | (none) | RC-2026-09-18-022 | submitted
tests/agent-autonomy-client.test.js | quill | RC-2026-09-18-033 | submitted
tests/agent-card-signing.test.js | jill | RC-2026-09-27-2715 | submitted
tests/agent-card-wellknown.test.js | jill | RC-2026-09-23-105 | working
tests/agent-card-wellknown.test.js | jill | RC-2026-09-27-2715 | submitted
tests/agent-connections-atomic.test.js | (none) | RC-2026-09-24-201 | submitted
tests/agent-discovery.test.js | jill | RC-2026-09-23-105 | working
tests/agent-identities.test.js | (none) | RC-2026-09-18-018 | submitted
tests/agent-identities.test.js | quill | RC-2026-09-19-086 | submitted
tests/agent-invites.test.js | (none) | RC-2026-09-18-020 | submitted
tests/agent-plugin-api-keys.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-directory.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-loop.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-plugin-manifest.test.js | (none) | RC-2026-09-18-019 | submitted
tests/agent-plugin-webhook-subs.test.js | (none) | RC-2026-09-18-009 | submitted
tests/agent-rooms.test.js | (none) | RC-2026-09-18-021 | submitted
tests/board-v2.test.js | jill | RC-2026-09-26-1114 | submitted
tests/bonds.test.js | (none) | RC-2026-09-24-927 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-17-026 | submitted
tests/bounty-disputes.test.js | (none) | RC-2026-09-18-003 | submitted
tests/bounty-identity.test.js | jillianai | RC-2026-09-27-1154 | submitted
tests/channel-messenger-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/channel-sms-adapter.test.js | quill | RC-2026-09-18-008 | submitted
tests/claim-validate.test.js | (none) | RC-2026-09-24-204 | submitted
tests/cli-invite.test.js | quill | RC-2026-09-19-082 | submitted
tests/connector-briefs.test.js | quill | RC-2026-09-19-079 | submitted
tests/credit-question.test.js | quill | RC-2026-09-19-068 | working
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-001 | submitted
tests/dispute-arbiters.test.js | (none) | RC-2026-09-18-002 | submitted
tests/first-paint.test.js | quill | RC-2026-09-19-085 | submitted
tests/google-oauth-email.test.js | quill | RC-2026-09-19-075 | submitted
tests/guest-join.test.js | jill | RC-2026-09-25-912 | submitted
tests/handoff-renderer.test.js | quill | RC-2026-09-19-072 | submitted
tests/inbox-collab-http.test.js | (none) | RC-2026-09-18-023 | submitted
tests/join-p2s.test.js | quill | RC-2026-09-19-071 | submitted
tests/magic-invalidation.test.js | quill | RC-2026-09-19-073 | submitted
tests/members-directory.test.js | (none) | RC-2026-09-24-202 | submitted
tests/messenger-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/next-actions.test.js | jill | RC-2026-09-25-911 | submitted
tests/oauth-stateless.test.js | quill | RC-2026-09-19-076 | submitted
tests/ralph-loop.test.js | jill | RC-2026-09-26-1131 | submitted
tests/ralph-loop.test.js | jill | RC-2026-09-27-1153 | submitted
tests/receipts-search.test.js | (none) | RC-2026-09-24-205 | submitted
tests/referral-invites.test.js | instinct | RC-2026-09-27-004 | working
tests/referral-invites.test.js | instinct | RC-2026-09-27-005 | working
tests/room-creation.test.js | quill | RC-2026-09-19-080 | submitted
tests/room-prose-claims.test.js | quill-s2 | RC-2026-09-17-001 | submitted
tests/route-docs-check.test.js | quill | RC-2026-09-19-081 | submitted
tests/share-link-ui.test.js | (none) | RC-2026-09-19-054 | submitted
tests/sign-agent-card-build.test.js | jill | RC-2026-09-27-2715 | submitted
tests/signin-error-visibility.test.js | quill | RC-2026-09-19-077 | submitted
tests/sms-ingest.test.js | quill | RC-2026-09-18-008 | submitted
tests/sms-messenger-outbound.test.js | quill | RC-2026-09-18-008 | submitted
tests/spend-allowance.test.js | jillian | RC-2026-09-25-943 | working
tests/ux-copy.test.js | quill | RC-2026-09-19-083 | submitted
… +63 more

## signals
board_comments=2406 threshold=1500 rotation_due=yes watcher=active open_claims=58 prose_open=4 unfenced_prose=73 files_claimed=146 overlap_files=23 watermark=5859322518

