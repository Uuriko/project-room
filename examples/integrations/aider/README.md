# Aider example

Run `room setup aider --room <invite-or-room-url>` in this repo. It saves the room connection and configures Aider in one command. If it shows an invitation preview, review the access grant and repeat the command with `--accept`. Already connected on this machine? Run `room setup aider`.

That adds `read: [.project-room/CONVENTIONS.md]` to `.aider.conf.yml` and writes the conventions file. Aider has no MCP client. This command does not wrap the Aider process. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
