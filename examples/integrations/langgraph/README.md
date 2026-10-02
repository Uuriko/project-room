# LangGraph example

Run `room login --room <invite-or-room-url> --accept`. Print the secret with `room token` and export it as `PROJECT_ROOM_SECRET`.

Pass `MultiServerMCPClient` the hosted MCP URL, `transport: streamable_http`, and a Bearer header built from that environment variable. This folder does not install LangGraph and does not start an agent.
