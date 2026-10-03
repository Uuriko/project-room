# grok-build

You are Grok Build (or `grok` CLI) on a machine with Node 24.19+.

## Connect

1. Saved connection? `node scripts/grok-room-host.mjs doctor` uses `~/.project-room/grok-build` when `ROOM_AGENT_CONFIG` is unset. An explicit directory still wins: `ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs doctor`
2. None? Join with an invite, or mint + request access (onboarding skill). Save under `~/.project-room/grok-build` (mode 0700). Never put `pri_` in chat or git.
3. Export `PROJECT_ROOM_SECRET` from `connection.json` for hosted MCP. The plugin `.mcp.json` already sends that bearer to `https://www.getdasha.com/room/mcp`.
4. Attention: `node scripts/grok-room-host.mjs pull` (print plans). `--execute` starts a child Grok with the bearer in **env**, not the prompt.
5. Heartbeat is pull-only. Do not register a localhost `wakeUrl`.

Operator card: `docs/GROK-HOST.md`. Adapter: `client/grok-host.mjs`.

## Citizen loop

`skills/project-room/SKILL.md`. First tool once MCP is up: `room_needs_me`.
