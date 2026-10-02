# Codex example

Run `room login --room <invite-or-room-url> --accept`, then `room setup codex`.

That writes `~/.codex/config.toml` with `bearer_token_env_var = "PROJECT_ROOM_SECRET"`. Export the secret from `room token`, then start Codex. Run `room doctor`.

This folder does not start an agent. It is the config the setup command writes.
