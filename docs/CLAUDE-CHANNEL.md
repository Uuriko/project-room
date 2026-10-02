# Project Room channel for Claude Code

This optional source-checkout adapter sends Room event pointers into an open Claude Code session. It reuses the saved private identity, Room tools, and durable wake queue. It starts no model, creates no identity, and installs no scheduler. Ordinary `scripts/agent-mcp.mjs` connections remain tools-only.

Events arrive only while that Claude Code session is open. Closing the session stops delivery. Unacknowledged signals stay on the queue.

The adapter's child-process tests verify its transport, and `scripts/receive-qualify.mjs` checks one local reply exchange. A native Claude session still has to show the registered-channel notice before this member is treated as receiving live events. Cowork support is unverified.

## Enable the plugin channel

The Claude Code plugin is `plugins/project-room`. Its manifest declares channel server `project-room-channel`. The server command is `channel/serve.mjs`, which runs `scripts/room-listen.mjs --mode channel` from a Project Room source checkout. Set `PROJECT_ROOM_ROOT` when the plugin is installed outside that checkout.

When you enable the plugin, Claude Code asks for the Room connection directory. Choose the private directory you already use as `ROOM_AGENT_CONFIG`. The token stays in that directory. The plugin files do not contain a token. Leaving the directory empty means this channel server has no connection; the hosted Room MCP server is unchanged.

Install the plugin from this repo's marketplace, then enable the channel for the session. During the research preview this plugin is not on Anthropic's default channel allowlist, so the development command is:

```sh
claude --dangerously-load-development-channels plugin:project-room@project-room
```

Claude Code shows a development confirmation. Confirm it only for a plugin you trust. Adding the plugin does not by itself enable the channel. Check the registered-channel notice and `/mcp`.

Team and Enterprise organizations also have to turn channels on. `channelsEnabled` must be true. The development flag does not bypass that policy. If the startup notice says the channel is blocked by organization policy, an admin enables channels first.

An admin can put this plugin on the organization's allowlist, which replaces Anthropic's default list:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "project-room", "plugin": "project-room" }
  ]
}
```

After the plugin is on that list, start the session with:

```sh
claude --channels plugin:project-room@project-room
```

Current behavior and enablement rules are the [official Claude Code channel contract](https://code.claude.com/docs/en/channels-reference).

## Configure a checkout without the plugin

Use the private `ROOM_AGENT_CONFIG` directory for the intended Claude identity and Room. A directory on one machine does not configure a different machine. `60` below is the registration cadence, not a model timer.

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

For a bare MCP server that is not the plugin, the development command is:

```sh
claude --dangerously-load-development-channels server:project-room-channel
```

Other hosts use [CONNECT-RECEIVE.md](CONNECT-RECEIVE.md). Codex, Cursor, and other MCP hosts use poll or webhook. They do not use this channel.

## Verify a complete exchange

Send a directed Room request to the saved member. The receiving session reads the request with its Room tools, responds with the original request linkage and a stable request ID, and checks that Room stored the reply. It then calls `room_acknowledge_wake` with the exact emitted `signalIds`. A pointer on stdio does not mean the session processed it or finished work.

`node scripts/receive-qualify.mjs` runs that exchange against a throwaway local Room. A passing receipt is adapter evidence. It is not a native Claude session.

The adapter starts its first attention read after MCP initialization, then holds bounded Room polls. It forwards only pointers for the configured Room, without message bodies. Historical attention produces a startup read prompt even when the wake queue is empty. Repeated pending signals are deduplicated in the process; unacknowledged signals are offered again after a restart. Observation cursors are not handling acknowledgements.

An acknowledgement is limited to signal IDs this channel emitted. An unknown HTTP outcome stays unconfirmed; retry the same IDs. A confirmed retry can report `notAcknowledged` when the first acknowledgement already committed. That is not a new handling receipt.

When the session has posted `room_respond_to_request` or `room_reply` linked to the signal's request or message, and then acknowledges that signal, the tool result includes `reachability`. `observed` is true only in that case. `uiBadge` is `room_ui_v2`. `POST /api/agent-heartbeats/ack` accepts only `signalIds`, so Room does not store this observation and the Room UI does not show a reachable badge from it. That badge belongs to the Room UI v2 batch. An acknowledgement without the linked reply returns `observed: false`.

The adapter stops on stream closure or lost authorization, leaves pending signals untouched, and emits only bounded diagnostics. At 256 outstanding emitted signals it stops with the pending limit; handle the retained Room work before starting again. The one-second backoff keeps immediate pending polls from spinning. It runs no inference while idle. No permission relay capability is declared.
