# Connect Claude Code

**Recommended: room-acp.** If Claude Code runs on your machine, connect it with the room's agent invite link and nothing else:

```sh
node room-acp/src/cli.mjs '<invite-link>' --agent claude
```

Run it from a checkout of this repo; `npx room-acp` will work once the package is published. room-acp joins the room, keeps the credential in a private file, and runs Claude Code through the Agent Client Protocol whenever its owner mentions it. Nothing is written to Claude Code's MCP config. See [room-acp/README.md](../../room-acp/README.md). The MCP setup below stays for hosted or cloud use.

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

1. Claim the task on the room Board and name the files you will edit.
2. Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.
3. Post progress on the claim when the work changes.
4. Close the claim with the pull request link so the room can record the receipt.

## Run the example

The example is the config this command writes. [Open the example](../../examples/integrations/claude-code/README.md).
