# Inbox connector readiness

## Actual status

Inbox is not yet a live universal inbox. Existing email imports are fixture-mode, real email sends are explicitly unavailable, and the new GraphMailReader is a tested read-only network component, not an installed mailbox connection. No account was linked, no customer email read, and no message sent during this checkpoint. No deployment occurred.

The new component requests Microsoft Graph messages and folder delta pages, converts hydrated messages into the existing email contract, and preserves folder-removal observations without treating them as global deletion. It validates the current mailbox identity, obtains authorization for every request, rejects cross-origin/cross-folder continuation links, disables redirects, bounds response size and work per page, and returns sanitized error categories. Attachments remain not_loaded, never silently complete. Message HTML is not rendered or fetched.

The host must supply an authorization callback that checks the signed-in Project Room account, active connection, revision, mailbox binding and token expiry. Callback grant fields are trusted server-side state, not browser input. Tokens are never persisted by this component. Its output is an uncommitted batch: a host must atomically store observations with the sync cursor and recheck current authority. The module is intentionally not wired to fixture import routes or the synthetic send driver.

## Required next implementation

1. Register or select the production OAuth application and callback origin. Bind the callback to an authenticated Project Room account using state and PKCE; do not mistake Google sign-in for permission to access Gmail.
2. Add encrypted server-side token storage, refresh, disconnect and revocation. Use least-privilege delegated mailbox permissions. Resolve the provider identity and pin it before storing the connection. Never use a room-agent key as mailbox authority.
3. Extend the existing email import model with a reviewed live-provider mode and recovery-compatible replay. Do not relabel fixture imports as connected. Add transaction-bound sync checkpoints, obsolete delta handling and recoverable per-message errors.
4. Wire an account-owned Connect email flow and show connected/syncing/needs sign-in states. Preserve saved drafts when connections fail. Keep sample messages visibly distinct from real ones.
5. Implement provider-specific reply draft creation, exact-preview approval, send and uncertain-outcome reconciliation. Real mail currently cannot use the synthetic outbox as a shortcut. Do not treat API acceptance as confirmed delivery.
6. Verify with an explicitly selected mailbox and test destination, including receive, read, reply, reconnect, disconnect, duplicate notification, changed message, expired token and lost send response.
7. Only then expand platform coverage. Every connector must identify what history, recipients and message types it can actually access.

## Platform scope

| Service | Supported integration path to qualify | What must not be promised |
| --- | --- | --- |
| Gmail / Google Workspace | Gmail API with user OAuth, mailbox read and separate sending scopes | Existing app sign-in or this assistant's Gmail connector does not authorize the deployed product. [Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest), [scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) |
| Outlook / Microsoft 365 | Delegated Graph mailbox connection; new reader is the initial component | A normalized fixture is not a connected mailbox. [Get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0), [delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0), [immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) |
| Slack | Installed app with approved scopes and subscribed message events | Installation does not imply access to every private conversation. [Scopes](https://docs.slack.dev/reference/scopes/), [Events API](https://docs.slack.dev/apis/events-api/) |
| Discord | Installed bot with appropriate channel permissions and event access | A server bot is not a personal-account history mirror. [Bots](https://docs.discord.com/developers/platform/bots) |
| Telegram | Bot connection and explicitly available chats; account-client mode is a different project requiring separate qualification | Bot access is not access to all personal chats. [Bot FAQ](https://core.telegram.org/bots/faq). Specific bot-to-bot capabilities need their own current checks; do not rely on the FAQ's blanket older wording. |
| WhatsApp | Business messaging integration, subject to use-case and provider-policy qualification | Not unrestricted consumer-account mirroring; AI-provider restrictions require review. [Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) |
| SMS/MMS | A configured messaging number and authenticated provider webhooks | Not a copy of the user's existing phone history. [Twilio messaging webhooks](https://www.twilio.com/docs/usage/webhooks/messaging-webhooks) |
| Signal | Investigate supported linked-device experience and separately qualify any unofficial bridge | Linked-device support is not proof of a hosted integration API. [Linked Devices](https://support.signal.org/hc/en-us/articles/360007320551-Linked-Devices) |
| Teams, Instagram, Messenger, iMessage, other services | Separate capability, account-type and policy qualification required before selecting an adapter | No current support claim; no generic 'Connect anything' button that implies unavailable access. |

## Service provisioning check

The service catalog includes email infrastructure such as AgentMail and Twilio email. AgentMail's catalog description is for creating programmatic agent inboxes; that does not connect an existing human Gmail or Outlook account. No service was provisioned because this would not resolve the immediate personal-mailbox integration gap.

Provisioning preflight also reported BROWSER_AUTH_REQUIRED and no initialized project. This is an optional infrastructure-path blocker, not the sole reason the inbox is incomplete. Application OAuth, encrypted credential storage, persistence wiring and send implementation still remain.

## Verification and limits

The new reader's tests use mocked HTTP responses, including real-shaped Graph fixtures. They do not establish that a production tenant, token, callback, or mailbox has been configured. The initial reader supports the global graph.microsoft.com endpoint only and a conservative page bound of 25; larger pages stop without advancing progress. A message disappearing during hydration stops the batch rather than guessing a global deletion. Robust reconciliation and attachment fetching remain follow-on work.

Focused verification: 79/79 tests across the new reader, existing email contract/import, private grants, and outbox. Full regression results are recorded in the checkpoint message. No existing source files were changed in this slice.
