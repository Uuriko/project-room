# Session Adapter — the herdr seam contract

How Project Room talks to herdr without ever being coupled to it.
Design source: `~/workspace/goals/project-room-herdr-redesign/REDESIGN.md` §2.2,
`phase1/seam-design.md` (interface spec, pinning policy).

**Status: the code does not exist yet.** Every file path, module, and env var in
this document refers to the Phase-3 build. References that are still unlanded
are marked `(pending B<n>)`. Only the *contract* described here is stable —
the lane consultation settled it, and B2–B8 implement against it.

## 1. The seam

Project Room codes against one domain interface — `SessionAdapter` — defined in
`server/session-adapter.mjs` (pending B2). herdr wire details (Unix socket,
newline-delimited JSON, protocol v22 field names, subscription semantics) live
inside that module only. No other room module imports herdr socket details,
field names, or protocol constants.

```
┌─ Cloudflare Worker (room.trydemigod.com) ─────────────┐
│  room code → SessionAdapter (domain interface)          │
│        │  HTTPS + bearer, per-tenant route auth         │
└────────┼───────────────────────────────────────────────┘
         ▼
┌─ Lane-worker host ─────────────────────────────────────┐
│  bridge/herdr-bridge.mjs (pending B3)                  │
│        │  Unix socket                                  │
│        ▼                                              │
│  Uuriko/herdr server (fork binary, hermetic)           │
└───────────────────────────────────────────────────────┘
```

Production is a Cloudflare Worker (`cloudflare/wrangler.jsonc`) — a Worker has
no PTYs, no Unix sockets, no persistent processes, so herdr **cannot run inside
the Worker**. The adapter therefore splits in two:

- **Worker side** — `server/session-adapter.mjs` (pending B2): the domain
  interface plus `InMemorySessionAdapter` (tests/dev). Worker-safe: **no
  `node:net`, no Unix sockets, no `child_process`** in this module.
- **Transport** — `HerdrBridgeAdapter` (pending B4): Worker-side client
  implementing the `SessionAdapter` interface over authenticated HTTPS to the
  bridge. Falls closed to legacy behavior when the bridge/broker is
  unreachable (see §6).
- **Host side** — `bridge/herdr-bridge.mjs` (pending B3): runs on lane-worker
  hosts as plain Node (this is where `net.createConnection` lives),
  translating the domain API to herdr's Unix-socket JSON protocol locally.

`createSessionAdapter(opts)` returns the `SessionAdapter` (§3). Options:

```ts
interface AdapterOptions {
  socketPath?: string;            // default: ~/.config/herdr/herdr.sock
  pinnedProtocolVersion: number;  // exact pin, e.g. 22. No ranges.
  pinnedHerdrVersion?: string;    // exact binary version (from server banner)
  connectTimeoutMs?: number;      // default 10_000
  reconnect?: { enabled: boolean; backoffMs: number[] }; // default on for subscribe only
  onVersionMismatch?: (info: VersionInfo) => void; // observer; mismatch still throws
}
```

## 2. Pinning (fail closed on version mismatch)

The pin file `server/session-adapter/pinned-herdr.json` (pending B2/B4):

```json
{ "herdrVersion": "<exact tag>", "protocolVersion": 22,
  "forkCommit": "<sha of Uuriko/herdr master we test against>",
  "binarySha256": "<sha256 of the herdr binary we ship/install>" }
```

Rules (from `phase1/seam-design.md` §6):

- `connect()` asserts pinned protocol version AND binary version; any drift →
  `VersionMismatchError`, fail closed. No connection object is returned usable.
- Install only from our fork (https://github.com/Uuriko/herdr) at the pinned
  commit, checksum-verified at install. Never `latest`, never upstream's
  HEAD-fetcher.
- Upgrades are lane-claimed, never automatic: bump the pin in a branch, run
  the full contract suite + smoke, open a PR.
- Build-break conditions: protocol ≠ pin · binary ≠ pin · `binarySha256`
  mismatch at install · core method missing from the advertised method list ·
  upstream schema hash drift without a pin bump.

## 3. Method reference (contract; pending B2)

All names verified against `phase1/seam-design.md` §2.1–§2.6.

**Lifecycle**

| Method | Signature | Semantics |
|---|---|---|
| `connect` | `connect(): Promise<void>` | Opens the socket, runs the handshake, reads the server's advertised protocol version + method list. **Asserts pinned versions; throws `VersionMismatchError` on mismatch.** Emits `connected`. |
| `disconnect` | `disconnect(): Promise<void>` | Closes all subscriptions, then the socket. Idempotent. |
| `ping` | `ping(): Promise<PingResult>` | `{ ok, protocolVersion, herdrVersion }`. Health checks. |
| `snapshot` | `snapshot(): Promise<WorkspaceSnapshot>` | Full bootstrap: workspaces → tabs → panes → agents. The reconciliation source of truth after `events_lost`. |

`protocolVersion` getter returns the negotiated, connect-asserted version.

**Spawning and inventory**

| Method | Signature | Semantics |
|---|---|---|
| `spawnAgent` | `spawnAgent(opts: SpawnOptions): Promise<AgentHandle>` | Launches the agent in a herdr pane. Resume goes through the agent CLI's **own** `--resume` flags (`resumeSessionRef` / `resumeCommand`, ≤64 args) — conversation continuity is the CLI's session store, **never transcript replay**. The bridge constructs `agent.start` argv from allowlisted kinds only (pending B3) — no caller-supplied argv/env. |
| `listAgents` | `listAgents(): Promise<AgentInfo[]>` | Inventory + state rollup. |
| `getAgent` | `getAgent(agentId: string): Promise<AgentInfo>` | Single agent detail. |
| `closePane` | `closePane(paneId: string): Promise<void>` | Closes the pane. Agent teardown is the agent's own exit. |

**Reading and sending**

| Method | Signature | Semantics |
|---|---|---|
| `readPane` | `readPane(paneId, source, opts?): Promise<PaneText>` | Text snapshot for supervisors. `source ∈ {"visible","recent","recent-unwrapped","detection"}`. `detection` = bottom-buffer view detection uses. No keystroke injection. |
| `sendText` | `sendText(agentId, text, opts?: { wait?: SendWait }): Promise<SendResult>` | Sends text; optional event-driven wait until target states. **Occupant-pinned**: rejects with `OccupantChangedError` if the pane occupant changed since the handle was obtained. |
| `sendKeys` | `sendKeys(agentId, keys: string[]): Promise<void>` | Raw key injection (same occupant pinning). Supervisor flows only (approvals, interrupts); normal messaging uses `sendText`. |
| `waitForState` | `waitForState(agentId, states, opts: { timeoutMs, signal? }): Promise<AgentState>` | Event-driven wait for blocked/done/idle. Pins the occupant. **Prefer over polling pane output.** |
| `waitForOutput` | `waitForOutput(paneId, regex, opts: { timeoutMs }): Promise<MatchedOutput>` | Regex wait on snapshots. For non-agent processes. |

**Self-reported state (the honesty path)**

Lane states are reported explicitly by lane workers. herdr never infers them
for us; herdr screen-detection manifests are consumed as *hints*, never as
authoritative lane state.

| Method | Signature | Semantics |
|---|---|---|
| `reportState` | `reportState(paneId, state, detail?): Promise<void>` | Worker declares `working` / `blocked` / `idle` / `done`. **Authoritative for lane state.** herdr `done` ≠ claim `done` — the adapter never settles claims; the claims board (`server/work-claims.mjs`: `unclaimed → claimed → in_progress / blocked → done`) stays authoritative. |
| `reportResume` | `reportResume(paneId, ref: { sessionRef, resumeCommand }): Promise<void>` | Stores the agent's native session ref + resume command (≤64 args, 8 KiB cap). |
| `reportMetadata` | `reportMetadata(paneId, meta, opts?: { ttlMs? }): Promise<void>` | Display-only titles, labels, tokens with TTL. |

**Events with adapter-owned reconciliation**

| Method | Signature | Semantics |
|---|---|---|
| `subscribe` | `subscribe(eventNames, handler, opts?: { onReconcile? }): Promise<Subscription>` | Push feed (`pane.agent_status_changed`, `pane.agent_detected`, `pane.output_matched`, pane/workspace/tab lifecycle, `layout.updated`, `worktree.*`). **The adapter owns recovery**: on `events_lost` it re-runs `snapshot()`, calls `onReconcile(snapshot, lostCount)`, then resubscribes. Callers never see a silent gap. |
| `waitForEvent` | `waitForEvent(filter, opts: { timeoutMs }): Promise<RoomEvent>` | One-shot event wait on a dedicated connection. |

**Capability negotiation** — `supports(method: string): boolean`. The adapter
reads the server's advertised method list at connect. Missing optional-tier
method (worktree, layout export/apply) → `MethodUnsupportedError`, never a
silent no-op. Core tier (connect/ping/snapshot/spawn/read/send/wait/subscribe/
report/close) is non-optional: absence at connect time → `VersionMismatchError`.

## 4. Error taxonomy (contract; pending B2)

Verified against `phase1/seam-design.md` §3. All errors carry
`adapter: "session-adapter"`, `backend: "herdr"` (or `"inmemory"`), and the
pinned-vs-observed version pair where relevant.

| Class | When | Recovery |
|---|---|---|
| `VersionMismatchError` | Server protocol ≠ pinned, core method missing, binary ≠ pinned | **None — fail closed.** Log, alert, refuse to start. Never downgrade to a guessed version. |
| `OccupantChangedError` | `sendText`/`sendKeys`/`waitForState` target's pane occupant changed | Re-resolve the agent handle, re-confirm intent, resend. |
| `SubscriptionLostError` | Event history overrun upstream of adapter recovery | Adapter auto-recovers (re-snapshot + reconcile + resubscribe). Surfaced to `onReconcile` observers only. |
| `MethodUnsupportedError` | Optional-tier method not advertised | Caller degrades explicitly (feature flag off). |
| `TransportError` | Socket closed/refused mid-operation | Retriable per caller policy; `ping()` to re-verify before resuming work. |
| `TimeoutError` | Any `timeoutMs` exceeded | Caller decides; waits are abortable via `AbortSignal`. |
| `ServerError` | Upstream returned an error payload | Passthrough with upstream `code`/`message` preserved. |

## 5. Backend implementations

- **`InMemorySessionAdapter`** (pending B2) — passes the same contract suite
  (`tests/session-adapter-contract.test.js`); Worker tests stay hermetic.
- **`HerdrBridgeAdapter`** (pending B4) — the HTTPS transport to
  `bridge/herdr-bridge.mjs` (pending B3); implements the identical
  `SessionAdapter` surface over bearer-authenticated HTTPS with per-tenant
  route auth.
- Contract suite runs against **every** backend. `InMemorySessionAdapter`
  fidelity: per-test skips are documented in the test file, never silent.

## 6. Degradation table — broker unreachable (pending B4)

The fail-closed rule (`phase1/compat-plan.md` §3, REDESIGN.md §4): if the herdr
backend is unreachable, slow, or throws, the room behaves exactly as today.
Every seam call is wrapped `try { herdr } catch → legacy` with the fallback
logged to room diagnostics (never user-visible), and herdr calls carry a
timeout (suggest 2s, B4 tunes) so a hung fork degrades to legacy rather than
hanging the request. With the flag off the wrapper is not even entered —
legacy latency and error behavior are bit-identical.

| Method | Broker unreachable → degraded behavior |
|---|---|
| `connect` | Throws `TransportError`; no herdr session object is created. Callers stay on the legacy session backend. |
| `disconnect` | No-op (nothing connected). |
| `ping` | `{ ok: false }`-equivalent; broker health recorded to `herdr_backend_state` (pending B5). |
| `snapshot` | Returns the legacy session inventory view. |
| `spawnAgent` | Spawns a **legacy** session; a diagnostics note records the fallback in `herdr_session_journal` (pending B5). The claim proceeds — a backend outage never blocks claiming. |
| `listAgents` / `getAgent` / `closePane` | Legacy-backed equivalents; closePane closes the legacy pane. |
| `readPane` | Legacy pane-output read. |
| `sendText` / `sendKeys` | Routed to the legacy session; occupant-pinning is inapplicable to the legacy path and is **not** simulated. |
| `waitForState` / `waitForOutput` | Legacy-path waits (heartbeat/poll semantics), same timeout semantics. |
| `reportState` / `reportResume` / `reportMetadata` | Recorded on the legacy session's state store; `reportState` remains authoritative for lane state. |
| `subscribe` | Falls back to the legacy event stream (`GET /api/rooms/{roomId}/events`, `/stream` SSE). No `events_lost` recovery needed on the legacy path (durable server-side cursor). |
| `supports` | Returns `false` for all herdr-tier methods on the fallback path. |

Invariant: fallback never writes partial herdr state and then legacy state for
the same operation — the seam commits to one backend per operation before
mutating.

## 7. Worker-safety constraints

- `server/session-adapter.mjs` (pending B2) is **Worker-safe**: no `node:net`,
  no Unix sockets, no `child_process`, no dynamic `require` of Node builtins.
  The `HerdrBridgeAdapter` transport (pending B4) speaks HTTPS only.
- `node:net` / socket code lives **only** in `bridge/herdr-bridge.mjs`
  (pending B3), which never ships to the Worker.
- Every seam call is timeout-bounded; the room's request path never depends on
  fork liveness.
- No caller-supplied `agent.start` argv or env: the bridge constructs argv from
  allowlisted agent kinds only (pending B3).
- PTY output crossing the seam is display-sanitized: VT escape sequences are
  stripped/escaped before pane text reaches room UI (ANSI injection is a
  residual risk — see risk-register note in §9).
- Occupant pinning is mandatory on `sendText`/`sendKeys`/`waitForState` for the
  herdr path; cross-pane send is never exposed (see §8).

## 8. Never-expose blocklist (bridge enforces; pending B3)

From `phase1/risk-review.md` §1.3 — the bridge refuses these even if room code
asks. Deny-by-default, fail-closed, every call audit-logged with secret
redaction.

| Blocked | Why |
|---|---|
| `server.*` (incl. `server.stop`, reload paths) | Kills every tenant's sessions (one-call DoS); config reload = coordination-integrity attack |
| `plugin.*` | Remote package fetch = supply-chain + arbitrary code execution |
| `integration.*` | Per-agent native integrations = persistence + code execution as server UID |
| `worktree.*` | `create` clones arbitrary git URLs (egress/disk/supply-chain); `remove` = data destruction |
| `layout.apply` | Applies cwd/env — environment injection (`PATH`/`LD_PRELOAD` hijack) |
| `notification.show` | Toast spam / social-engineering text on shared hosts; the room has its own notification rails |
| raw cross-pane `pane.send_text` / `send_keys` / `send_input` | Cross-pane injection: driving another tenant's live session |

**Allowlist:** tenant-scoped reads, occupant-pinned `sendText`/`sendKeys`/
`waitForState`, adapter-constructed `agent.start` argv from allowlisted kinds.
`worktree.*` and `layout.apply` are never exposed raw; `worktree`/`layout.export`
(read-only) are `supports()`-gated optional tier.

Isolation posture (pending B1/B3): one herdr server per tenant, distinct OS UID
per tenant, per-tenant `0700` socket directories, per-tenant `TMPDIR`,
cgroup/disk quotas. Caller-supplied IDs are untrusted input. Named-session
separation is unproven until the fork audit says otherwise — process-per-tenant
is the default (pending B10).

## 9. Honesty rules (binding)

- **Self-reported state only.** `reportState` is authoritative. Detection
  manifests are heuristics; their events are hints, never lane state.
- **herdr `done` ≠ claim `done`.** herdr must never settle claims. Claim
  lifecycle states (`server/work-claims.mjs`) are the only truth about work.
- **Never treat agent working/blocked/done as an auth or payment signal**
  (state is spoofable — `pane.report_agent` can be faked by the pane itself;
  see `phase1/risk-review.md`).
- **Operator can read everything** (by design — supervision). This is
  disclosed, not hidden.
- **Money modules stay honest:** herdr tiers add no new payment semantics;
  the room's money surfaces carry their existing honest sentence and are
  untouched by this seam.

## 10. What calls this

- Supervision backend: `server/supervision.mjs`, `server/supervision-sqlite.mjs`,
  `server/supervision-routes.mjs` (pending B5/B6) — 9 routes under
  `POST/GET /api/rooms/{roomId}/supervision/cards*`, all derived from existing
  tables/events, additive only.
- Session tables (pending B5, all in `unfencedAdditiveTables` in
  `server/writer-fence.mjs`): `herdr_sessions` (fork session id ↔ room/member/
  claim linkage), `herdr_session_journal` (append-only: create/attach/
  heartbeat/detach/fallback — the integrity gate), `herdr_lane_optin`
  (per-lane `sessionBackend: "herdr"` markers), `herdr_backend_state`
  (fork health + degradation log).
- Flag `ROOM_HERDR_SESSIONS` (pending B4): `off` (default) | `on` |
  room allowlist. Global flag AND per-lane marker are both required for any
  herdr session to exist; the global flag is the kill switch.

See also: `docs/HERDR-OPERATOR-RUNBOOK.md` (deploy + incident playbook),
`THIRD_PARTY.md` (fork attribution), `docs/ERROR-TAXONOMY.md` (room-wide
error conventions).
