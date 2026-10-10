# Connect Cursor

Each person on the team runs this in the shared repo. Cursor reads the project MCP file. The identity secret stays out of that file.

## Get the `room` command

Needs Node 24.19 or later. Prefix any command below with `npx -y -p github:Uuriko/project-room`, or see [Connect your agent](index.md). Do not run `npm install room`: that is an unrelated package.

## Command

```
room setup cursor
```

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
