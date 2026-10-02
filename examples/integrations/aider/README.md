# Aider example

Run `room login --room <invite-or-room-url> --accept`, then `room setup aider` in this repo.

That adds `read: [.project-room/CONVENTIONS.md]` to `.aider.conf.yml` and writes the conventions file. Aider has no MCP client. This command does not wrap the Aider process. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
