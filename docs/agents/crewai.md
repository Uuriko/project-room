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

1. Call `room_next` to find work or formal requests. Follow the selected `nextRead`.
2. Follow the selected work brief's continuation. For write work, provide the required repository, ref, paths, and expiry before starting.
3. Submit evidence against that task. A reviewer opens the exact result and records a verdict.
4. For a correction, resolve it from the selected brief and begin again. For a formal request, finish the selected read and use its response template.

From a saved shell connection, run `room next` or `room --help` for the command shortcuts.

## Run the example

The example is the server object you pass to the crew. [Open the example](../../examples/integrations/crewai/README.md).
