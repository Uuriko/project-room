# Current Project Room

**This GitHub repository (`Uuriko/project-room`, `main`) is the source of truth.**
Do not continue from a ChatGPT worktree or the stale project-root
`PROJECT-ROOM-CURRENT.md` (that file still describes schema 14).

| | |
| --- | --- |
| Schema | 26 |
| Live app | https://project-room-staging.getdasha.workers.dev |
| Public door | https://www.trydemigod.com/room (`/project-room` alias) |
| GitHub | https://github.com/Uuriko/project-room |
| Durable Object | not reset |

Hosted Worker `project-room-staging` was last published 10 September 2026 as
version `a5f91f99-833c-4ae8-a3a3-3f1920206f52` from GitHub `main` `fce335d`
(Infer good defaults and hide extra chrome). Packaged browser assets include
`src/work-item-session.js` in this tree; live Worker assets update on the next
publish. Durable Object was not reset. Door HTML source is
`deploy/room-entry.mjs`; live `/room` updates with the next demigod-html
publish.

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
| Fixture email (Graph-shaped) | `server/email-*.mjs`, `server/graph-*.mjs` | Local/fixture only. No live mailbox or send |
| Agent connect + MCP | `docs/AGENT-CONNECTION.md`, `scripts/agent-inbox.mjs` | Owner-browser enrollment; not auto-enrolled |
| Instinct / Muse / Grok Build / Grok Bot | `docs/ROOM-ROSTER.md` | Roster + Add-agent presets in this source |
| Usability plan | `docs/USABILITY-PLAN.md` | Chat-first + growth slice; mailbox/auto-enroll gated |
| Chat-first core | [CHAT-FIRST.md](CHAT-FIRST.md) | Humans talk; agents plug into the same room |
| Growth / retention | [GROWTH-PLAN.md](GROWTH-PLAN.md) | Invite-only: talk, @ agents, invite, return |
| Thread composer | [THREAD-COMPOSER.md](THREAD-COMPOSER.md) | In-thread placeholder; Also-@ on Reply |
| Mentions search | [MENTIONS-SEARCH.md](MENTIONS-SEARCH.md) | Mentioned-you filter on existing search |
| Reaction pills | [REACTIONS-VISIBLE.md](REACTIONS-VISIBLE.md) | 👍 ❤️ 🎉 🤔 under every message |
| Agent plug-in | [AGENT-PLUG.md](AGENT-PLUG.md) | Packet / MCP / Node routes in Add agent |
| Agent discovery | [DISCOVERY-FOR-AGENTS.md](DISCOVERY-FOR-AGENTS.md) | `/llms.txt`, `/.well-known/agent.json` |
| Quiet / fast | [QUIET-FAST.md](QUIET-FAST.md) | Infer route, hide chrome, no success toasts |
| Work Item Session | [WORK-ITEM-SESSION.md](WORK-ITEM-SESSION.md) | Title + status + Stop ledger; schema 26 additive; no Slack-with-bots UI |
| Demigod `/room` landing | `deploy/room-entry.mjs` | Live on trydemigod.com; Connect an agent (packet first) after next door publish |
| Research / messaging plans | [`research/`](../research/README.md) | Copied from the Codex ChatGPT project mirror |

## Inbox and email (yesterday’s Codex work)

Account-owned Inbox, selected sharing, excerpt → room work → reviewed private
draft, and fixture Graph reply journals are **in this tree**. Checkpoints:

- [Account-first Inbox](ACCOUNT-FIRST-INBOX-2026-09-08.md)
- [Email import](EMAIL-IMPORT-CHECKPOINT-2026-09-08.md)
- [Email reader](EMAIL-READER-CHECKPOINT-2026-09-08.md)
- [Email excerpts](EMAIL-EXCERPT-CHECKPOINT-2026-09-08.md)
- [Composer review](COMPOSER-REVIEW-2026-09-08.md)

Next gated slice (not done): a real mailbox. See
[research/EMAIL-QUALIFICATION-NEXT.md](../research/EMAIL-QUALIFICATION-NEXT.md).

## Agents

Owner browser session (member key or account key, bound to the owner
account) → People & agents → Add agent. Guest links are not agent
credentials. Guest-agent mint is owner-issued (`ga1.` token, 2h)
([GUEST-AGENT-LINKS.md](GUEST-AGENT-LINKS.md)). Public discovery:
`/llms.txt` and `/.well-known/agent.json`. `?account=1` is Inbox without joining a room.
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
