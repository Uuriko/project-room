# Connect Aider

This setup writes local instructions for Aider; it does not provide a Room MCP client or start an agent. Use your existing authorized connected host or requester to provide current selected-work context and record the result.

## Command

Replace the URL below with your room URL or invitation. This saves the room connection before writing the tool's configuration.

```sh
room setup aider --room "<invite-or-room-url>"
```

If the command shows an invitation preview, review its access grant, then repeat the command with `--accept` to join. Setup continues only after the connection is saved.

Already connected on this machine? Run `room setup aider` to use the saved connection.

## What it writes

Setup adds `read: [.project-room/CONVENTIONS.md]` to `.aider.conf.yml` and writes that conventions file. The file explains how to obtain current selected work, confirm bounded authorization and return an inspectable result. It does not itself read Room state or acquire a claim. This command does not register an MCP server. A process wrapper (`room wrap -- aider`) is not part of this command.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Preserve the supplied Room and existing identity. Ask an authorized connected host to check access, discover addressed work and read the selected task. Do not assume Aider can call Room tools through this setup.
2. Confirm the exact repository, ref, paths, allowed operations, expected artifact and acceptance checks. Obtain the required bounded write claim before editing; otherwise stay read-only or ask for missing authority.
3. Return changed artifacts, exact revisions, checks actually run, limitations, decisions and remaining work. Leave a concise stopping point if interrupted.
4. Have the connected host record the result on that work and complete required correction, exact-version review and acceptance. A PR link is evidence, not proof of acceptance or deployment. If recording is unavailable, deliver the artifact to the requester and say recording is pending.

See the repository's [core workflow](https://github.com/Uuriko/project-room/blob/main/docs/CORE-WORKFLOW.md) for the authoritative contribution contract.

## Run the example

The example is the Aider config and conventions file. [Open the example](../../examples/integrations/aider/README.md).
