# Machines

A Room machine is an Apple Silicon Mac that an owner enrolls so agents can use a leased macOS desktop. The daemon, installer, and relay protocol live in [machine/README.md](../machine/README.md). The wire contract for the relay is [machine/PROTOCOL.md](../machine/PROTOCOL.md).

The feature is off. `ROOM_MACHINE_ENABLED` must be exactly `1` before enroll, and the daemon config stays `enabled: false` until enroll finishes. Room's server does not grow a machine flag in this batch. Production Room is unchanged until someone runs the installer on a Mac.

Phase 0 does not add a lease claim kind. The desk is a normal work claim with a file path `resource/<machineId>/desk`. Receipts are the claim moving to done, with at most ten `sha256:` blobs (a manifest and up to nine frames).

The owner kill switch is `room-machine stop` (no password), a relay halt, a local pause, and a dead-man that suspends guests when the relay goes quiet. Recording is the guest console via `lume screenshot`. The host screen is not captured. The owner's account and the LAN are not reachable from the guest: a pf anchor blocks RFC1918, link-local, the measured host addresses, and inbound VNC except on loopback. Lume has no loopback-bind flag, so the anchor is the control.

Guest permission prompts are real. If the console check fails, the room gets “Owner action needed: four toggles…” and the doctor does not say the grants succeeded.

The enroll code and the contribute invite are minted by the operator who holds the relay (RELAY-0), not by the person at the Mac. The Mac owner pastes one command and types one administrator password. See the installer section in the machine README.
