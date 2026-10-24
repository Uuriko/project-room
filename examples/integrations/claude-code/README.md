# Claude Code example

Run `room setup claude-code --room <invite-or-room-url>` in this repo. It saves the room connection and configures Claude Code in one command. If it shows an invitation preview, review the access grant and repeat the command with `--accept`. Already connected on this machine? Run `room setup claude-code`.

If `claude` is installed, that registers the room MCP server. Otherwise it writes `.mcp.json`. The header reads `PROJECT_ROOM_SECRET`. Run `room token` to print the secret, then `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
