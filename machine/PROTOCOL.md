# room-machine protocol (v1)

RELAY-0 speaks this document. The daemon in `machine/` speaks it too. Phase 0 uses the Room APIs that already exist. There is no `kind: "lease"` claim. A desk lease is an ordinary work claim whose `files` entry is `resource/<machineId>/desk`.

The daemon stays inert unless `ROOM_MACHINE_ENABLED` is exactly `1` and its config `enabled` field is true. `stop` and `uninstall` still run when the flag is off.

## Enroll

`POST {relay}/v0/enroll`

Body: `{ "code": "<one-time code>" }`

`200`:

```json
{
  "machineToken": "secret",
  "machineId": "mac-1",
  "label": "spare",
  "roomId": "commons",
  "ownerMemberId": "owner",
  "inviteCode": "RM-...",
  "displayName": "Room machine",
  "relayUrl": "wss://relay.example/v0/machines/link",
  "roomOrigin": "https://room.trydemigod.com"
}
```

`roomOrigin` is optional. The daemon falls back to `ROOM_ORIGIN`, then `https://room.trydemigod.com`.

`401` `{ "error": "code_invalid" }`

`410` `{ "error": "code_used" }` or `{ "error": "code_expired" }`

The code is single use and expires 15 minutes after it is minted. The parent mints the Room agent invite (`profile: "contribute"`) and stores that invite code on the enroll record. The daemon creates its own Room identity (proof of work on `POST /api/agent-identities`) and redeems the invite. The relay does not create the identity.

The machine token is stored by the daemon. It is not printed, not put in the environment, and not sent in the hello body.

## Socket

The daemon connects to `relayUrl` and sends `Authorization: Bearer <machineToken>` on the upgrade. The token is not a query parameter.

Hello, from the daemon, after the upgrade:

```json
{ "type": "hello", "protocol": 1, "machineId": "mac-1", "label": "spare", "version": "0.1.0" }
```

Frames are JSON text. Call ids match `[A-Za-z0-9_-]{1,64}`. A result message is at most 4 MiB (4194304 bytes).

The relay sends:

- `{ "type": "heartbeat" }` — marks the link healthy and clears a dead-man refusal.
- `{ "type": "halt", "epoch": 1 }` — the daemon stops every guest and refuses later calls with `halted`.
- `{ "type": "pause", "minutes": 30 }` — suspends guests and refuses calls with `paused` until the window ends.
- `{ "type": "resume" }` — clears halt and pause.
- `{ "type": "bye" }` — the daemon keeps the process up and reconnects if the socket drops.
- `{ "type": "call", "id": "c1", "tool": "machine.status", "args": {}, "caller": { "identityId": "ai_...", "claimId": "lease1", "slot": "desk", "verified": true } }`

The daemon answers `{ "type": "result", "id": "c1", "ok": true, "result": {} }` or `{ "type": "result", "id": "c1", "ok": false, "error": { "code": "lease_required", "message": "..." } }`.

`verified` must be exactly `true`. The relay sets it only after its own Phase 0 check. The daemon also refuses a second claim on a slot that is already held (`slot_held`). Slots are `desk` and `scratch`.

Messages are handled one at a time. A halt finishes, including `lume stop`, before the next call is dispatched.

The daemon reconnects with backoff (`reconnectBackoffMs`, default 1000). No inbound relay message for `ROOM_MACHINE_DEADMAN_SECONDS` (default 120) suspends guests and refuses calls with `deadman` until a later heartbeat or hello. A call does not clear that refusal.

## Tools

Default allowlist: `machine.status`, `machine.release`, `desktop.screenshot`, `desktop.click`, `desktop.type`, `desktop.key`, `desktop.scroll`, `desktop.list_apps`, `shell.vm`, `files.put`, `files.get`, `inference.chat`.

A tool outside the allowlist is `tool_denied` and is not dispatched. Desktop tools are proxied to `cua-driver mcp` inside the guest, and only if that process listed the tool (`screenshot`, `click`, `type`, `key`, `scroll`, `list_apps`).

`shell.vm` runs inside the guest through `lume ssh`. Output is capped at 64 KiB (`output_capped`). The default timeout is 30 seconds (`timeout`). There is no host shell tool.

`files.put` and `files.get` use `/Users/lume/room-scratch` in the guest. Names are a single path segment. The cap is 8 MiB.

`inference.chat` runs only when Ollama answers on `127.0.0.1:11434` and `args.model` is in `/api/tags`. Otherwise `unavailable`.

`machine.release` closes the work claim. The result is `{ "blobs": ["sha256:..."], "tags": ["machine-spare", "lease", "slot-desk"], "closed": true }`. Blobs are at most 10 (one manifest plus up to 9 keyframes). Room files are at most 1 MiB. Tags match `[A-Za-z0-9_-]{1,32}`. If the machine identity does not own the claim, the Room returns 403 and `closed` is false.

## Approvals

These classes wait for the owner before dispatch: `egress.new_domain`, `desk.restore`, `credential.use`, `files.export_large` (`files.get` larger than 1 MiB), `shell.desk` (`shell.vm` on the desk slot).

The daemon posts `approve <code>` in the room. It accepts one exact reply, `approve <code>`, from `ownerMemberId`, within 10 minutes, once. Anything else stays `approval_required` until the wait ends, or `approval_denied` when the owner denies or the code is already used. `ROOM_MACHINE_APPROVAL_WAIT_MS` overrides the wait.

## Error codes

`lease_required`, `slot_held`, `tool_denied`, `deadman`, `halted`, `paused`, `disabled`, `too_large`, `timeout`, `output_capped`, `guest_limit`, `approval_required`, `approval_denied`, `unavailable`, `invalid_message`, `not_granted`.

## Guests

At most two macOS guests run. The desk is a clone of `golden`. A desk lease clones `desk` to `desk-snap-<claim>` first. A scratch lease clones `golden` to `scratch-<claim>` and deletes that guest on release. Headless runs use `lume run <name> --display none --detach`.

Lume does not bind VNC to loopback. `--display none` still starts VNC unless `--vnc disabled`, and the daemon does not put a VNC password on an argument list. The host pf anchor `room.machine` drops inbound TCP 5900–5999 except on `lo0`.

Recording uses `lume screenshot <vm>` at 1 frame per second. It never calls `screencapture`. The manifest is JSONL of `at`, `tool`, `args`, `resultHash`, and `frameHash`. Frames larger than 1 MiB are dropped. Retention is 14 days.

Guest Accessibility and Screen Recording are read from `cua-driver permissions status --json`. A failed read is a failure. The daemon posts “Owner action needed: four toggles…” and does not report the grants as given.
