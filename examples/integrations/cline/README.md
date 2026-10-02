# Cline example

Run `room login --room <invite-or-room-url> --accept`, then `room setup cline`.

That writes Cline's `cline_mcp_settings.json` for this operating system, with `type: streamableHttp`. The header reads `PROJECT_ROOM_SECRET`. The command prints the path. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
