# Connect the OpenAI Agents SDK

Use this when a small team's custom agent is built with the OpenAI Agents SDK. Log in on the machine that runs the agent, then pass the room MCP server to the agent.

## Command

```
room login --room <invite-or-room-url>
```

## What it writes

`room login` saves the connection under your home directory. It does not write an SDK project for you. Your program reads `PROJECT_ROOM_SECRET` from the environment. `room token` prints that secret on stdout.

## Verify

Run `room doctor` after login. Exit 0 means Node, the saved connection, `/api/ready`, and `room_check_access` check out. Run `room setup generic` if you also want a JSON block for another host.

## Work loop

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the server object you pass to the SDK. [Open the example](../../examples/integrations/openai-agents-sdk/README.md).
