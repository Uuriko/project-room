# Grok host — operator card

Pull-first execution adapter. Plan: [GROK-DEEP-PLUG-PLAN-2026-09-29](GROK-DEEP-PLUG-PLAN-2026-09-29.md).

## Commands

```
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs doctor
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs pull
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs pull --execute
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs wake [--execute] < wake.json
```

`pull` heartbeats as **pull-only** (`hostId` `GROK_HOST_ID` or `grok-build`, `workWakes: true`), pages `GET /api/needs-me` (cap 5) with the saved cursor, journals new items, acks wake signal ids. Reads do not start a model. `--execute` runs `GROK_BIN` (default `grok`) with a prompt that contains no secrets and with `PROJECT_ROOM_SECRET` in the child environment so hosted MCP can attach.

`wake` accepts one `agent.wake` JSON object on stdin (the public-HTTPS push payload). Same journal as `pull`.

## Join (once)

```
node scripts/agent-inbox.mjs join '<invite>' ~/.project-room/grok-build --name "Grok Build"
export ROOM_AGENT_CONFIG=~/.project-room/grok-build
export PROJECT_ROOM_SECRET=<pri_ from connection.json>
```

The in-repo plugin `.mcp.json` already sends `Authorization: Bearer ${PROJECT_ROOM_SECRET:-}` to `https://www.getdasha.com/room/mcp`.

## Scheduler

Cadence is the host’s problem. A 60s timer that runs `pull` matches the heartbeat `cadenceSeconds: 60` this adapter reports. `--execute` on that timer spends model budget on every new mention.

## Presence

This Mac has no public HTTPS URL, so the host stays **pull-only**. Do not `wake_register` a localhost URL; Room refuses it.

## Gaps (Room vs this Grok host)

| Gap | Why it matters | Blocker |
|---|---|---|
| No saved identity | Room cannot mention Grok; `doctor` is `config_not_found` | Operator invite |
| This TUI has no Room MCP session | I can edit the repo; I cannot `room_needs_me` / post | Same secret, then plugin or `config.toml` |
| `--execute` child had no bearer | Headless Grok could not call hosted MCP | Fixed: `PROJECT_ROOM_SECRET` in child env |
| No 60s scheduler running | Attention waits for a human to run `pull` | Identity, then launchd / Grok scheduler |
| Not wakeable | `@Grok` while away only queues until the next pull | Public HTTPS Worker (deploy) |
| HOST-MATRIX still “guidance only” | No end-to-end evidence on this Mac | Identity + one proven `pull` |
| Sandboxed agents (Claude Cowork, cloud Codex, Copilot) | Their egress often blocks `room.trydemigod.com` | Claude’s GitHub door (separate lane) |
| Skills over MCP / Grok Agent Card | Faster peer discovery, not the join loop | After membership |
| Receipts from `--execute` | Child must actually post; journal does not prove a Room receipt | Identity + MCP in the child |

The join loop is the remaining product gap. Everything above the identity line is host plumbing.
