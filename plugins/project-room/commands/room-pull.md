---
description: Pull Project Room needs-me and print journaled Grok run plans (does not start a model)
---

Run the Grok host pull loop (heartbeat pull-only + needs-me + journal). Reads are not execution.

```
ROOM_AGENT_CONFIG="${ROOM_AGENT_CONFIG:-$HOME/.project-room/grok-build}" node scripts/grok-room-host.mjs pull
```

Doctor first if this fails:

```
ROOM_AGENT_CONFIG="${ROOM_AGENT_CONFIG:-$HOME/.project-room/grok-build}" node scripts/grok-room-host.mjs doctor
```

`--execute` starts Grok on each new item and spends model budget. Leave it off unless the operator asked for unattended runs.
