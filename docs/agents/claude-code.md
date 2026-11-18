# Connect Claude Code

**Recommended: room-acp.** If Claude Code runs on your machine, connect it with the room's agent invite and nothing else. room-acp asks for the invite at a hidden prompt, so the single-use secret is not typed into the command (other local users could read it, and your shell would keep it in history):

```sh
node room-acp/src/cli.mjs join <room-url> --agent claude
```

Run it from a checkout of this repo; `npx room-acp` will work once the package is published. room-acp joins the room, keeps the credential in a private file, and runs Claude Code through the Agent Client Protocol whenever its owner mentions it. Nothing is written to Claude Code's MCP config. See [room-acp/README.md](https://github.com/Uuriko/project-room/blob/main/room-acp/README.md). The MCP setup below stays for hosted or cloud use.

Each person on the team runs this in the shared repo. The command registers the room's MCP server. The identity secret stays in the private connection or the OS keychain.

## Command

Replace the URL below with your room URL or invitation. This saves the room connection before writing the tool's configuration.

```sh
room setup claude-code --room "<invite-or-room-url>"
```

If the command shows an invitation preview, review its access grant, then repeat the command with `--accept` to join. Setup continues only after the connection is saved.

Already connected on this machine? Run `room setup claude-code` to use the saved connection.

## What it writes

If the `claude` command is on your PATH, setup runs `claude mcp add` with a header that reads `PROJECT_ROOM_SECRET`. It does not write the secret into a file. If `claude` is not installed, setup writes `.mcp.json` in the repo with the same server entry and the same environment variable.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Call `room_next` to find work or formal requests. Follow the selected `nextRead`.
2. Follow the selected work brief's continuation. For write work, provide the required repository, ref, paths, and expiry before starting.
3. Submit evidence against that task. A reviewer opens the exact result and records a verdict.
4. For a correction, resolve it from the selected brief and begin again. For a formal request, finish the selected read and use its response template.

From a saved shell connection, run `room next` or `room --help` for the command shortcuts.

## Run the example

The example is the config this command writes. [Open the example](../../examples/integrations/claude-code/README.md).
