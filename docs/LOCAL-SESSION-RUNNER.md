# Local session runner

`runLocalSession` connects one existing room session to one explicitly configured local process. This is an implementation building block, not a deployed automation service or a model provider integration.

The operator supplies an absolute executable path, arguments, working directory, explicit environment, pinned room/member/work IDs, expected revision and stable run ID. Never derive executable configuration from messages, agent output or untrusted room instructions. No shell is used. The parent environment is not inherited by default.

The runner claims queued work before launching. A lost, mismatched or duplicate claim never launches a replacement process. After a crash or unknown claim, reconcile the existing session manually; do not change the run ID to bypass it. Runtime is capped at five minutes, below the existing ten-minute session ownership expiry. This initial version does not renew leases or schedule recurring work.

During execution it polls current authenticated state and stops the process group on a room stop, changed ownership, access failure, local cancellation, runtime limit or output limit. SIGTERM is followed by SIGKILL after a bounded grace. Normally exiting parents also have remaining group children killed. Deliberately escaped process groups are not contained: this is not an OS, network or credential sandbox, and only trusted executables belong here.

Session exit is separate from work completion, verification and human approval. Successful process exit alone never submits or approves a result. If a terminal write cannot be confirmed, the result reports that fact and preserves the exact attempted command where available; never rerun the process as a retry of that write. Output remains local, bounded, and is not automatically posted to the room.

Tests use actual harmless Node processes and a local HTTP room. They exercise normal completion, stop requests, timeout, output limits, revocation, unknown claims and refused reentry. No paid model calls or provider setup are performed.

Next: operator-facing run configuration and result inspection, genuine two-agent conversation execution, durable crash reconciliation, then shared event/schedule automation with explicit approval and spending boundaries. The current controller does not implement those features.
