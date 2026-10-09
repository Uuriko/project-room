# Agent lifecycle: agent-connection.mjs, agent-setup.mjs, agent-resume.mjs, agent-wake.mjs

## agent-connection.mjs — credential custody

**Purpose.** Read, validate, and persist the agent's connection (origin/room/member/token) with filesystem-level secrecy. Never a key issuer, never a rotation operation.

**Data flow.** `readConnectionInput(stdin)` (pipe from a secret manager; refuses TTY) | `readAgentConnection(directory)` (private dir + `connection.json`, `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, 4096-byte cap) | `saveAgentConnection(directory, value)` (new dedicated dir only — `mkdir 0700`, `open "wx" 0600`, so an existing connection is **never overwritten**; `EEXIST` → `config_exists`) | `agentConnectionFromEnvironment(env)` (exactly one source: `ROOM_AGENT_CONFIG` dir **or** `ROOM_AGENT_*` vars, never mixed — `ambiguous_config`). `connectionDiagnostic(error)` maps any error to a user-facing `{type, code, message, status, reason, hint, next}`.

**Invariants.**
- `privateStat`: regular file, `nlink === 1`, mode has no group/other bits, owned by `process.getuid()`. Symlinks and hardlinks are refused (`config_not_private`).
- `validate()`: exactly the 5 fields, `version === 1`, plus a trial `new RoomAgentClient(value)` — construction failure means invalid config.
- Token shape: `pri_` + 43 base64url chars (enforced transitively by the client constructor).

**Gotchas.**
- The `"wx"` flag in `saveAgentConnection` is the overwrite guard — dropping it to `"w"` silently replaces an existing connection and the suite does **not** catch it (mutation M4 survived — test gap; hardening test recommended).
- The flipped-uid mutant (M3) is killed, so the ownership check is covered.
- `connectionDiagnostic`'s `rate_limited` branch only echoes `retryAfterMs` when it is a safe integer within 0–300000.

## agent-setup.mjs — first connection / invite redemption

**Purpose.** Turn an invite code, share link, or room URL into a saved connection: `setupTarget()` parses the target; `connectRoom()` runs the resumable multi-step setup (identity import or mint, invite preview → accept, identity creation, room list, invite redemption or access request, agent-key issuance, connection save).

**Data flow.** All mutation inputs are saved to the setup journal **before** the first request; repeating the operation resumes the same identity and admission, never silently replacing a connection. Per-destination state is keyed by `sha256(destination)` in `saved.targets` (cap: 100 destinations — off-by-one to 101 survives the suite, test gap M14). `step.requestId` is stable across retries; redemption is verified against the approved preview (`roomId`, `identityId`, sorted permissions must match).

**Invariants.** Journal writes go through `openSetupJournal` (private dir + owner sqlite lock + `setup.json`, 128 KiB cap). `canonicalOrigin` maps getdasha.com aliases to `ROOM_ORIGIN`. `connectRoom` never overwrites an existing differing connection (`"Existing connection differs; nothing was replaced"`).

**Gotchas.** `issuerFields["tok"+"en"]` is split to avoid a literal secret key name in source. `setupTarget` is the most security-sensitive parser here: it must reject sign-in links and bare room URLs that are not agent access.

## agent-resume.mjs — read-only re-orientation

**Purpose.** `resumeAgent()` rebuilds an agent's working context after restart: bounded reads of room context, needs-me attention (≤5 pages), and open reply requests. Source cursors are observations, never acknowledgements.

**Data flow.** `contextRead()` (strict shape validation, contractVersion 1) → `project()` (authority summary, obligations, own claims, nextReads) → attention pages (`/api/needs-me`, cursor ≤16 KiB, items ≤100) → optional `focus: 'replies'` open-request listing → fresh context read to detect changes. Every response is byte-bounded (`maxResponseBytes` default 256 KiB, `boundedFetch` with manual reader loop); `safe()` throws if the output ever contains the bearer token.

**Invariants.** `checkedCursor`: known keys only, ≤500 entries per map. `viewerAccountId/AuthEpoch/SessionBinding/SessionRevision` must be null (agent identity, not a user session). `sinceVersion` short-circuits to `reuse_same_version_local_context`.

**Gotchas.** Failures are recorded per-source in `incompleteSources` — a partial resume is a normal return, not an exception. The token-leak guard (`safe()`) runs on the serialized output, catching leaks through IDs/cursors too.

## agent-wake.mjs — wake hints (non-consuming)

**Purpose.** `AgentWakeClient` for heartbeat registration, long-poll wake waits, and signal acks. Wake hints are observations; cursors never mean handled work.

**Data flow.** `doctor({hostId})` → `setup({hostId, cadenceSeconds})` → `wait({hostId, cadenceSeconds, waitMs ≤ 55000, …})` (resume-before + poll + resume-after) → `ack({signalIds})` (1–50 unique valid ids). All responses are shape-validated (`signals()`), byte-capped at 256 KiB, and rejected if they echo the token.

**Invariants.** `hostOptions`: hostId charset `[A-Za-z0-9._-]`, positive finite cadence. `ack` requires the server's `acknowledged` list to be a subset of the requested ids with no duplicates.

**Gotchas.** `wait()` registers the host (`setup`) before polling — a crash between setup and poll leaves a registered-not-listening host, which `doctor` reports honestly.
