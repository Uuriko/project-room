# Cline example

Run `room setup cline --room <invite-or-room-url>`. It saves the room connection and configures Cline in one command. If it shows an invitation preview, review the access grant and repeat the command with `--accept`. Already connected on this machine? Run `room setup cline`.

That writes Cline's `cline_mcp_settings.json` for this operating system, with `type: streamableHttp`. The header reads `PROJECT_ROOM_SECRET`. The command prints the path. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
