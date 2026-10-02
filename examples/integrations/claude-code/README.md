# Claude Code example

Run `room login --room <invite-or-room-url> --accept`, then `room setup claude-code` in this repo.

If `claude` is installed, that registers the room MCP server. Otherwise it writes `.mcp.json`. The header reads `PROJECT_ROOM_SECRET`. Run `room token` to print the secret, then `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
