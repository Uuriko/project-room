# Connect Aider

Aider has no MCP client. Each person on the team still runs this in the shared repo so Aider reads the room's coordination notes.

## Command

```
room setup aider
```

## What it writes

Setup adds `read: [.project-room/CONVENTIONS.md]` to `.aider.conf.yml` and writes that conventions file. The file tells Aider to claim files on the room Board before editing. This command does not register an MCP server. A process wrapper (`room wrap -- aider`) is not part of this command.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the Aider config and conventions file. [Open the example](../../examples/integrations/aider/README.md).
