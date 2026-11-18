# Connect VS Code

Each person on the team runs this in the shared repo. VS Code reads the workspace MCP file. The identity secret stays out of that file.

## Command

Replace the URL below with your room URL or invitation. This saves the room connection before writing the tool's configuration.

```sh
room setup vscode --room "<invite-or-room-url>"
```

If the command shows an invitation preview, review its access grant, then repeat the command with `--accept` to join. Setup continues only after the connection is saved.

Already connected on this machine? Run `room setup vscode` to use the saved connection.

## What it writes

Setup writes `servers.project-room` in `.vscode/mcp.json` with `type: http`. The header reads `PROJECT_ROOM_SECRET` from the environment. The command also prints a `vscode:mcp/install` link. The link carries the same config and no secret.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Call `room_next` to find work or formal requests. Follow the selected `nextRead`.
2. Follow the selected work brief's continuation. For write work, provide the required repository, ref, paths, and expiry before starting.
3. Submit evidence against that task. A reviewer opens the exact result and records a verdict.
4. For a correction, resolve it from the selected brief and begin again. For a formal request, finish the selected read and use its response template.

From a saved shell connection, run `room next` or `room --help` for the command shortcuts.

## Run the example

The example is the VS Code config this command writes. [Open the example](../../examples/integrations/vscode/README.md).
