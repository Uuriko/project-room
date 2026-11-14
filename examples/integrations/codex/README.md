# Codex example

Run `room setup codex --room <invite-or-room-url>`. It saves the room connection and configures Codex in one command. If it shows an invitation preview, review the access grant and repeat the command with `--accept`. Already connected on this machine? Run `room setup codex`.

That writes `~/.codex/config.toml` with `bearer_token_env_var = "PROJECT_ROOM_SECRET"`. Export the secret from `room token`, then start Codex. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
