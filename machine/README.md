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

Note: the one-command form runs the script from a pipe, so the out-of-band self-check described below cannot apply — there is no script file to verify, and the installer prints a warning saying so. If you want substitution protection, use the verify flow instead of the one-liner.

Verify before you run (M7): the hash embedded in the script guards the payload against truncation only — it cannot authenticate the script itself. There is no separately published hash to check against, so verify by fetching the script twice — over two independent connections — and comparing the bytes before you run anything:

```bash
C=<commit>  # the commit whose installer you intend to run
curl -fsSL -o install.sh https://raw.githubusercontent.com/Uuriko/project-room/$C/machine/install.sh
curl -fsSL "https://api.github.com/repos/Uuriko/project-room/contents/machine/install.sh?ref=$C" \
  | node -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(Buffer.from(JSON.parse(s).content,"base64"))' \
  > install.sh.check
cmp install.sh install.sh.check && echo "MATCH: both fetches agree"
```

`cmp` staying silent means the two fetches delivered identical bytes. Then bind the file you run to the bytes you verified — the exported hash makes the script verify its own bytes before doing anything, and refuse on mismatch (which also catches a swap between verification and execution):

```bash
export ROOM_MACHINE_INSTALL_SHA256=$(shasum -a 256 install.sh | awk '{print $1}')
ROOM_MACHINE_ENABLED=1 bash install.sh -- --enroll <ONE-TIME-CODE>
```

What this defends against: a tampered download on one of the two paths (compromised mirror, poisoned cache, an attacker intercepting one connection). What it does not defend against: an attacker who controls both of your connections (for example a TLS-intercepting corporate proxy), or the GitHub repo itself. If either is in your threat model, do not use the one-command install — clone the repo over a connection you trust and run `machine/install.sh` from the checkout.

Longer term (not yet implemented): detached signatures (e.g. minisign) verified against a public key pinned in this repo, which would remove the need to compare fetches by hand.

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

`status`, `doctor`, `stop`, `pause --minutes N`, `resume`, `uninstall`, `preflight`, `enroll` (code via `--enroll CODE` or stdin), `provider set NAME`, `bot enable --room ROOM`, `bot disable`, `run`.

`doctor` posts measured facts only: architecture, chip, RAM, free disk, macOS version, Lume version, driver version, guest grants, and whether Ollama and Xcode answered. A probe that fails is `not measured` or `absent`.
