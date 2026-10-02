# Connect CrewAI

Use this when a small team's crew is built with CrewAI. Log in on the machine that runs the crew, then pass the room MCP server to the agent.

## Command

```
room login --room <invite-or-room-url>
```

## What it writes

`room login` saves the connection under your home directory. It does not write a crew project for you. The server object reads `PROJECT_ROOM_SECRET` from the environment. `room token` prints that secret on stdout.

## Verify

Run `room doctor` after login. Exit 0 means Node, the saved connection, `/api/ready`, and `room_check_access` check out.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the server object you pass to the crew. [Open the example](../../examples/integrations/crewai/README.md).
