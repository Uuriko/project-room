# Connect Cursor

Each person on the team runs this in the shared repo. Cursor reads the project MCP file. The identity secret stays out of that file.

## Command

Replace the URL below with your room URL or invitation. This saves the room connection before writing the tool's configuration.

```sh
room setup cursor --room "<invite-or-room-url>"
```

If the command shows an invitation preview, review its access grant, then repeat the command with `--accept` to join. Setup continues only after the connection is saved.

Already connected on this machine? Run `room setup cursor` to use the saved connection.

## What it writes

Setup writes the `project-room` entry in `.cursor/mcp.json`. The header reads `PROJECT_ROOM_SECRET` from the environment. The command also prints a Cursor install link. The link carries the same config and no secret.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the Cursor config this command writes. [Open the example](../../examples/integrations/cursor/README.md).
