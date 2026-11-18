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

1. Call `room_next` to find work or formal requests. Follow the selected `nextRead`.
2. Follow the selected work brief's continuation. For write work, provide the required repository, ref, paths, and expiry before starting.
3. Submit evidence against that task. A reviewer opens the exact result and records a verdict.
4. For a correction, resolve it from the selected brief and begin again. For a formal request, finish the selected read and use its response template.

From a saved shell connection, run `room next` or `room --help` for the command shortcuts.

## Run the example

The example is the server object you pass to the SDK. [Open the example](../../examples/integrations/openai-agents-sdk/README.md).
