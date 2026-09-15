# Current Project Room

**This GitHub repository (`Uuriko/project-room`, `main`) is the source of truth.**
Do not continue from a ChatGPT worktree or the stale project-root
`PROJECT-ROOM-CURRENT.md` (that file still describes schema 14).

| | |
| --- | --- |
| Schema | 35 |
| Live app | https://project-room-staging.getdasha.workers.dev |
| Public door | https://www.trydemigod.com/room (`/project-room` alias) |
| Public door (getdasha) | https://www.getdasha.com/room · https://lobby.getdasha.com/room |
| GitHub | https://github.com/Uuriko/project-room |
| Durable Object | not reset |

This is the single deployment record. What the repo can prove: the Worker
source is `cloudflare/` (`wrangler.jsonc`, `room.mjs`), the door HTML source
is `deploy/room-entry.mjs`, and the CI `cloudflare` job runs the Worker
runtime checks plus `wrangler deploy --dry-run` on every PR. Nothing in the repo records a real
publish; the live version and its source commit are owner-to-confirm from the
Cloudflare dashboard. Last owner-reported publish: 10 September 2026, version
`a5f91f99-833c-4ae8-a3a3-3f1920206f52` from `main` `fce335d` (Infer good
defaults and hide extra chrome); Durable Object not reset. (The older
`cloudflare/README.md` status paragraph — app `fb90a70`, Worker `901be347…`,
7 September — is the previous acceptance record, superseded here.) Every
merge since `fce335d` (including the schema 28 store) is in this tree but not
on the Worker until the next publish; live `/room` updates with the next
demigod-html publish.

## GitHub About (John, in the UI)

There is no repository-settings write from this session. In GitHub →
Settings → General:

- **Description:** Shared room for people and agents. Invite-only.
- **Website:** https://www.trydemigod.com/room

Leave the repo public. Do not add tokens, keys, or DIE copy.

## How to test

Follow [HOW-TO-TEST.md](HOW-TO-TEST.md): open https://www.trydemigod.com/room,
then **Open Project Room**, then paste a room key (or choose Account key, or an
invitation). Footer **Project Room** on the Demigod home page is the same door.

## What is in this repo

| Area | Where | Status |
| --- | --- | --- |
| Room chat, work, catch-up | `src/`, `server/` | Live on the isolated Worker |
| Private Inbox / account home | `src/inbox-*.js`, `server/inbox*.mjs` | In source and on the Worker; open `/?account=1` |
| Fixture email (Graph-shaped) | `server/email-*.mjs`, `server/graph-*.mjs`, `server/email-routing-inbound.mjs` | Local/fixture only. No live mailbox or send; the Email Routing inbound parser (#144) is in source but the Worker `email()` handler is not mounted ([EMAIL-ROUTING.md](EMAIL-ROUTING.md)) |
| Unified inbox / fixture Telegram (Bot API-shaped) | `server/channel-*.mjs`, `server/channel-adapters/`, [UNIFIED-INBOX.md](UNIFIED-INBOX.md) | Fixture by default: recorded updates; webhook updates journal durably in `pending_channel_updates` (additive at schema 27). Telegram inbound (webhook route, `scripts/telegram-set-webhook.mjs`) and outbound (`sendMessage` via `/api/inbox/channel-sends`) go live once the operator sets `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` ([UNIFIED-INBOX.md §Live Telegram](UNIFIED-INBOX.md#live-telegram-zero-spend)). Email stays fixture-only |
| Agent connect + MCP | `docs/AGENT-CONNECTION.md`, `scripts/agent-inbox.mjs` | Owner-browser enrollment; not auto-enrolled |
| Instinct / Muse / Grok Build / Grok Bot | `docs/ROOM-ROSTER.md` | Roster + Add-agent presets in this source |
| Usability plan | `docs/USABILITY-PLAN.md` | Chat-first + growth slice; mailbox/auto-enroll gated |
| Chat-first core | [CHAT-FIRST.md](CHAT-FIRST.md) | Humans talk; agents plug into the same room |
| Growth / retention | [GROWTH-PLAN.md](GROWTH-PLAN.md) | Invite-only: talk, @ agents, invite, return |
| Thread composer | [THREAD-COMPOSER.md](THREAD-COMPOSER.md) | In-thread placeholder; Also-@ on Reply |
| Mentions search | [MENTIONS-SEARCH.md](MENTIONS-SEARCH.md) | Mentioned-you filter on existing search |
| Reaction pills | [REACTIONS-VISIBLE.md](REACTIONS-VISIBLE.md) | 👍 ❤️ 🎉 🤔 under every message |
| Agent plug-in | [AGENT-PLUG.md](AGENT-PLUG.md) | Packet / MCP / Node routes in Add agent |
| Agent discovery | [DISCOVERY-FOR-AGENTS.md](DISCOVERY-FOR-AGENTS.md) | `/llms.txt`, `/llms-full.txt`, `/.well-known/agent.json`, kits catalog `/kits.txt` (plus `/room/*` aliases) |
| Kits catalog | [ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) | `/room/kits` — catalog + install stub; not an App Store |
| Quiet / fast | [QUIET-FAST.md](QUIET-FAST.md) | Infer route, hide chrome, no success toasts |
| Work Item Session | [WORK-ITEM-SESSION.md](WORK-ITEM-SESSION.md) | Title + status + Stop ledger; schema 26 additive; no Slack-with-bots UI |
| Room lifecycle (issue #6 A2) | `server/room-lifecycle.mjs`, `src/events.js`, Rooms panel in `src/app.js` | Schema 34 adds `rooms.archived_at`. `POST /api/account-rooms` creates a room for an account that administers membership somewhere; owner-only `room.archived` makes a room read-only (reads, streams and export continue, every write is 409 `room_archived`); a member leaves with `member.access_changed` on themself; the switcher lists archived rooms as read-only entries. Personal/organization is a `room.kind` badge until D1 |
| Message redaction (issue #6 D6) | `server/message-redaction.mjs`, `src/events.js`, [EXPORT-RETENTION-DELETION.md](EXPORT-RETENTION-DELETION.md) | Schema 35 adds `message_redactions`. `message.redacted` (owner or author) rewrites the target's post and edits in the log to a SHA-256 record; projection, search, both exports, import and a restored backup reproduce the redaction, never the text; verified on every open. Deletion stays a tombstone that keeps history |
| Demigod `/room` landing | `deploy/room-entry.mjs` | Live on trydemigod.com; Connect P1 + private invite (no lobby publish) after next door publish |
| getdasha `/room` door | `deploy/room-entry.mjs` `PUBLIC_ROOM_DOOR_HTML` | Worker serves HTML at `/room`; packets stay at `/room/llms.txt`; Connect invite stays private by default |
| Research / messaging plans | [`research/`](../research/README.md) | Copied from the Codex ChatGPT project mirror |

## Inbox and email (yesterday’s Codex work)

Account-owned Inbox, selected sharing, excerpt → room work → reviewed private
draft, and fixture Graph reply journals are **in this tree**. Checkpoints:

- [Account-first Inbox](ACCOUNT-FIRST-INBOX-2026-09-08.md)
- [Email import](EMAIL-IMPORT-CHECKPOINT-2026-09-08.md)
- [Email reader](EMAIL-READER-CHECKPOINT-2026-09-08.md)
- [Email excerpts](EMAIL-EXCERPT-CHECKPOINT-2026-09-08.md)
- [Composer review](COMPOSER-REVIEW-2026-09-08.md)
- [Unified inbox](UNIFIED-INBOX.md): one connection record and adapter interface; Telegram joins email as a fixture channel

Next gated slice (not done): a real mailbox. See
[research/EMAIL-QUALIFICATION-NEXT.md](../research/EMAIL-QUALIFICATION-NEXT.md).

## Agents

Owner browser session (member key or account key, bound to the owner
account) → People & agents → Add agent. Guest links are not agent
credentials. Guest-agent mint is owner-issued (`ga1.` token, 2h)
([GUEST-AGENT-LINKS.md](GUEST-AGENT-LINKS.md)). Public discovery:
`/llms.txt`, `/llms-full.txt` and `/.well-known/agent.json`. `?account=1` is Inbox without joining a room.
[ROOM-ROSTER.md](ROOM-ROSTER.md) is the Instinct / Muse / Grok Build / Grok
Bot map. Product lock: [AGENTS-WANT.md](AGENTS-WANT.md). Work Items carry an
additive [session](WORK-ITEM-SESSION.md) (`queued`…`failed`, Stop) so agents
see a ledger, not a chat thread. Writer stays 26.

## Historical merge notes

PR #23 is in history at `63c3b712`. #8, #12, #13, #14 and #20 are included by
ancestry. #3–#5 were reconciled; see [UNIFICATION-2026-09-07.md](UNIFICATION-2026-09-07.md).
#9’s harness and #16–#18 still need deliberate adaptation. #24 is independent
conformance. #25/#26 operator API-key work is deferred.

The unlisted Demigod entry is `deploy/room-entry.mjs` (GET/HEAD `/room` and
`/project-room`, noindex, one link to the isolated origin). A small footer link
to `/room` is live on Demigod home/weekly/contact/hardware. It is not in the
main nav.

Remaining live gates: a real invited participant join/send/return on the current
Worker, physical-phone evidence, provider restore, and a real mailbox only after
separate authorization. Do not reset the Durable Object as rollback.
