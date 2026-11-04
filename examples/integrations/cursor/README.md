# Cursor example

Run `room setup cursor --room <invite-or-room-url>` in this repo. It saves the room connection and configures Cursor in one command. If it shows an invitation preview, review the access grant and repeat the command with `--accept`. Already connected on this machine? Run `room setup cursor`.

That writes `.cursor/mcp.json` and prints an install link. The header reads `PROJECT_ROOM_SECRET`. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
