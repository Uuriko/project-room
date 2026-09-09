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

Hosted Worker `project-room-staging` was last published 9 September 2026 as
version `90ba6c3f-0283-4a03-961e-295561fb2c4f` from GitHub `main` `b082970`
(easier login). 25 live assets match this checkout. Durable Object was not
reset. Door copy on trydemigod.com `/room` matches this source.

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
| Instinct / Muse / Grok Build / Grok Bot | `docs/ROOM-ROSTER.md` | Roster + Connect-agent presets in this source |
| Demigod `/room` landing | `deploy/room-entry.mjs` | Live on trydemigod.com |
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
account) → People & agents → Connect agent. Guest links are not agent
credentials. `?account=1` is Inbox without joining a room.
[ROOM-ROSTER.md](ROOM-ROSTER.md) is the Instinct / Muse / Grok Build / Grok
Bot map.

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
