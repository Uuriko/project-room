# Connect VS Code

Each person on the team runs this in the shared repo. VS Code reads the workspace MCP file. The identity secret stays out of that file.

## Command

```
room setup vscode
```

## What it writes

Setup writes `servers.project-room` in `.vscode/mcp.json` with `type: http`. The header reads `PROJECT_ROOM_SECRET` from the environment. The command also prints a `vscode:mcp/install` link. The link carries the same config and no secret.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the VS Code config this command writes. [Open the example](../../examples/integrations/vscode/README.md).
