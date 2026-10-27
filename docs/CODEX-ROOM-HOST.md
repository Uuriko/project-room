# Run Codex for a shared Room conversation

This opt-in host connects an existing Room assistant identity to a dedicated local
Codex App Server. It executes a selected **public shared ask**, including its
human contributions, and publishes one result through Room's atomic publication
endpoint. It does not import the Codex desktop app's account or conversations.

## Prepare a dedicated runtime

Use Node 22.13+ with `node:sqlite` and a Codex executable supporting App Server
thread start/read/resume and turn start/steer/interrupt. A version string alone
is insufficient; run the protocol check below.

Choose a private directory outside both the workspace and your usual `.codex`
directory. Example paths below must be replaced with your actual absolute paths.

```sh
mkdir -m 700 /absolute/room-codex-home
CODEX_HOME=/absolute/room-codex-home /absolute/codex \
  -c 'cli_auth_credentials_store="file"' login
```

Complete the normal Codex login for this dedicated profile. Do not copy your
ordinary `auth.json`, HOME, or desktop session directory. The host uses a separate
process HOME and a minimal environment; it forwards no Room token or inherited
API key. Dedicated Codex configuration and credentials remain operator-managed.

Save `/absolute/runtime.json`:

```json
{
  "command": "/absolute/codex",
  "cwd": "/absolute/project-checkout",
  "codexHome": "/absolute/room-codex-home",
  "policy": {
    "approvalPolicy": "never",
    "sandbox": "workspace-write"
  },
  "requestTimeoutMs": 30000,
  "turnTimeoutMs": 300000
}
```

Use `read-only` for inspection tasks. An optional `model` chooses a model available
to the dedicated account. This unattended host accepts only the two listed
sandbox modes and `approvalPolicy: "never"`; tools outside the configured policy
are denied, not silently approved. Clearing the environment is not an additional
OS sandbox; Codex enforces the selected tool sandbox.

From the Project Room source checkout:

```sh
node scripts/run-codex-room.mjs --check /absolute/runtime.json
```

The check starts a dedicated process, initializes it, creates and names an empty
probe thread, then reads and resumes its history. Naming persists the empty
paginated thread; requesting history before that can report `list_turns is not
supported yet` even on a compatible release. No model turn runs. A successful
check proves these protocol operations, **not provider authentication or successful
model/tool execution**.

## Select the Room and shared ask

Reuse the saved private Room connection directory. Its `connection.json` selects
the origin, room and member; do not print its token. The room owner must already
have selected this agent as the room assistant. A human creates the shared ask
in the room. Listing does not start work:

```sh
ROOM_AGENT_CONFIG=/absolute/room-connection \
  node scripts/run-codex-room.mjs --list
```

Execute one of this member's selected runs:

```sh
ROOM_AGENT_CONFIG=/absolute/room-connection \
  node scripts/run-codex-room.mjs RUN_ID \
  /absolute/private-room-journal.sqlite /absolute/runtime.json
```

For normal shared conversation use, keep the host listening instead of copying
each run ID:

```sh
ROOM_AGENT_CONFIG=/absolute/room-connection \
  node scripts/run-codex-room.mjs --watch \
  /absolute/private-room-journal.sqlite /absolute/runtime.json
```

The foreground host picks up queued requests and resumes one at a time in this
workspace. Leave it running while the team works; Ctrl-C stops it. A failed or
uncertain attempt is reported once for attention. Use its run ID and the same
journal to reconcile it before restarting the watcher.

The CLI checks the protocol **before claiming the run**. It streams answer deltas
as JSON to stdout and prints the final Room status/result ID. It passes neither
connection credentials nor private runtime reasoning into the room. The journal
binds the Room origin, room incarnation, member, run and attempt to the runtime
thread and turn. Only newly created or journal-authorized threads are accessible.
It does not list, attach to, or control unrelated Codex sessions.

## Stop, retries and interactive requests

Use Stop in the Room conversation to request interruption. The host polls shared
controls, interrupts the exact runtime turn and acknowledges stopping only after
observing terminal execution. Ctrl-C/SIGTERM stops the local host and interrupts
its owned work; if settlement cannot be confirmed, Room remains recoverable
rather than claiming success. The process group is terminated on host exit.

Keep both the private journal and dedicated Codex home. Rerunning the exact
command reconciles the original attempt or retries the saved atomic publication;
it must not execute the original completed work again. Ambiguous start/steering
responses require reconciliation. Never delete the journal to force a retry.

Only one host process may use a dedicated profile at once. An unresolved
`.room-runtime.lock` means inspect whether its process is still running before
manually removing that lock; do not remove it just to start a second host.

This CLI has no interactive approval or user-answer UI. Every runtime-initiated
approval/question receives an explicit JSON-RPC refusal, and stderr reports
`runtime_attention_required` with the request method. Ordinary group-chat text
is never interpreted as an approval. Use a task allowed by the configured policy
or a separately integrated interactive host when a genuine decision is required.

## Qualification evidence

On 2026-10-11, dedicated temporary profiles passed initialize, thread start,
metadata persistence, history read, and resume with both the installed Codex
0.159.0 and the official standalone `rust-v0.162.1` macOS ARM64 executable.
These checks used no model credentials and performed no model turn.

The 0.162.1 archive came from the [official release](https://github.com/openai/codex/releases/tag/rust-v0.162.1).
Its SHA-256 matched the GitHub release asset digest:
`b293a0fcdd871900a44c0a4f40a1aa401b31e02854f790ebdb8bd5d1177fd1fe`.
The existing app/global executable was not replaced.

Automated tests run a real fake-protocol subprocess through the CLI and a local
Room HTTP fixture, including atomic result publication. They also cover scoped
threads, private process environment, unsupported interactive requests, malformed
output, disconnects, timeouts and duplicate profile locks. Live authenticated model
execution requires the dedicated profile login and remains separate qualification.

## Keep the host listening

After dedicated login and the protocol check, keep one supervisor running:

```sh
ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs --watch \
  /absolute/private-room-journal.sqlite /absolute/runtime.json
```

This picks up explicitly invoked public asks assigned to this member, one at a
time. It polls the authoritative assistant queue every two seconds because room
event notifications do not cover every assistant state change. It does not turn
ordinary chat messages into execution requests. An unresolved owned attempt is
reconciled before any new ask. Retry delays are persisted and back off to thirty
seconds; restarting the process does not erase the original execution journal.

The existing watcher ownership lock lives beside the journal in `.sqlite.watch`.
A second supervisor using that directory fails instead of competing for work.
The separate runtime-profile lock also prevents two live Codex processes sharing
one profile. Keep both paths stable. Ctrl-C/SIGTERM interrupts owned work and
closes the runtime process group; uncertain outcomes remain recoverable in Room.

JSON status lines distinguish `watching_room`, `protocol_qualified`, `running`,
`settled`, `recovery_pending`, `retrying_room`, and `stopped`. Protocol qualification
still does not prove provider login. Missing credentials require dedicated login;
unsupported runtime questions require a separately connected decision interface.
An idle supervisor currently has local status only: Room's existing connected
indicator is based on recent active-run reports, not a persistent idle heartbeat.

This command is a foreground service; it does not install a login item or modify
host settings. For desktop computer tools, explicitly configure the dedicated
Codex profile's MCP server with `ProjectRoomTools --connection /absolute/path/to/connection.json`.
The native application must supply that connection file and the user must enable
its grants. The supervisor neither enables computer access nor imports another
Codex profile's MCP settings.

## Desktop host control contract

The desktop launches the same foreground host. It does not need a separate
runtime scheduler. `--watch` checks protocol and dedicated-profile credentials at
startup, even when no ask is queued. A missing login produces `login_required`
and bounded retries before any claim or model call.

```sh
node scripts/run-codex-room.mjs --preflight /absolute/runtime.json
node scripts/run-codex-room.mjs --status-watch /absolute/private-room-journal.sqlite
node scripts/run-codex-room.mjs --stop-watch /absolute/private-room-journal.sqlite
```

Preflight uses App Server `account/read` with `refreshToken: false`. Only
`credentials: present | login_required | not_required | unknown` is returned;
account email, plan, account ID, and credential values are discarded. `present`
means the runtime reported configured credentials, not that a model call has
succeeded. `modelExecution` remains `not_tested`.

The owner writes `<journal>.watch/status.json` atomically with mode 0600. Schema 1
contains `sessionId`, `pid`, `startedAt`, `updatedAt`, `origin`, `roomId`, `memberId`,
`phase`, `protocol`, `credentials`, `modelExecution`, and an optional `runId`.
The heartbeat refreshes every five seconds, including while idle or executing.
It contains no prompts, answers, tool arguments, tokens, or provider identity.
The status command also reports `processState`, `fresh`, and `stopRequested`.
A missing ownership lock reports stopped; a heartbeat older than fifteen seconds
reports unknown and clears readiness. Native callers must also compare the PID
with their actual child process. Do not infer readiness from an old JSON file.

Stop writes the existing watcher control request and returns immediately. The
caller must still wait for the owned process to exit. A stop request or process
exit alone does not prove that external tool effects were cancelled; Room's
attempt journal and Stop acknowledgement remain the execution authority.

For a compact read-only queue view, use
`ROOM_AGENT_CONFIG=/absolute/room-connection node scripts/agent-resume.mjs --focus assistant`.
This shows this agent's current shared requests, pending input IDs, and Stop/Resume
state without acknowledging, claiming, or executing work. An unchanged room
context version never suppresses current shared requests.

## Native computer use with the shared host

Enable local tools in the Mac app and grant Accessibility and Screen Recording
through its My Mac controls as needed. In the dedicated runtime JSON, add:

```json
"macTools": {
  "command": "/absolute/Project Room.app/Contents/MacOS/ProjectRoomTools",
  "connection": "/absolute/Library/Application Support/Project Room/Local Tools/connection.json"
}
```

Input defaults to `"inputApproval": "prompt"`. This unattended host cannot obtain
interactive approval, so input remains blocked and the shared run reports Needs
input. After explicitly deciding to authorize computer control for this host,
the Mac owner may add `"inputApproval": "approve"` inside `macTools`. This is a
per-tool policy for `mac_input`, not global approval or a shell sandbox change.
Native enablement and OS permissions are still required. A room message cannot
change this private host configuration. A completed model response is not proof
that the requested action happened; structured approval refusals survive restart
and prevent automatic publication as a successful shared result.

This explicitly delegates the configured native tools to the agent selected by
this host's private Room connection. Use it only for a room whose authorized
shared asks may control this Mac. Do not configure it just to enable ordinary
chat. It does not enroll a device for arbitrary rooms or give every room member
personal computer authority. The Mac app and host must remain running; web
participants interact through the existing shared ask, not a browser-to-OS port.

The host exposes only status, app observation, screenshot and input from this
MCP server. It does not add the broker's unsandboxed process/file tools to the
runtime. Native MCP tools have their own owner grant and OS permissions; Codex's
shell sandbox does not constrain those native capabilities. The connection path
is explicit because the runtime uses an isolated HOME. The nonce is not passed
in command arguments or posted to the room. Pause in My Mac revokes local tools.

Use `mac_app_state` first; target its process and window IDs. `mac_input` offers
activate, click, type, key and scroll. Click and scroll require explicit coordinates, normalized 0..1
within the window, top-left origin, independent of screenshot scaling. Activate
is a request, so reobserve before input. Input requires the target app/window to
remain focused. Keyboard input is sent to the target process; clicks use the
session event stream after checking the target at the pointer. A dispatched event does not prove
an app saved or submitted anything: observe the result. Preserve operation IDs
on retry; prepared outcomes after a crash require reconciliation.

Screenshots retain at most eight private PNGs in a dedicated captures directory.
Retention scans those captures rather than the growing operation journal. MCP
returns a separate JPEG image block (up to 1024px and 600KB), so the model can see
it without reading outside its workspace. Image bytes are not repeated in the
text metadata or room history. The model receives the image; `uploaded:false`
means no Room attachment upload, not that the provider never sees it. There is
no continuous screen recording, and only one capture runs at a time.
### Reproduce the bounded live qualification

With an already authenticated dedicated profile, run:

```sh
node scripts/qualify-codex-room.mjs /absolute/runtime.json /absolute/report.json
```

This opt-in check consumes one model turn using synthetic data and a local Room.
It creates a disposable read-only workspace, checks the protocol, publishes one
answer, closes and reopens the host and journal, resumes the same runtime history,
and asserts retry returns the same result without another model turn. It never
uses a production Room connection or imports operator credentials. Its private
fixture/journal are retained for reconciliation if execution is ambiguous.
A passing report does not establish physical sleep/wake, service restart, work
quality or general tool execution. See [the integrated qualification](WORK-INTEGRATION-PLAN.md).


For the separate in-flight transport failure trial, append `--disconnect-after-start`
to the qualification command. It closes the actual dedicated runtime immediately after
start acknowledgement, reopens the journal and runtime, and verifies the original turn
is reconciled without a second model start. An interrupted or unresolved original turn
is reported as such; this does not certify physical sleep/wake or successful completion.

## Platform qualification

See the [execution portability plan and qualification evidence](../archive/docs/plans/EXECUTION-PORTABILITY-PLAN-20261018.md) for the Linux generic host and native Mac Codex boundary.
