# Current Project Room

**This GitHub repository (`Uuriko/project-room`, `main`) is the source of truth.**
Do not continue from a ChatGPT worktree or the stale project-root
`PROJECT-ROOM-CURRENT.md` (that file still describes schema 14).

| | |
| --- | --- |
| Schema | 36 |
| Live app | https://room.trydemigod.com |
| Public door | https://room.trydemigod.com |
| Public door (getdasha) | https://www.getdasha.com/room |
| GitHub | https://github.com/Uuriko/project-room |
| Durable Object | not reset |

This is the single deployment record. What the repo can prove: the Worker
source is `cloudflare/` (`wrangler.jsonc`, `room.mjs`), the door HTML source
is `deploy/room-entry.mjs`, and the CI `cloudflare` job runs the Worker
runtime checks plus `wrangler deploy --dry-run` on every PR. Procedure:
[ROOM-DEPLOYMENT.md](ROOM-DEPLOYMENT.md) is the deploy runbook: stage, verify,
promote the same checkout, probe, and roll back. Canonical Worker first, then
the entry Worker. Durable Object not reset. Gmail stays disabled.

| | |
| --- | --- |
| Deployed | 2026-10-01 ~17:45 PT |
| Source | `60df170cb58b79fd1714ca5dfe3ef51da939b29d` (`main` `60df170c`) |
| `project-room` (canonical, `env.production`) | version `86fc2647-4f88-482d-af43-3e8a3172828e` |
| `project-room-staging` (public entry; script name is historical) | version `4ad2f09f-35ba-4906-856c-fced4dbbcafc` |
| Rollback | `project-room` `5a1ea853-afad-43ed-a613-39d1cf239a9e`; `project-room-staging` `2ebb4ed9-05e3-4f47-bfd1-c9db8fd5b4b0` |

Earlier records stay historical: 10 September 2026, version
`a5f91f99-833c-4ae8-a3a3-3f1920206f52` from `main` `fce335d`, and the
7 September staging acceptance in `cloudflare/README.md` (app `fb90a70`,
Worker `901be347…`).

## GitHub About (John, in the UI)

There is no repository-settings write from this session. In GitHub →
Settings → General:

- **Description:** Shared room for people and agents. Invite-only.
- **Website:** https://room.trydemigod.com

Leave the repo public. Do not add tokens, keys, or DIE copy.

## How to test

Follow [HOW-TO-TEST.md](history/HOW-TO-TEST.md): open https://room.trydemigod.com,
then **Open Project Room**, then paste a room key (or choose Account key, or an
invitation). Footer **Project Room** on the Demigod home page is the same door.

## What is in this repo

| Area | Where | Status |
| --- | --- | --- |
| Room chat, work, catch-up | `src/`, `server/` | Live on the isolated Worker |
| Private Inbox / account home | `src/inbox-*.js`, `server/inbox*.mjs` | In source and on the Worker; open `/?account=1` |
| Fixture email (Graph-shaped) | `server/email-*.mjs`, `server/graph-*.mjs`, `server/email-routing-inbound.mjs` | Local/fixture only. No live mailbox or send; the Email Routing inbound parser (#144) is in source but the Worker `email()` handler is not mounted ([EMAIL-ROUTING.md](history/EMAIL-ROUTING.md)) |
| Unified inbox / fixture Telegram (Bot API-shaped) | `server/channel-*.mjs`, `server/channel-adapters/`, [UNIFIED-INBOX.md](history/UNIFIED-INBOX.md) | Fixture by default: recorded updates; webhook updates journal durably in `pending_channel_updates` (additive at schema 27). Telegram inbound (webhook route, `scripts/telegram-set-webhook.mjs`) and outbound (`sendMessage` via `/api/inbox/channel-sends`) go live once the operator sets `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` ([UNIFIED-INBOX.md §Live Telegram](history/UNIFIED-INBOX.md#live-telegram-zero-spend)). Email stays fixture-only |
| Agent connect + MCP | `docs/SWARM-PLUG-IN.md`, `scripts/agent-inbox.mjs` | Owner-browser enrollment; not auto-enrolled |
| Instinct / Muse / Grok Build / Grok Bot | `docs/ROOM-ROSTER.md` | Roster + Add-agent presets in this source |
| Usability plan | `docs/USABILITY-PLAN.md` | Chat-first + growth slice; mailbox/auto-enroll gated |
| Chat-first core | [CHAT-FIRST.md](history/CHAT-FIRST.md) | Humans talk; agents plug into the same room |
| Growth / retention | [GROWTH-PLAN.md](history/GROWTH-PLAN.md) | Invite-only: talk, @ agents, invite, return |
| Thread composer | [THREAD-COMPOSER.md](history/THREAD-COMPOSER.md) | In-thread placeholder; Also-@ on Reply |
| Mentions search | [MENTIONS-SEARCH.md](history/MENTIONS-SEARCH.md) | Mentioned-you filter on existing search |
| Reaction pills | [REACTIONS-VISIBLE.md](history/REACTIONS-VISIBLE.md) | 👍 ❤️ 🎉 🤔 under every message |
| Agent plug-in | [SWARM-PLUG-IN.md](SWARM-PLUG-IN.md) | Packet / MCP / Node routes in Add agent |
| Agent discovery | [SWARM-PLUG-IN.md](SWARM-PLUG-IN.md) | `/llms.txt`, `/llms-full.txt`, `/.well-known/agent.json`, kits catalog `/kits.txt` (plus `/room/*` aliases) |
| Kits catalog | [ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) | `/room/kits` — catalog + install stub; not an App Store |
| Quiet / fast | [QUIET-FAST.md](history/QUIET-FAST.md) | Infer route, hide chrome, no success toasts |
| Work Item Session | [WORK-ITEM-SESSION.md](history/WORK-ITEM-SESSION.md) | Title + status + Stop ledger; schema 26 additive; no Slack-with-bots UI |
| Room lifecycle (issue #6 A2) | `server/room-lifecycle.mjs`, `src/events.js`, Rooms panel in `src/app.js` | Schema 34 adds `rooms.archived_at`. `POST /api/account-rooms` creates a room for an account that administers membership somewhere; owner-only `room.archived` makes a room read-only (reads, streams and export continue, every write is 409 `room_archived`); a member leaves with `member.access_changed` on themself; the switcher lists archived rooms as read-only entries. Personal/organization is a `room.kind` badge until D1 |
| Demigod `/room` landing | `deploy/room-entry.mjs` | Live on trydemigod.com; Connect P1 + private invite (no lobby publish) after next door publish |
| getdasha `/room` door | `deploy/room-entry.mjs` `PUBLIC_ROOM_DOOR_HTML` | Worker serves HTML at `/room`; packets stay at `/room/llms.txt`; Connect invite stays private by default |
| Research / messaging plans | not in this tree | The research notes were removed from the tree |

## Inbox and email (yesterday’s Codex work)

Account-owned Inbox, selected sharing, excerpt → room work → reviewed private
draft, and fixture Graph reply journals are **in this tree**. Checkpoints:

- [Account-first Inbox](history/ACCOUNT-FIRST-INBOX-2026-09-08.md)
- [Email import](history/EMAIL-IMPORT-CHECKPOINT-2026-09-08.md)
- [Email reader](history/EMAIL-READER-CHECKPOINT-2026-09-08.md)
- [Email excerpts](history/EMAIL-EXCERPT-CHECKPOINT-2026-09-08.md)
- [Composer review](history/COMPOSER-REVIEW-2026-09-08.md)
- [Unified inbox](history/UNIFIED-INBOX.md): one connection record and adapter interface; Telegram joins email as a fixture channel

A real mailbox is not part of the current docs.

## Agents

Owner browser session (member key or account key, bound to the owner
account) → People & agents → Add agent. Guest links are not agent
credentials. Guest-agent mint is owner-issued (`ga1.` token, 2h)
([GUEST-AGENT-LINKS.md](GUEST-AGENT-LINKS.md)). Public discovery:
`/llms.txt`, `/llms-full.txt` and `/.well-known/agent.json`. `?account=1` is Inbox without joining a room.
[ROOM-ROSTER.md](ROOM-ROSTER.md) is the Instinct / Muse / Grok Build / Grok
Bot map. Product lock: [AGENTS-WANT.md](AGENTS-WANT.md). Work Items carry an
additive [session](history/WORK-ITEM-SESSION.md) (`queued`…`failed`, Stop) so agents
see a ledger, not a chat thread. Writer stays 26.

Room Trust is one owner header toggle (`room.trust_set`, field `enabled`). It defaults **on**: members may assign Work Items and wake agents across owners. Turning it **off** is the kill-switch for that cross-owner assign and wake only. Same-owner work stays open. It is not Bond, not a scopes picker, and not a per-task confirm. The header control appears for the owner when the room has more than one member-owner.

## Historical merge notes

PR #23 is in history at `63c3b712`. #8, #12, #13, #14 and #20 are included by
ancestry. #3–#5 were reconciled; see [UNIFICATION-2026-09-07.md](history/UNIFICATION-2026-09-07.md).
#9’s harness and #16–#18 still need deliberate adaptation. #24 is independent
conformance. #25/#26 operator API-key work is deferred.

The unlisted Demigod entry is `deploy/room-entry.mjs` (GET/HEAD `/room` and
`/project-room`, noindex, one link to the isolated origin). A small footer link
to `/room` is live on Demigod home/weekly/contact/hardware. It is not in the
main nav.

Remaining live gates: a real invited participant join/send/return on the current
Worker, physical-phone evidence, provider restore, and a real mailbox only after
separate authorization. Do not reset the Durable Object as rollback.
