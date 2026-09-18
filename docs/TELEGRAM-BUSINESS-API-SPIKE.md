# Telegram Business API ("secretary bot") spike

**Status:** evaluated 2026-09-17 — **do not build now; additive adapter variant later, only if John approves personal-chat coverage (task 12).**
**Owner of the decision:** [JOHN] (task 12). **Code lane:** autonomous, but sequencing after tasks 3–10.

This doc defines "the developer thing" precisely enough that the question stops recurring. It evaluates the
Telegram Business API — Telegram's own name for the feature is **"Secretary Bots"**
([Business Bots, Bot Features](https://core.telegram.org/bots/features?ref=blog.n8n.io)) — against the project-room inbox,
lists the exact normalization deltas in `server/channel-adapters/telegram.mjs`, and ends with go/no-go criteria.

Terminology follows the merged decision doc `docs/TELEGRAM-INBOUND-DECISION.md` (PR #529):
"the developer thing" = Business API (secretary bot) ⊃ MTProto/userbot (ruled out, task 13) ⊃ newer Bot API surface (incremental).

## What it is (verified from primary sources)

A business-account owner links **one bot** to their personal/business account, in-app. The bot then receives
updates for the owner's chats and can act on the owner's behalf. Bot API 7.2 (2024-03-31) introduced it;
**Bot API 10.0 (2026-05-08) removed the Telegram Premium requirement** on the account owner
("Allowed Secretary Bots to manage accounts of users without a Telegram Premium subscription",
[api-changelog](https://core.telegram.org/bots/api-changelog#may-8-2026)).
Premium is still required for the *other* Telegram Business features (opening hours, location, quick replies,
away/greeting messages, custom start page) — not for the secretary-bot connection.

Setup flow (primary source: [Business Bots](https://core.telegram.org/bots/features?ref=blog.n8n.io)):

1. Developer: enable **Secretary Mode** for the bot in @BotFather (Bot Settings → Secretary Mode).
2. Account owner (John), in the Telegram app: **Settings → Telegram Business → Chatbots** → add the bot by
   @username, choose which chats it can access (all 1-to-1 chats, selected chats, excluded chats), grant rights.
3. The bot receives a `business_connection` update (`BusinessConnection`: `id`, `user`, `user_chat_id`, `date`,
   optional `rights`, `is_enabled`). Rights (`BusinessBotRights`) include `can_reply`, `can_read_messages`,
   `can_delete_sent_messages`, `can_delete_all_messages`, plus account-management rights
   (`can_edit_name/bio/profile_photo/username`, gift/Stars rights, `can_manage_stories`).
4. Users connecting the bot see a quick-action bar at the top of each managed chat; "Manage Bot" deep-links the
   user into the bot with `/start bizChat<user_chat_id>`.
5. The owner can revoke or edit the connection at any time; the bot learns about it via a new
   `business_connection` update.

Constraint reported by multiple independent operator guides (not a primary-source quote, verify during pilot):
**one bot per account** — to switch bots the owner must disconnect the current one. John's account can only
feed one bot at a time.

## Update shapes (Bot API, verified 2026-09-17)

All arrive on the same webhook/getUpdates channel as bot updates; no new transport is needed.

### `business_message` / `edited_business_message` — `Message`

"New message from a connected business account" / "New version of a message from a connected business account".
Shape is an ordinary `Message` with two business-specific fields:

| Field | Type | Meaning |
|---|---|---|
| `business_connection_id` | String (optional) | The connection this message belongs to. **If non-empty, the message belongs to a chat of the business account that is independent from any potential bot chat which might share the same identifier.** |
| `sender_business_bot` | User (optional) | The bot that actually sent the message, present only on outgoing messages sent on behalf of the business account. |

Everything else (`message_id`, `date`, `edit_date`, `chat`, `from`, `text`/`caption`, media, `reply_to_message`) is the
same `Message` shape `normalizeTelegramUpdate` already parses. `from` is the counterparty in incoming messages and
the owner in outgoing ones; the bot's own on-behalf sends re-appear as `business_message` with
`sender_business_bot` set (dedupe concern — see deltas).

Delivery defaults: `allowed_updates` defaults to **all** update types except `chat_member`, `message_reaction`,
`message_reaction_count` — business updates need no explicit allow-listing. Do not pass a restrictive
`allowed_updates` on `setWebhook` without including the business types, or they stop arriving.

### `deleted_business_messages` — `BusinessMessagesDeleted`

Not a message: a tombstone batch `{ business_connection_id, chat, message_ids[] }`. `chat` is "information about a
chat in the business account. **The bot may not have access to the chat or the corresponding user**" — user fields
can be missing, only `chat.id` is reliable. This is a *delete action*, not a hydrate action; today's
`telegramUpdates()` only emits `action: "hydrate"`.

### `business_connection` — `BusinessConnection`

Connection lifecycle: established, edited (rights/chat access changed), or ended. This is a *connection-state*
event, not an inbox message. It must update a business-connections store (id, user, rights, is_enabled) and the
send path's gating (`can_reply` snapshot), not journal into `pending_channel_updates`.

## Send path (`business_connection_id` on sends)

Bot API 7.2 added `business_connection_id` (optional, String) to `sendMessage`, `sendPhoto`, `sendVideo`,
`sendAnimation`, `sendAudio`, `sendDocument`, `sendSticker`, `sendVideoNote`, `sendVoice`, `sendLocation`,
`sendVenue`, `sendContact`, `sendPoll`, `sendDice`, `sendGame`, `sendMediaGroup`, `sendChatAction`,
`pinChatMessage`/`unpinChatMessage`, `editMessageText`/media/caption/reply-markup, plus the business methods
(`readBusinessMessage`, `deleteBusinessMessages`, account-management methods, `postStory`, …).

Hard semantics from the primary docs:

- `can_reply` only authorizes **sending and editing in private chats that had incoming messages in the last
  24 hours**. A reply attempt outside that window fails (community-reported code `BUSINESS_CHAT_INACTIVE` —
  verify during pilot). **Cold outreach from the secretary bot is impossible by design** — this is an
  anti-spam property, not a bug.
- `readBusinessMessage` also requires the chat to have been active in the last 24 hours.
- Operating business bots is subject to the [Bot Developer ToS, section 5.4](https://telegram.org/tos/bot-developers)
  (Telegram Business): the bot must truthfully represent its services; privileges must stay within the scope the
  user granted them, with an opt-out on scope changes.
- There is **no chat-listing method**. The bot learns about a chat only when a `business_message` arrives from it
  — inbox population is strictly event-driven.

Notably absent: there is no `getBusinessChatHistory`. The closest methods act on chats/message ids the bot already
learned via updates. `getUserPersonalChatMessages` (new in 10.0) only reads the *profile personal chat* of a user
(limit 1–20) — it is not a DM-history reader. Net: the secretary bot sees real-time traffic from the connection
moment on; it cannot backfill history.

## Exact normalization deltas in `server/channel-adapters/telegram.mjs`

Additive; no journal-schema migration, no changes to `pending_channel_updates` storage. Estimate: ~150–250 lines
including tests. Each delta is named with its current-code anchor.

1. **`messageKinds` (line ~38):** add `"business_message"` and `"edited_business_message"`.
   `business_connection` and `deleted_business_messages` must *not* join this list — they are not messages.
2. **`updateKind()` routing:** add a sibling classifier, e.g. `businessUpdateKind(update)` returning
   `"business_connection"` or `"deleted_business_messages"`, so the two non-message shapes are routed to their own
   handlers instead of falling through to "unsupported_telegram_update".
3. **Connection namespacing (source-id collision — the one real correctness hazard).**
   Today's `telegramSourceId` digests `[accountId, provider, externalId, chatId:messageId]`. The API docs state
   explicitly that a business chat's identifier may coincide with a bot chat's identifier. Deltas:
   - `channelProfile` must carry an optional `businessConnectionId` (validated opaque string, ≤256 chars).
   - `telegramSourceId` must include it in the digest input whenever present, so a business-chat message can never
     collide with a same-shaped bot-chat message.
   - Keep `message.id` in the current `/^-?\d{1,20}:\d{1,20}$/` chat:message shape (the envelope contract asserts it),
     but note in code comments that uniqueness is scoped per (connection, business_connection_id). Thread stitching
     must also scope by connection: extend `threadId` to `chatId`/`thread` as today, and ensure any thread-grouping
     key includes the connection (the digest does, since `sourceVersion`/`sourceId` are connection-scoped).
4. **`normalizeTelegramUpdate()` business-message branch:**
   - `from`: existing `participant(m.from ?? null, m.sender_chat ?? m.chat)` already handles owner/counterparty.
   - `sender_business_bot` → new envelope-observable: when set, the message is the bot's own on-behalf echo.
     Delta: map it to `from.kind === "bot"` *and* mark the envelope (or a parallel field) as `echo: true` so
     triage and `telegramUpdates` hydrate don't double-import our own sends. The receipts journal maps provider ids
     (`telegram:{chatId}:{messageId}`) from `TelegramTransport`; the echo arrives with `sender_business_bot` and can
     be reconciled by (connection, chat, message_id).
   - `business_connection_id` must be read off the `Message` and attached to the normalized record so later
     dedupe/scope checks don't rely on `update_kind` alone.
5. **`telegramUpdates()` / `bind().changes()`:** handle `deleted_business_messages` by emitting
   `action: "delete"` changes with `messageId`s in the same chat-scoped id space. Importer must apply tombstones
   (mark deleted, never rehydrate). `business_connection` updates bypass the journal and update the
   business-connections store (see 6).
6. **Connection-lifecycle store (new):** a small `business_connections` record (connectionId, bot connection id,
   business_connection_id, user id, rights snapshot, is_enabled, updatedAt) behind the same journal pattern as
   `TelegramLiveStatus`. The send path gates on it: refuse `business_connection_id` sends when `is_enabled` is false
   or `can_reply` is absent — before spending an HTTP attempt.
7. **`telegramSendRequest()` (telegram-transport.mjs):** thread `business_connection_id` from the send envelope's
   target/connection into the `sendMessage` body when the envelope belongs to a business connection. Map
   `BUSINESS_CHAT_INACTIVE` (and any "not enough rights" 403) to a *rejected* journal outcome with a human-readable
   code (`business_chat_inactive`), not a retry — retries will never succeed outside the 24h window.
8. **Optional, same PR or follow-up:** `readBusinessMessage` and `getBusinessConnection` helpers for mark-read and
   rights refresh; `deleteBusinessMessages` only if a retention story needs it. Account-management rights
   (name/bio/photo/username, gifts, Stars, stories) are explicitly out of scope — never request them.
9. **Fixture parity:** extend `RecordedTelegramBot` recordings with business-shaped fixtures so the business
   normalizer paths run under `node --test` without network.
10. **Webhook/`setWebhook`:** no route change; confirm `scripts/telegram-set-webhook.mjs` does not pass a
    restrictive `allowed_updates` (or includes `business_message`, `edited_business_message`,
    `deleted_business_messages`, `business_connection`).

## History, coverage, and privacy — what it does and doesn't buy

- **Buys:** John's personal/business 1-to-1 chats in the unified inbox — the one thing a plain bot can never see.
- **Does not buy:** backfill (no history reader), group coverage with write access beyond what groups already give
  the bot (`can_reply` is private-chat-scoped), cold outreach (24h window), chat enumeration, or group-topic
  awareness.
- **Privacy surface expands:** the journal starts holding the owner's personal DMs, not just bot traffic.
  `pending_channel_updates` stores raw provider payloads; task 43's raw-payload minimization becomes a hard
  requirement before this ships, and task 44's retention window decision directly governs business messages too.
- **One bot per account:** while connected to the room bot, John's account cannot feed a different secretary bot
  (community-reported; verify in pilot).

## Go / no-go criteria

**GO — build the adapter variant — only if ALL of these hold:**

1. [JOHN] Task 12 decision is yes: John explicitly wants his personal Telegram chats in the inbox (privacy call).
2. Bot-API inbound is live-verified first (tasks 3–10 done): rotated token, registered webhook, auto-drain on,
   durable live status. No parallel unknown stacks.
3. [JOHN] Rights are minimal: `can_reply` + `can_read_messages` only. No Stars/gifts/stories/name/bio rights,
   ever, for the room bot.
4. [JOHN] Account actions done: Secretary Mode enabled in BotFather; the owner (John) performs the in-app link
   (Settings → Telegram Business → Chatbots) himself. No credential handoff.
5. Pilot window: one linked account (John's), 24h activity observed, tombstone deletes and 24h-window send
   failures exercised against fixtures *and* one live roundtrip.
6. Raw-payload minimization (task 43) is wired and the retention window (task 44) is set — before personal DMs
   enter the journal.

**NO-GO — do not build — if ANY of these hold:**

- Task 12 is "no" or undecided: Bot-API-only stands; this doc stays the reference.
- The use case needs cold outreach or initiating chats: the 24h-window rule makes it impossible by design.
- The use case needs full history/backfill, group coverage beyond the bot's existing membership, or chat
  enumeration: the API does not offer them.
- The token is not rotated (secret-scanning alert #1): nothing live touches Telegram at all.
- Account-management rights (name/bio/photo/Stars/gifts/stories) are requested: out of scope, decline and
  re-scoped.
- The Bot Developer ToS §5.4 review (truthful representation, scope-change opt-out) is not done.

## Recommendation

**Parked, additive variant later — not now. The standing hypothesis is confirmed.**

Evidence:

- The Premium blocker is gone (Bot API 10.0), so waiting costs nothing and rushing gains nothing.
- The integration is genuinely layerable: whitelist two update kinds, namespace sourceIds by
  `business_connection_id`, handle tombstones and connection-lifecycle events, thread one parameter through the
  send path. Zero journal migration.
- But the delta multiplies *new* semantics (24h-window send failures, echo dedupe, one-bot-per-account,
  personal-DM privacy in the journal) onto a base path that isn't live-verified yet. Sequencing it before tasks
  3–10 lands the complexity on unproven ground.
- The pilot is cheap when the base path is live; the doc above is the complete build spec, so the question need
  not be re-researched.

**Sequence:** finish tasks 3–10 → task 12 decision → if yes, build this as a follow-up PR behind the same
fleet discipline, pilot with John's account, then decide on reply automation (still off until a later tap).

## Sources

- Bot API changelog (Bot API 7.2 2024-03-31; Bot API 10.0 2026-05-08): <https://core.telegram.org/bots/api-changelog>
- Bot API reference (`Update`, `Message`, `BusinessConnection`, `BusinessBotRights`, `BusinessMessagesDeleted`,
  `getBusinessConnection`, `sendMessage`, `readBusinessMessage`, `getUserPersonalChatMessages`):
  <https://core.telegram.org/bots/api>
- Secretary/Business Bots feature guide: <https://core.telegram.org/bots/features?ref=blog.n8n.io>
- Bot Developer ToS §5.4 (Telegram Business): <https://telegram.org/tos/bot-developers>
- Terminology base: `docs/TELEGRAM-INBOUND-DECISION.md` (PR #529)
