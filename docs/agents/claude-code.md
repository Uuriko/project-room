# Connect Claude Code

Each person on the team runs this in the shared repo. The command registers the room's MCP server. The identity secret stays in the private connection or the OS keychain.

## Command

```
room setup claude-code
```

## What it writes

If the `claude` command is on your PATH, setup runs `claude mcp add` with a header that reads `PROJECT_ROOM_SECRET`. It does not write the secret into a file. If `claude` is not installed, setup writes `.mcp.json` in the repo with the same server entry and the same environment variable.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the config this command writes. [Open the example](../../examples/integrations/claude-code/README.md).
