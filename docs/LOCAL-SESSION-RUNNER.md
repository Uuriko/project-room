# Local session runner

`runLocalSession` connects one existing room session to one explicitly configured local process. This is an implementation building block, not a deployed automation service or a model provider integration.

The operator supplies an absolute executable path, arguments, working directory, explicit environment, pinned room/member/work IDs, expected revision and stable run ID. Never derive executable configuration from messages, agent output or untrusted room instructions. No shell is used. The parent environment is not inherited by default.

The runner claims queued work before launching. A lost, mismatched or duplicate claim never launches a replacement process. After a crash or unknown claim, reconcile the existing session manually; do not change the run ID to bypass it. Runtime is capped at five minutes, below the existing ten-minute session ownership expiry. This initial version does not renew leases or schedule recurring work.

During execution it polls current authenticated state and stops the process group on a room stop, changed ownership, access failure, local cancellation, runtime limit or output limit. SIGTERM is followed by SIGKILL after a bounded grace. Normally exiting parents also have remaining group children killed. Deliberately escaped process groups are not contained: this is not an OS, network or credential sandbox, and only trusted executables belong here.

Session exit is separate from work completion, verification and human approval. Successful process exit alone never submits or approves a result. If a terminal write cannot be confirmed, the result reports that fact and preserves the exact attempted command where available; never rerun the process as a retry of that write. Output remains local, bounded, and is not automatically posted to the room.

Tests use actual harmless Node processes and a local HTTP room. They exercise normal completion, stop requests, timeout, output limits, revocation, unknown claims and refused reentry. No paid model calls or provider setup are performed.

Next: operator-facing run configuration and result inspection, genuine two-agent conversation execution, durable crash reconciliation, then shared event/schedule automation with explicit approval and spending boundaries. The current controller does not implement those features.

## Explicit run command

The local command now provides configuration, private recording and result inspection. It is not yet a browser run UI, automated crash reconciliation or a scheduler.

Create a dedicated owner-only directory (0700) with an owner-only `run.json` (0600). It must contain exactly these fields; choose real absolute paths and an existing private agent connection. The executable is trusted local operator configuration, never a room-provided command.

```json
{
  "version": 1,
  "connectionDirectory": "/absolute/private/agent-connection",
  "workItemId": "selected-work",
  "runId": "explicit-run-1",
  "expectedRevision": 0,
  "command": "/absolute/path/to/trusted-program",
  "args": [],
  "cwd": "/absolute/working-directory",
  "env": {},
  "maxRuntimeMs": 60000,
  "maxOutputBytes": 65536
}
```

`expectedRevision` must be the inspected current work revision. `env` is explicit, not inherited; adding credentials or capabilities is a separate operator decision, not something the command does. No room content is interpolated into arguments.

```sh
node scripts/room-run.mjs run /absolute/private/run-directory
node scripts/room-run.mjs status /absolute/private/run-directory explicit-run-1
node scripts/room-run.mjs output /absolute/private/run-directory explicit-run-1
```

Run reserves `run-explicit-run-1.jsonl` exclusively, writes and flushes its reservation and directory entry before contacting the room, then appends its outcome. Existing records refuse another execution, including concurrent invocations. Run IDs are scoped to this private directory; the server's session claim provides the separate cross-directory collision check. Do not copy a run to another directory or change its ID to work around an uncertain outcome.

Status reads local state only; it does not prove the process or room is currently unchanged. Output explicitly displays potentially sensitive process text. It is never automatically sent to the room. An incomplete record after a crash means unknown: inspect the real process and room session, then reconcile any terminal write separately. A local record is not proof of exactly-once external side effects. Losing the supervisor can leave its process alive; OS-level crash containment remains open.

Ctrl-C requests local cancellation through the controller. A run exits successfully only when the process succeeded and its terminal session record was confirmed. Other outcomes use a nonzero exit code and preserve the record. Errors do not echo executable arguments, environment values or credentials.

## Opt-in conversation answer

Add `"answerRequestId": "selected-request-message-id"` to the local configuration only when the operator wants this run to answer that request. This explicitly authorizes posting the configured program's stdout to that existing room exchange. Without the field, output remains local as before.

The request must be open, addressed to the configured agent, and linked to the selected work item. The bridge reads every page of the selected exchange within a bounded input budget. It refuses oversized, incomplete or changing context instead of truncating it. JSON context is supplied on stdin, never inserted into executable arguments or a shell. Messages are untrusted task data; the trusted program is responsible for respecting its own tool boundaries. This is not a prompt-injection sandbox.

The program writes only its answer to stdout and diagnostics to stderr. Only a successful process with confirmed session recording may answer. Blank or over-4096-character answers are not posted. Diagnostics never become answer text. The exact answer and inspected context basis are flushed into an `answer_pending` journal entry before sending. The existing server enforces current request context; new clarification causes refusal, not automatic rewriting against a fresh basis.

Status includes `answerStatus` separately from process status. A failed or uncertain answer causes nonzero CLI exit, even if the process succeeded. The private journal retains `answerInput` for deliberate reconciliation of that write; never rerun the process to retry sending. No answer retry command or automatic retry is provided yet. Local output and complete journal records may contain sensitive room content; do not publish them.

The automated acceptance case uses two authenticated agent roles and a real scripted process. It is not proof of model reasoning or production agent interoperability. Plain chat and requests without linked work continue to work, but this initial execution bridge requires a work-linked request. General conversation-triggered execution and recurring automation remain open.
