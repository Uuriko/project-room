# A dependable local Codex connection

Use the existing App Server host for public shared requests. It binds each Room
run and attempt to its provider thread and turn, journals outputs, and retries the
same publication. Connecting MCP tools alone does not launch this host.

## Check the four separate prerequisites

1. A saved Room connection authenticates the intended member in the intended room.
2. The room administrator has selected that member as the shared assistant.
3. The dedicated Codex profile passes protocol and credential preflight.
4. The foreground host is running with a private journal and the intended workspace.

`credentials: present` is only authentication configuration. `modelExecution:
completed` plus `resultMessageId` records a returned result in this host session;
it does not certify result correctness or promise the next request will succeed.
On restart that session observation resets. Room results and execution journals
remain durable.

## Start, inspect and stop

Replace all example paths with your own canonical absolute paths. Keep the
connection and provider credentials private. See [runtime setup](CODEX-ROOM-HOST.md).

```sh
node scripts/run-codex-room.mjs --preflight /absolute/runtime.json
ROOM_AGENT_CONFIG=/absolute/room-connection node scripts/run-codex-room.mjs --list
ROOM_AGENT_CONFIG=/absolute/room-connection node scripts/run-codex-room.mjs \
  --watch /absolute/journal.sqlite /absolute/runtime.json
node scripts/run-codex-room.mjs --status-watch /absolute/journal.sqlite
node scripts/run-codex-room.mjs --stop-watch /absolute/journal.sqlite
```

Keep the listener running while receiving work. Ordinary messages and work-card
assignments are not shared-assistant invocations. A human uses the room's shared
assistant action; the host only picks runs assigned to its configured member.
Do not replace another member's assistant routing merely to pass preflight.

## Recover without repeating uncertain actions

- After a confirmed provider interruption, restart with the same journal/profile.
  The request becomes **paused**. Use **Resume** in Room to continue the same
  conversation. The continuation carries the prior interruption and requires
  reconciliation of earlier actions.
- If the provider's outcome is uncertain, keep the journal and inspect the original
  attempt. An unknown start is never automatically resent.
- If publication succeeded but its response was lost, retry with the same journal.
  The saved publication keeps its original operation ID; no second model turn is
  necessary.
- `recoveryAction: reconnect_agent` identifies a permanent Room access refusal.
  Restore the intended connection; do not loop provider restarts.
- `recoveryAction: inspect_original_attempt` identifies unresolved execution.
- A dedicated `.room-runtime.lock` prevents competing provider processes. After a
  crash inspect the actual process group and journal before any manual recovery.
  Never delete the lock or journal simply to bypass ownership.
- Optional Mac UI tools must be enabled and their private connection must exist if
  configured. For a file-only worker, deliberately configure a profile without
  `macTools`; do not silently fall back from unavailable UI access.

## Opt-in qualification

This uses a real model with an existing dedicated login and synthetic local Room
content. It does not touch hosted rooms or import desktop credentials.

```sh
node scripts/qualify-codex-room.mjs /absolute/runtime.json /absolute/result.json
node scripts/qualify-codex-room.mjs /absolute/runtime.json /absolute/resume.json \
  --resume-after-interrupt
node scripts/qualify-codex-room.mjs /absolute/runtime.json /absolute/disconnect.json \
  --disconnect-after-start
```

Normal qualification reads a small inventory fixture, publishes the report, and
reopens the provider/journal to prove the same result is returned without another
turn. The resume case interrupts work, restarts the host, explicitly resumes its
saved conversation and checks one result. The disconnect case tests uncertainty
and duplicate suppression; it does not necessarily produce a completed result.
Physical sleep, a second machine, hosted human invocation and installed-app UI
are separate qualification gates. Do not label a local fixture as production proof.
