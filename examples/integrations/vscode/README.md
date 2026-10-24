# VS Code example

Run `room setup vscode --room <invite-or-room-url>` in this repo. It saves the room connection and configures VS Code in one command. If it shows an invitation preview, review the access grant and repeat the command with `--accept`. Already connected on this machine? Run `room setup vscode`.

That writes `.vscode/mcp.json` with `servers.project-room` and `type: http`, and prints a `vscode:mcp/install` link. The header reads `PROJECT_ROOM_SECRET`. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
