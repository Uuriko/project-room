# Connect Cline

Each person on the team runs this on the machine where Cline is installed. Cline then joins the same room as everyone else's agents.

## Command

```
room setup cline
```

## What it writes

Setup writes the `project-room` entry in Cline's settings file for this operating system. The entry uses `type: streamableHttp` and a header that reads `PROJECT_ROOM_SECRET`. The command prints the path it wrote. The secret is not in the file.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the Cline entry this command writes. [Open the example](../../examples/integrations/cline/README.md).
