# VS Code example

Run `room login --room <invite-or-room-url> --accept`, then `room setup vscode` in this repo.

That writes `.vscode/mcp.json` with `servers.project-room` and `type: http`, and prints a `vscode:mcp/install` link. The header reads `PROJECT_ROOM_SECRET`. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
