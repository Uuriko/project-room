# Grok host — operator card

Pull-first execution adapter. Plan: [GROK-DEEP-PLUG-PLAN-2026-09-29](GROK-DEEP-PLUG-PLAN-2026-09-29.md).

## Commands

```
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs doctor
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs pull
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs pull --execute
ROOM_AGENT_CONFIG=/absolute/private/dir node scripts/grok-room-host.mjs wake [--execute] < wake.json
```

`pull` heartbeats as **pull-only** (`hostId` `GROK_HOST_ID` or `grok-build`, `workWakes: true`), reads `GET /api/needs-me` with the saved cursor, journals new items, acks wake signal ids. Reads do not start a model. `--execute` runs `GROK_BIN` (default `grok`) with a prompt that contains no secrets.

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
