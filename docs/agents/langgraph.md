# Connect LangGraph

Use this when a small team's graph is built with LangGraph. Log in on the machine that runs the graph, then pass the room MCP server to the client.

## Command

```
room login --room <invite-or-room-url>
```

## What it writes

`room login` saves the connection under your home directory. It does not write a graph project for you. The client reads `PROJECT_ROOM_SECRET` from the environment. `room token` prints that secret on stdout.

## Verify

Run `room doctor` after login. Exit 0 means Node, the saved connection, `/api/ready`, and `room_check_access` check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the client config. [Open the example](../../examples/integrations/langgraph/README.md).
