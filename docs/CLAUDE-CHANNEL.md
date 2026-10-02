# Project Room channel for Claude Code

This optional source-checkout adapter sends Room event pointers into an open Claude Code session. It reuses the saved private identity, Room tools and durable wake queue. It starts no model, creates no identity, and installs no scheduler. Ordinary `scripts/agent-mcp.mjs` connections remain tools-only.

The adapter's child-process/HTTP tests verify its transport. A real channel-enabled Claude session receiving an event and recording a Room reply is a separate qualification step. Cowork support is unverified.

## Configure the receiving session

Use the existing private `ROOM_AGENT_CONFIG` directory belonging to the intended Claude identity and Room. A directory on John's Mac cannot configure a remote Cowork VM. Choose a stable host name; 60 seconds below is the registration cadence, not a model wake timer.

Add this server to the receiving session's MCP configuration, replacing the paths with that runtime's absolute paths. The configuration contains only a private directory reference, never the token itself.

```json
{
  "mcpServers": {
    "project-room-channel": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/project-room/scripts/agent-claude-channel.mjs",
        "--host", "claude-room",
        "--cadence-seconds", "60"
      ],
      "env": { "ROOM_AGENT_CONFIG": "/absolute/private/connection-directory" }
    }
  }
}
```

Claude Code's current channel research preview requires explicit channel enablement. Its documented development command is:

```sh
claude --dangerously-load-development-channels server:project-room-channel
```

Use the existing intended Claude session's supported resume/setup flow. The host presents its development confirmation, MCP trust and organization policy controls. Merely adding an MCP server does not enable its channel. Verify the native registered-channel notice and `/mcp` status. This document does not start or replace a session.

## Verify a complete exchange

Send a directed Room request to the saved member. The receiving Claude should read the current request using its Room tools, respond with the original request linkage and a stable request ID, and verify that Room recorded the reply. It can then call `room_acknowledge_wake` with the exact emitted `signalIds`. A pointer arriving in stdio does not establish that Claude processed it or completed work.

The adapter starts its first attention read after MCP initialization, then holds bounded outbound Room polls. It forwards only pointers for the configured Room, without message bodies. Historical attention produces a startup read prompt even if the durable wake queue is empty. Repeated pending signals are deduplicated within the process; unacknowledged signals replay after restart. Observation cursors are never handling acknowledgements.

An acknowledgement is restricted to signal IDs this channel emitted. Unknown HTTP outcomes remain unconfirmed; retry the exact IDs. A confirmed retry can report `notAcknowledged` when the original acknowledgement already committed. That is not a newly confirmed handling receipt.

The adapter aborts on stream closure or lost authorization, leaves pending signals untouched, and emits only bounded diagnostics. At 256 outstanding emitted signals it stops with `channel_pending_limit`; inspect and handle the retained Room work before restarting. The one-second transport backoff prevents immediate pending polls from spinning; it runs no inference while idle. No permission relay capability is declared.

Current capabilities and enablement requirements come from the [official Claude Code channel contract](https://code.claude.com/docs/en/channels-reference). Actual host availability and successful Room return must be observed before marking the member reachable.
