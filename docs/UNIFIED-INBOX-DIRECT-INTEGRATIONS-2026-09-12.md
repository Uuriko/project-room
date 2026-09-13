# Unified Inbox: useful features and direct connections

## Decision

Keep one account-private Inbox with All, Email and Messages views. Views are filters,
not separate copies or separate permissions. No Beeper requirement: John explicitly
rejected an integration that would require every user to use Beeper. His latest
priority is popular services with straightforward integration: Telegram bot intake
first, Slack second. Personal Telegram history, SMS, WhatsApp and Signal follow.

## Patterns worth adopting

- **Superhuman:** small, purposeful splits and quick triage. Its Split Inbox supports
  separating categories and handling items with actions such as snooze and done.
  Adopt fast filtering and keyboard navigation first; add durable Done/Snooze after
  the read model is stable. Do not hide mail based on uncertain AI judgments.
  [Superhuman Split Inbox](https://new.superhuman.com/split-inbox-88255)
- **Missive:** collaboration around conversations rather than forwarding everything.
  Project Room already has excerpt/private-recipient sharing and room work; improve
  those seams instead of duplicating a team-chat product inside Inbox.
  [Missive](https://missiveapp.com/)
- **Beeper:** one consistent conversation surface across networks, with explicit
  on-device versus cloud connection tradeoffs. Its Desktop API depends on Beeper
  running and is recommended for personal use. Learn from the UI; do not adopt it
  as a required dependency. Copying messages into Project Room introduces another
  storage boundary even when the upstream connection is end-to-end encrypted.
  [Desktop API](https://developers.beeper.com/desktop-api/),
  [storage boundaries](https://help.beeper.com/en_US/troubleshooting/beeper-on-device-vs-beeper-cloud-what-goes-to-beeper-servers)

## Connection sequence

| Service | Direct path | Scope and setup reality |
|---|---|---|
| Telegram, first | Bot API | Receives permitted bot conversations, not an automatic copy of personal chat history. Bot credential, explicit account/chat binding, one polling owner, and durable offset required. |
| Slack, second | OAuth + Events API or Socket Mode | Workspace installation and granular scopes; subscribe only to selected, authorized conversation types. Add per-event deduplication and revocation handling. |
| Personal Telegram | Official TDLib | Project API ID/hash and per-user authorization. Own encrypted session storage, updates, edit/delete handling, and client maintenance. Not needed for initial bot intake. |
| SMS | Number-provider webhooks | A provisioned number, not automatic access to someone's existing phone messages. Phone-native integration is a different project. No number purchased here. |
| WhatsApp Business | Official Cloud API/provider | Business account and sender setup; not a generic personal WhatsApp client. Respect messaging windows, templates and consent. |
| Personal WhatsApp | Linked-device implementation | Evaluate separately; unofficial WhatsApp Web libraries add compatibility and account risk. No silent fallback. |
| Signal | Linked-device implementation | signal-cli is unofficial; device linking, local keys and maintenance required. No production reliability claim yet. |

Sources: [Telegram Bot API](https://core.telegram.org/bots/api),
[Slack Events API](https://docs.slack.dev/apis/events-api/),
[TDLib](https://core.telegram.org/tdlib/getting-started),
[SMS webhooks](https://www.twilio.com/docs/usage/webhooks/messaging-webhooks),
[WhatsApp Business](https://www.twilio.com/docs/whatsapp/api),
[Baileys upstream](https://github.com/WhiskeySockets/Baileys),
[signal-cli](https://github.com/AsamK/signal-cli).

## Implemented in this checkpoint

- All / Email / Messages views; sender/subject search over downloaded items only.
- `/` focuses search, `j`/`k` moves through visible items outside editing fields/dialogs.
- Hidden selections stop rendering; draft buffers survive filtering. Account changes
  clear queries, lists and view state. Queries are not stored in browser storage.
- Email reading no longer labels actual Gmail messages as sample email.
- Optional `telegram-bot-reader.mjs`: fixed official endpoint, bounded responses,
  explicit permitted chat IDs, account/connection checks before and after network,
  stable account-scoped message identity, safe text projection and sanitized errors.
  Protected, ephemeral and unsupported content is skipped explicitly.

The Telegram reader is NOT wired to HTTP, durable Inbox storage or a live bot.
Its observations must never be disguised as synthetic data or email. No Telegram,
Slack, SMS, WhatsApp or Signal account was connected in this checkpoint.
Telegram's developer login was opened while considering TDLib; bot-first setup uses
BotFather instead and does not need the TDLib application credentials yet.
John completed that developer login. The Project Room / ProjectRoomInbox desktop-app
form is filled but not submitted; developer credential creation awaits confirmation.

## Next implementation gates

1. Persist a distinct messaging envelope: provider, connection/account identity,
   conversation/message IDs, revision, sender, time, plain text and attachment metadata.
   Keep provider identities separate; never merge contacts just because names match.
2. Add trusted importer authority, schema/recovery checks, idempotent page writes and
   a durable per-bot offset. Telegram acknowledges earlier updates when the next offset
   is sent: never advance it before recording the page. Never share one bot's polling
   cursor across unrelated account workers. Unsupported skips need operational visibility.
3. Store bot credentials privately; bind account ownership through an explicit setup
   flow. Never accept a caller-selected account ID from an incoming message as authority.
4. Test bot receive end to end with an intentionally sent test message. Verify no room
   events or automatic replies, reconnect safety, duplicate handling, and crash recovery.
5. Add explicit reply preview/outbox receipts before sending. Then threads, attachment
   previews, local Done/Snooze, sync health, and opt-in rules. Provider read/unread/archive
   mutations remain distinct from Project Room-only triage.
6. Fix capacity before a broad rollout: the existing private Inbox has a 100-source pilot
   limit and immutable history. Search is not full-mailbox search. Add bounded pagination,
   retention/deletion semantics and indexes; do not merely remove the limits.

Acceptance: real receive/send tests per enabled service; isolated users; no secrets in
browser logs; drafts preserved across navigation; truthful pending/offline/error states;
keyboard and mobile checks; no public deployment until the production gates pass.
