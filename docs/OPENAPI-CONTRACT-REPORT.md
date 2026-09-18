# OpenAPI contract accuracy report

Generated 2026-09-18T18:41:48.557Z by scripts/openapi-method-accuracy.mjs (TASKS.md task 16).
Method: every operation in docs/openapi.yaml is probed against a scratch
server with its documented method; 405 on the documented method (or a
double-404 on an alternate method) is a contract mismatch. Path-template
coverage is enforced separately by scripts/route-docs-check.mjs.

## Summary

- Documented operations: 158
- Unique paths: 134
- Served route templates (static): 136
- Contract mismatches: 0

## Operations

| Method | Path | Security | Verdict |
| --- | --- | --- | --- |
| POST | `/api/rooms/{roomId}/commands` | default | ok |
| GET | `/api/rooms/{roomId}/events` | default | ok |
| GET | `/api/rooms/{roomId}/stream` | default | ok |
| GET | `/api/rooms/{roomId}/presence` | default | ok |
| GET | `/api/rooms/{roomId}/export` | default | ok |
| POST | `/api/rooms/{roomId}/import` | default | ok |
| GET | `/api/rooms/{roomId}/messages/{messageId}/thread` | default | ok |
| GET | `/api/rooms/{roomId}/search` | default | ok |
| GET | `/api/rooms/{roomId}/pins` | default | ok |
| POST | `/api/rooms/{roomId}/pins` | default | ok |
| POST | `/api/agent-identities` | open | ok |
| GET | `/api/rooms/{roomId}/identity-links` | default | ok |
| POST | `/api/rooms/{roomId}/identity-links` | default | ok |
| DELETE | `/api/rooms/{roomId}/identity-links` | default | ok |
| GET | `/api/rooms/{roomId}/agent-pause` | default | ok |
| POST | `/api/rooms/{roomId}/agent-pause` | default | ok |
| GET | `/api/rooms/{roomId}/provider-heartbeats` | default | ok |
| GET | `/api/rooms/{roomId}/onboarding-funnel` | default | ok |
| GET | `/api/rooms/{roomId}/spend-allowance` | default | ok |
| POST | `/api/rooms/{roomId}/spend-allowance` | default | ok |
| GET | `/api/rooms/{roomId}/usage` | default | ok |
| GET | `/api/rooms/{roomId}/invitations` | default | ok |
| POST | `/api/rooms/{roomId}/invitations` | accountSession | ok |
| GET | `/api/rooms/{roomId}/access-review` | default | ok |
| GET | `/api/rooms/{roomId}/access-requests` | default | ok |
| POST | `/api/rooms/{roomId}/access-requests/{id}/decide` | default | ok |
| POST | `/api/rooms/{roomId}/ownership/transfer` | default | ok |
| GET | `/api/rooms/{roomId}/capabilities` | default | ok |
| GET | `/api/rooms/{roomId}/work-sessions` | default | ok |
| POST | `/api/rooms/{roomId}/work-sessions` | default | ok |
| GET | `/api/rooms/{roomId}/work-context` | default | ok |
| GET | `/api/rooms/{roomId}/work-result` | default | ok |
| GET | `/api/rooms/{roomId}/return-brief` | default | ok |
| GET | `/api/rooms/{roomId}/notifications` | default | ok |
| POST | `/api/rooms/{roomId}/cursor` | default | ok |
| POST | `/api/rooms/{roomId}/reports` | default | ok |
| GET | `/api/rooms/{roomId}/reports` | default | ok |
| GET | `/api/rooms/{roomId}/agent-inbox` | default | ok |
| GET | `/api/health` | open | ok |
| GET | `/api/version` | open | ok |
| GET | `/api/ready` | open | ok |
| GET | `/api/guest-agent-links` | open | ok |
| GET | `/api/work-item-sessions` | open | ok |
| GET | `/api/account-session` | open | ok |
| POST | `/api/account-session` | accountSession | ok |
| DELETE | `/api/account-session` | accountSession | ok |
| POST | `/api/auth/recovery-codes/generate` | accountSession | ok |
| POST | `/api/auth/recovery-codes/redeem` | open | ok |
| GET | `/api/auth/recovery-codes/status` | accountSession | ok |
| GET | `/api/auth/methods` | accountSession | ok |
| POST | `/api/auth/methods/disable` | accountSession | ok |
| POST | `/api/auth/methods/enable` | accountSession | ok |
| POST | `/api/auth/methods/remove` | accountSession | ok |
| POST | `/api/auth/password/set` | accountSession | ok |
| GET | `/api/auth/github/link/start` | accountSession | ok |
| GET | `/api/auth/google/link/start` | accountSession | ok |
| POST | `/api/auth/magic/request` | accountSession | ok |
| POST | `/api/auth/magic/consume` | accountSession | ok |
| POST | `/api/auth/passkey/register/options` | accountSession | ok |
| POST | `/api/auth/passkey/register/finish` | accountSession | ok |
| POST | `/api/auth/passkey/authenticate/options` | open | ok |
| POST | `/api/auth/passkey/authenticate/finish` | open | ok |
| POST | `/api/auth/password/signup` | open | ok |
| POST | `/api/auth/password/login` | open | ok |
| POST | `/api/auth/password/change` | accountSession | ok |
| POST | `/api/agent-invites/redeem` | open | ok |
| GET | `/api/agent-invites/preview` | open | ok |
| POST | `/api/access-requests` | open | ok |
| POST | `/api/agent-rooms` | bearerAuth | ok |
| GET | `/api/access-requests/{id}` | open | ok |
| POST | `/api/share-links/preview` | open | ok |
| POST | `/api/invitations/preview` | open | ok |
| POST | `/api/guest-agent-links/preview` | open | ok |
| POST | `/api/guest-agent-links/join` | open | ok |
| POST | `/api/session` | open | ok |
| GET | `/api/session` | default | ok |
| DELETE | `/api/session` | default | ok |
| GET | `/api/account-rooms` | accountSession | ok |
| POST | `/api/account-rooms` | accountSession | ok |
| GET | `/api/inbox/connections` | accountSession | ok |
| GET | `/api/inbox/connections/{id}` | accountSession | ok |
| POST | `/api/inbox/connections/{id}/reconnect` | accountSession | ok |
| POST | `/api/inbox/connections/commands` | accountSession | ok |
| POST | `/api/inbox/channel-sends` | accountSession | ok |
| POST | `/api/inbox/connections/{id}/sync` | accountSession | ok |
| POST | `/api/inbox/webhooks/{connectionId}` | open | ok |
| GET | `/api/inbox` | accountSession | ok |
| GET | `/api/inbox/search` | accountSession | ok |
| GET | `/api/inbox/threads` | accountSession | ok |
| GET | `/api/inbox/digest` | accountSession | ok |
| GET | `/api/inbox/sla/dashboard` | accountSession | ok |
| GET | `/api/inbox/handoffs` | accountSession | ok |
| POST | `/api/inbox/handoffs` | accountSession | ok |
| POST | `/api/inbox/handoffs/transition` | accountSession | ok |
| POST | `/api/rooms/{roomId}/collab/assignments` | roomToken | ok |
| GET | `/api/rooms/{roomId}/collab/assignments` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/assignments/{id}/release` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/notes` | roomToken | ok |
| GET | `/api/rooms/{roomId}/collab/notes` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/draft-locks/acquire` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/draft-locks/release` | roomToken | ok |
| GET | `/api/rooms/{roomId}/collab/draft-locks` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/approvals` | roomToken | ok |
| GET | `/api/rooms/{roomId}/collab/approvals` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/approvals/{id}/decide` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/approvals/{id}/resubmit` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/routing/mentions` | roomToken | ok |
| GET | `/api/rooms/{roomId}/collab/routing` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/routing/{id}/resolve` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/routing/policy` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/handoffs` | roomToken | ok |
| GET | `/api/rooms/{roomId}/collab/handoffs` | roomToken | ok |
| POST | `/api/rooms/{roomId}/collab/handoffs/{id}/transition` | roomToken | ok |
| GET | `/api/inbox/stitch/status` | accountSession | ok |
| GET | `/api/inbox/stitch/suggestions` | accountSession | ok |
| POST | `/api/inbox/stitch/confirm` | accountSession | ok |
| POST | `/api/inbox/stitch/dismiss` | accountSession | ok |
| POST | `/api/inbox/stitch/split` | accountSession | ok |
| GET | `/api/inbox/quarantine` | accountSession | ok |
| GET | `/api/inbox/quarantine/coverage` | accountSession | ok |
| POST | `/api/inbox/quarantine/release` | accountSession | ok |
| POST | `/api/inbox/quarantine/dismiss` | accountSession | ok |
| POST | `/api/inbox/quarantine/split` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/attachments` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/attachments/{attachmentId}` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/share-context` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/room-results` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/send-context` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/sends` | accountSession | ok |
| GET | `/api/inbox/sources/{sourceId}/reply-review` | accountSession | ok |
| POST | `/api/inbox/commands` | accountSession | ok |
| POST | `/api/inbox/review` | accountSession | ok |
| POST | `/api/inbox/simulation` | accountSession | ok |
| POST | `/api/share-links/join` | accountSession | ok |
| POST | `/api/invitations/accept` | accountSession | ok |
| POST | `/api/guest-agent-links` | default | ok |
| GET | `/api/rooms/{roomId}` | default | ok |
| GET | `/api/rooms/{roomId}/agent-connections` | accountSession | ok |
| POST | `/api/rooms/{roomId}/agent-connections` | accountSession | ok |
| GET | `/api/rooms/{roomId}/agent-invites` | default | ok |
| POST | `/api/rooms/{roomId}/agent-invites` | default | ok |
| DELETE | `/api/rooms/{roomId}/agent-invites` | default | ok |
| GET | `/api/rooms/{roomId}/charter` | default | ok |
| GET | `/api/rooms/{roomId}/diagnostics` | accountSession | ok |
| GET | `/api/rooms/{roomId}/diagnostics-export` | default | ok |
| POST | `/api/rooms/{roomId}/guest-agent-links` | default | ok |
| POST | `/api/rooms/{roomId}/invitations/{invitationId}/revoke` | accountSession | ok |
| GET | `/api/rooms/{roomId}/reminders` | default | ok |
| POST | `/api/rooms/{roomId}/reminders` | default | ok |
| GET | `/api/rooms/{roomId}/reply-requests` | default | ok |
| GET | `/api/rooms/{roomId}/reply-context` | default | ok |
| GET | `/api/rooms/{roomId}/reply-history` | default | ok |
| GET | `/api/rooms/{roomId}/share-links` | roomSession,accountSession | ok |
| POST | `/api/rooms/{roomId}/share-links` | roomSession,accountSession | ok |
| POST | `/api/rooms/{roomId}/share-links-cancel` | roomSession,accountSession | ok |
| GET | `/api/rooms/{roomId}/work-changes` | default | ok |
| GET | `/api/rooms/{roomId}/work-discussion` | default | ok |
