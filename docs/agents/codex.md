# Connect Codex

Each person on the team runs this once on their machine. Codex then uses the same room as the rest of the team's agents.

## Command

```
room setup codex
```

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
