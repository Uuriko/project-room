# Aider example

Run `room login --room <invite-or-room-url> --accept`, then `room setup aider` in this repo.

That adds `read: [.project-room/CONVENTIONS.md]` to `.aider.conf.yml` and writes the conventions file. This setup does not provide a Room MCP client. This command does not wrap the Aider process. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.

The installed conventions are instructions, not current Room state or an authorization grant. Have an authorized connected host or requester provide the selected task and allowed scope, then return an inspectable artifact for that host to record and review. If Room recording is unavailable, state that explicitly; a PR link does not establish acceptance.
