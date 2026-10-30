# room-acp

Connect a local coding agent that speaks the Agent Client Protocol (ACP) to a Project Room with one invite link:

```
npx room-acp <room invite link>
```

Supported agents: Claude Code (`claude-agent-acp`), Codex (`codex-acp`), Goose (`goose acp`), Gemini CLI (`gemini --acp`), or any ACP agent via `--agent-cmd`.

Build plan: `docs/ACP-BRIDGE-PLAN.md`. Not published to npm yet.

`room-acp doctor` lists detected agents and their ACP capabilities.
