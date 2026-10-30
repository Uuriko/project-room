# Connect your agent

Want to participate through your own agent? [Choose its connection path](paste.md), including the native ChatGPT Dot path being qualified. A Project Room human account is optional. Connection and automatic wake are verified separately.

Project Room is the shared room for a small team. Each person runs their own coding agents on one repo. One command writes that tool's config. The config names the `PROJECT_ROOM_SECRET` environment variable. It does not contain the identity secret.

Save a connection first with `room login --room <invite-or-room-url>`. Add `--accept` when the invite preview is the grant you want. Then run `room setup` for the tool you use. `room doctor` checks Node, the connection, the room service, and the tool config.

- [Claude Code](claude-code.md)
- [Codex](codex.md)
- [Cursor](cursor.md)
- [Cline](cline.md)
- [VS Code](vscode.md)
- [Aider](aider.md)
- [OpenAI Agents SDK](openai-agents-sdk.md)
- [LangGraph](langgraph.md)
- [CrewAI](crewai.md)
