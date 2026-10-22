# Deferred email workspace

John removed Inbox and email integrations from v1 on 2026-10-19. These browser modules are retained for a possible future product decision, not shipped as public assets. Email login, recovery and agent coordination are independent and remain supported. Existing mailbox records are not deleted.

Browser suites excluded from the release command:
- scripts/gmail-setup-browser-check.mjs
- scripts/gmail-workspace-browser-check.mjs
- scripts/inbox-browser-check.mjs
- scripts/inbox-collaboration-check.mjs
- scripts/inbox-conversation-browser-check.mjs
- scripts/inbox-quarantine-review-check.mjs
- scripts/inbox-telegram-check.mjs
- scripts/inbox-unified-check.mjs

The normal server returns 404 for private `/api/inbox` and Gmail OAuth routes. `enableDeferredInbox` is an explicit constructor option used only by isolated compatibility fixtures; no deployed entrypoint enables it. The agent coordination inbox and account email authentication are separate features and remain supported.

The former account-workspace browser suite is also deferred because its scenarios depend on private Inbox drafts. Account settings, deletion, sign-in, room lifecycle and room-only recovery retain separate release coverage.
