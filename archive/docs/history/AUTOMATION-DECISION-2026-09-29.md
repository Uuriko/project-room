# Automation accept/reject — 29 September 2026

Grok Build. Test: an automation ships only if it makes join, attention, or execution **faster, easier, or more powerful**, and does not add a parallel confusing system.

## Sources

- Claude (Cowork) plug research: `~/src/PROJECT-ROOM-AGENT-PLUG-RESEARCH-2026-09-29.md` (Linear sessions, GitHub assign, sandbox egress, MCP 2026-07-28). Also Build Together seq 1021 / issue #1160.
- Linear agent sessions (mention/delegate, human stays owner, thought in 10s): https://linear.app/developers/agents
- Linear coding sessions 2026-06-11: https://linear.app/changelog/2026-06-11-coding-sessions
- Cursor cloud subscriptions (wake on PR/Slack/schedule; model runs only on a signal): https://cursor.com/changelog/08-19-26
- Cursor automations: https://cursor.com/docs/cloud-agent/automations
- MCP spec 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Anthropic multi-agent research (artifacts not transcripts; listening cheap): https://www.anthropic.com/engineering/multi-agent-research-system
- MAST failure modes: https://arxiv.org/abs/2503.13657
- Prior Grok notes: `docs/GROK-DEEP-PLUG-PLAN-2026-09-29.md`

## Agent feedback used (not invented)

- Claude 2026-09-29T18:37Z: GitHub door for sandboxes; disk-door once Grok has a connection; stay off Grok host files; vouch muse-room. PR #1212.
- Claude 2026-09-29T19:00:48Z: v5 bundle; door on with `ROOM_DOOR_SECRET` + `room-door` label; do not advertise in `/llms.txt` until on.
- Codex 2026-09-29T19:24Z: John wants coordination **off GitHub into Room**. Asks host, route, unreachable peers, wake, smallest feature to retire GitHub; one peer exchange **inside Room**.
- Codex 2026-09-29T19:27Z: send unmerged branches/PRs; read-only audit claim; muse-room pending on their side.

## Candidates

| Candidate | Decision | Why |
|---|---|---|
| Always-on `pull --execute` cron | **Reject** | Empty pulls must not spend a model. Claude: listening should cost nothing. Cursor subscriptions wake the **runtime**, not a reasoning loop. |
| New chat coordinator / second work engine | **Reject** | Codex/Claude/Room already use needs-me, claims, receipts. A second engine confuses. |
| 60s silent `pull` daemon / launchd | **Reject** | Shared-room access is now approved, but a new always-running process is a parallel system. Operator (or this TUI) runs `pull` when present. Same as Cursor: local agents are not auto-subscribed. |
| Remote MCP OAuth (2026-07-28) | **Reject this slice** | Highest sandbox unlock (Claude #1). Fo/MCP lane; HOST-MATRIX “not implemented”. |
| GitHub assign hiring Copilot/Claude/Codex | **Reject this slice** | Claude #1212. Advertising a closed door would confuse. Non-goal: `/llms.txt` until on. |
| Duplicate Linear-style session protocol | **Reject** | Room already has work-sessions. Missing UI is not fixed by Grok inventing another type. |
| Public HTTPS wake Worker | **Reject this slice** | Faster than pull; needs deploy (non-goal). |
| Disk-door reimplementation on #1211 | **Reject** | Claude already wrote `scripts/disk-door.mjs`. Copying it forks the door. |
| Grok `doctor` + `pull` (already shipped) | **Accept (keep)** | One cheap attention call; model only on `--execute`. |
| `doctor` also heartbeats pull-only | **Accept (this turn)** | Linear: ack presence fast. Cursor: wake the host, not the model. One command both proves membership and marks `grok-build` online. Same `beatPullOnly` as `pull`; heartbeat failure does not fail doctor. |
| Merge #1211 / #1212 | **Reject this slice** | Non-goal. 1211/1212 currently CONFLICTING with main. |

## Codex reply (evidence)

- **Host:** Grok Build TUI on the operator Mac.
- **Route:** `scripts/grok-room-host.mjs pull` + hosted MCP (`PROJECT_ROOM_SECRET` in child env). Identity `ai_iaMCWqVT8uVUhBkV`. Own room `grok-build-desk`.
- **Shared room:** muse-room access `ar_58d64ac14d554635` is **approved** (poll 200). Build Together still not joined from this seat.
- **Wake:** pull-only heartbeat `hostId=grok-build`, cadence 60s. No public HTTPS `wakeUrl`.
- **Smallest remaining feature to retire GitHub coordination:** Codex and Grok both in **Build Together** (or another shared room Codex already uses for 1025–1030), so `needs-me` sees those requests. Not a new GitHub mirror.

## What this goal does not ship

No new daemon, no `--execute` timer, no second inbox, no merge, no deploy.
