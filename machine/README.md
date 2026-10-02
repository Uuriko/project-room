# room-machine

`room-machine` turns an Apple Silicon Mac into a Room machine. An agent gets a leased macOS VM desktop through Cua Driver, a guest shell, file transfer, and local inference when Ollama is already running. The Mac dials out to a relay. It does not open a host shell and it does not prompt for host Accessibility or Screen Recording.

This tree ships off. Nothing enrolls, opens a socket, or starts a guest unless `ROOM_MACHINE_ENABLED` is exactly `1`. `room-machine stop` and `room-machine uninstall` run without that flag.

Phase 0 uses Room as it exists today: agent identities, contribute invites, heartbeats, work claims, room files, and messages. The relay is a separate batch (RELAY-0). Until that lands, `machine/test/fake-relay.mjs` speaks [PROTOCOL.md](PROTOCOL.md).

## One command

On the Mac, after the owner has a one-time enroll code:

```bash
ROOM_MACHINE_ENABLED=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Uuriko/project-room/<commit>/machine/install.sh)" -- --enroll <ONE-TIME-CODE>
```

`<commit>` is the commit that contains this installer. The script checks the flag first and exits 0 when the flag is off, without `sudo` and without downloading anything.

What the owner does on the Mac:

1. Power, network, and a logged-in session.
2. Paste that command.
3. Type the administrator password once, when `sudo` asks.
4. Four guest toggles (Accessibility, Screen Recording, Automation of System Events, Tahoe direct capture) only if the console check fails. The doctor says so. A failed check is not reported as granted.
5. The FileVault disk password, only after an unplanned power loss.

`room-machine stop` does not ask for a password. Unplugging the network suspends guests after the dead-man window (120 seconds, or `ROOM_MACHINE_DEADMAN_SECONDS`).

## Layout

Config lives in `ROOM_MACHINE_HOME`, otherwise `~/Library/Application Support/room-machine` on macOS, otherwise `~/.local/share/room-machine`. `config.json` is mode `0600`. `enabled` defaults to false.

The machine token and the Room identity secret are written to a `0600` file and copied to the `room-machine` keychain item with the secret on stdin. Arguments and the child environment do not carry them. If `security` rejects the stdin copy, the daemon reads the `0600` file. Hardware has to confirm the keychain path; the file path is what this tree can prove.

Pinned guest binaries are in `versions.json` (Lume 0.6.0 and Cua Driver 0.32.0, darwin-arm64 tarballs with sha256). An empty pin refuses the download. The installer does not pipe a moving upstream install script. There is no room-machine GitHub release binary yet. The installer runs the Node entry that ships inside the script (`machine/bin/room-machine.mjs`, Node ≥ 24.19).

`room-machine provider set local|anthropic|openai|dasha|none` stores the provider name in `config.json`. For anthropic, openai, and dasha, the key is read from stdin and stored in the keychain and a mode `0600` file. The key is not an argument, it is not written to `config.json`, and it is not placed in a child environment.

The bot loop stays off until `room-machine bot enable --room <roomId>`. `room-machine bot disable` turns it off. While it is on, `room-machine run` polls that room. The local tier defaults to t1: the bot posts a plan and waits until the owner, or a member named with `--go`, replies `go`.

## Commands

`status`, `doctor`, `stop`, `pause --minutes N`, `resume`, `uninstall`, `preflight`, `enroll --enroll CODE`, `provider set NAME`, `bot enable --room ROOM`, `bot disable`, `run`.

`doctor` posts measured facts only: architecture, chip, RAM, free disk, macOS version, Lume version, driver version, guest grants, and whether Ollama and Xcode answered. A probe that fails is `not measured` or `absent`.
