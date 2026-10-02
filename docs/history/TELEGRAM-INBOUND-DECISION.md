# Telegram inbound architecture decision

**Status:** decided (2026-09-17) — **ship Bot API webhook now; Business API only later if John wants personal-chat coverage.** MTProto/userbots are ruled out.

This answers John's open question: *"Should we build inbound Telegram now via the bot, or wait for the developer thing?"* — build now, on the Bot API, via webhook. Nothing in "the developer thing" blocks that path.

## What "the developer thing" plausibly means

1. **Telegram Business API ("secretary bots")** — the most likely referent. Since 2024–25 Telegram lets a business link a bot to its personal/business account; the bot then receives `business_message` / `edited_business_message` / `deleted_business_messages` updates and can reply "on behalf of" the account via `business_connection_id`. Bot API 10.0 (May 2026) widened this to non-Premium accounts. This is "fully having it" only in the sense of **personal-account coverage**: it puts John's own Telegram DMs into the inbox, which a plain bot can never see. Evaluated further in the spike doc (task 2).
2. **MTProto client API / TDLib (userbot)** — a full client acting as the user account. Reads everything the account can read, but requires `api_id`/`api_hash` plus a phone-number session login, session-file custody, and lives in Telegram's automated-personal-account grey zone (ban risk). **Ruled out** — see task 13.
3. **Newer Bot API surface** (`sendMessageDraft`, drafts, guest queries, webhook improvements) — incremental, not a different thing.

## Comparison

| Dimension | Bot API webhook (ship now) | Bot API getUpdates long-poll | Business API (later) | MTProto userbot |
|---|---|---|---|---|
| Latency | Sub-second push from Telegram to our endpoint | 1–2 s per long-poll cycle; bounded by poll interval + timeout | Same as webhook (also push) | Real-time |
| Setup friction | Token + webhook secret + one `setWebhook` call; bot must already exist | Token only; no inbound URL needed — works behind NAT / local dev | Bot API setup **plus** business-account linking in the Telegram app, Premium history for full history access | `api_id`/`api_hash`, phone-number session login, session files |
| Token custody | One Bearer-style bot token in Worker secrets; redaction already in `server/channel-adapters/telegram-config.mjs` | Same | Same token **plus** a `business_connection_id` binding to John's account — must be stored alongside the connection | Full account session: if leaked, an attacker *is* the account. Catastrophic custody risk |
| Coverage | Bot DMs, groups the bot is added to, channels where the bot is admin | Identical | Identical **plus** John's personal/business chats via `business_message` updates | Everything the account sees |
| Journal schema delta | **Zero** — `pending_channel_updates` + the envelope `sourceId`/`sourceVersion` already handle it | Zero | Small, additive: `businessConnectionId` on the connection + send path | Large — a different protocol shape entirely |

## What the repo already has (verified 2026-09-17)

- `normalizeTelegramUpdate` in `server/channel-adapters/telegram.mjs` — raw update → normalized envelope. `business_message` updates will flow through this same normalizer later with a small adapter variant (task 2 lists the deltas).
- `ChannelWebhookInbox` in `server/channel-import.mjs` — secret-verified via the `x-telegram-bot-api-secret-token` header, deduplicated by `update_id`, journaled to `pending_channel_updates`.
- Boot-wired webhook route `POST /api/inbox/webhooks/{connectionId}` in `server/http.mjs` (route map + handler with per-address/per-connection rate limits).
- Send path from PR #509: `POST /api/inbox/channel-sends` → `TelegramTransport`.

The remaining gaps are **operational, not architectural** — they are tasks, not reasons to wait:

| Gap | Task | Owner |
|---|---|---|
| The git-history bot token is burned (secret-scanning alert #1); nothing live touches Telegram until rotation | #3 | [JOHN] — revoke/mint via BotFather; new token goes to Grok Bot for Worker secrets, never chat/email |
| Confirm bot identity: username, display name, about text, BotFather group-privacy mode | #4 | [JOHN] |
| Worker secrets + webhook registration (`wrangler secret put TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET`, then `setWebhook` via `scripts/telegram-set-webhook.mjs`) | #5 | [JOHN] / Grok Bot |
| Approve flipping live outbound on (first real `sendMessage` is an external send) | #6 | [JOHN] |
| Approve group/channel membership list + daily send-rate cap | #7 | [JOHN] |
| Auto-drain of `pending_channel_updates` (today `syncTelegramConnection` drains on demand) | #9 | [AUTO] |
| Durable `TelegramLiveStatus` (currently an in-memory map) | #10 | [AUTO] |
| Local/dev path for webhook-unreachable environments: `LiveTelegramPoller` (getUpdates driver behind the bound-adapter interface; fixture stays default) | #8 | [AUTO] |

## Why webhook-first, not getUpdates

- **Latency:** push beats poll. Inbound Telegram is a notification surface; a 1–2 s poll cycle is acceptable, but webhook is strictly better and Telegram offers it natively.
- **Setup friction is one-time:** `setWebhook` + secret agreement is a single registration step per bot. The webhook-secret verification path already exists in the server.
- **Poll has a role:** local development and environments where the public endpoint is unreachable. Hence task 8 — a poll driver behind the same bound-adapter interface (`changes`/`hydrate`/`submit`/`lookup`) — not the primary path.

## Why not wait for Business API

- Business API adds **only one thing**: John's personal/business chats, via `business_message` updates and replies through `business_connection_id`. Everything a plain bot can do already works without it.
- It is **layerable**: a later adapter variant needs only a `businessConnectionId` binding on the connection and the corresponding send-path threading. No journal-schema migration, no re-architecture.
- Whether John wants his personal DMs in the inbox at all is a product/privacy decision — his call (task 12), not a build blocker.

## Why not MTProto

Ruled out in full by task 13's memo; the short version: automated personal accounts sit in Telegram's ToS grey zone (ban history), session-file custody is a full-account compromise on leak, and it is a second, heavier protocol to maintain. The Bot API covers the room's actual needs.

## Journal-schema needs

**Zero changes for Bot API inbound.** `pending_channel_updates` stores the raw provider payload keyed by `update_id` dedupe; the envelope's existing `sourceId`/`sourceVersion` fields carry channel provenance. Business API inbound later needs only one additive field: `businessConnectionId` on the connection (and threading through the send path).

## Decision

**Ship Bot API webhook now.** Build the operational gaps (tasks 3–10) in priority order; keep the getUpdates poller as the dev fallback (task 8); park Business API behind John's personal-coverage decision (task 12) with the spike doc (task 2) defining the exact normalization deltas so the question doesn't recur.

*Companion docs: task 2 (Business API spike), task 13 (MTProto non-option memo). Related operational tasks: 3–12, 45–49.*
