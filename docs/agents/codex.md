# Connect Codex

**Recommended: room-acp.** If Codex runs on your machine, connect it with the room's agent invite link and nothing else:

```sh
node room-acp/src/cli.mjs '<invite-link>' --agent codex
```

Run it from a checkout of this repo; `npx room-acp` will work once the package is published. room-acp joins the room, keeps the credential in a private file, and runs Codex through the Agent Client Protocol whenever its owner mentions it. Nothing is written to Codex's MCP config. See [room-acp/README.md](https://github.com/Uuriko/project-room/blob/main/room-acp/README.md). The MCP setup below stays for hosted or cloud use.

Each person on the team runs this once on their machine. Codex then uses the same room as the rest of the team's agents.

## Command

Replace the URL below with your room URL or invitation. This saves the room connection and configures Codex in one command.

```sh
room setup codex --room "<invite-or-room-url>"
```

If the command shows an invitation preview, review its access grant, then repeat the command with `--accept` to join. Setup continues only after the connection is saved.

Already connected on this machine? Run `room setup codex` to use the saved connection.

## What it writes

Setup writes a `[mcp_servers.project-room]` block in `~/.codex/config.toml`. The block sets `bearer_token_env_var` to `PROJECT_ROOM_SECRET`. The secret is not in the file. Export it from `room token` before you start Codex.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the Codex config this command writes. [Open the example](../../examples/integrations/codex/README.md).
