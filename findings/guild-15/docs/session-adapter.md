# Session adapter (herdr redesign seam)

Sources: `server/session-adapter.mjs`, `server/session-adapter/herdr-bridge-adapter.mjs`
(+ `BRIDGE-API.md`, `pinned-herdr.json`).

## The seam

This module is the **only** place Project Room code may know about session
backends. Callers code against the `SessionAdapter` domain interface — never a
backend's wire protocol, socket paths, or field names. Swapping the backend
never touches callers.

**Worker-safety**: the module must stay runnable inside a Cloudflare Worker —
no sockets, no subprocesses, no Node builtins; only
`globalThis.crypto.randomUUID` with a `Math.random` fallback.

## Backends

- `InMemorySessionAdapter` (this file) — hermetic backend for Worker tests,
  dev, and the fail-closed fallback. Passes the shared contract suite.
- `HerdrBridgeAdapter` (`session-adapter/herdr-bridge-adapter.mjs`, B4 lane) —
  Worker-side HTTPS client to `bridge/herdr-bridge.mjs`, translating to herdr's
  Unix-socket protocol on lane-worker hosts. Pinned protocol/binary versions
  in `pinned-herdr.json`; `BRIDGE-API.md` documents the bridge surface.

## Design principles

1. **Self-reported state, never screen-scraping.** Lane states
   (`working | blocked | idle | done | unknown`) are declared by workers via
   `reportState`. Detection events are hints, never authoritative.
2. **Fail closed on version mismatch.** `connect()` asserts the pinned
   protocol AND binary versions plus the core method list; any drift throws
   `VersionMismatchError`. No downgrade, no guessing.
3. **The adapter owns subscription recovery.** On `events_lost` it re-runs
   `snapshot()`, calls `onReconcile`, then resumes — callers never see a
   silent gap.
4. **Continuity without transcript replay.** `spawnAgent` resumes via the
   agent CLI's own `--resume` flags (`resumeSessionRef` / `resumeCommand`);
   the conversation lives in the CLI's session store.
5. **herdr `done` ≠ claim `done`.** The adapter reports agent states; the
   claims board stays authoritative for work completion.

## Domain types

- `AgentState`: `working | blocked | idle | done | unknown`
- `AgentHandle`: `{ id, paneId, occupantId }` — `occupantId` pins send/wait
  calls to the pane occupant present when the handle was issued
- `AgentInfo`: full inventory record (`getAgent`)
- `PaneText`: `{ paneId, source, lines, text }` (`PANE_SOURCES`: `visible |
  recent | recent-unwrapped | detection`)
- `WorkspaceSnapshot`: `{ version, workspaces: [{ name, tabs: [{ name, panes:
  [{ id, workspace, tab, title, agentId, occupantId, state, kind }] }] }] }`
- `Subscription`: `{ id, active, close(): Promise<void> }`

## Core methods (all backends)

`connect disconnect ping snapshot spawnAgent listAgents getAgent closePane
readPane sendText sendKeys waitForState waitForOutput reportState reportResume
reportMetadata subscribe waitForEvent supports`

Resume args are bounded: `MAX_RESUME_ARGS` 64, `MAX_RESUME_BYTES` 8 KiB.

## Error taxonomy

Every error extends `SessionAdapterError` with `adapter: "session-adapter"`
plus the backend name:

| Class | Meaning | Caller action |
|---|---|---|
| `VersionMismatchError` | pinned vs observed protocol/binary drift, or core method missing at connect | fail closed, refuse to start |
| `OccupantChangedError` | pane occupant changed since the handle was issued | re-resolve handle, re-confirm, resend |
| `SubscriptionLostError` | event history overrun upstream | auto-recovers (re-snapshot + reconcile + resubscribe); surfaced to `onReconcile` only |
| `MethodUnsupportedError` | optional-tier method not advertised | degrade explicitly, never silent no-op |
| `TransportError` | not connected / dropped mid-operation | retriable per caller policy; `ping()` first |
| `TimeoutError` | `timeoutMs` exceeded | waits accept `AbortSignal`; abort → `TimeoutError` |
| `ServerError` | backend error payload | `code` preserved |

## Contract

`tests/session-adapter-contract.test.js` runs the same assertions against
every backend. A backend that cannot satisfy a clause must document the skip
per-test in that file — never silently.

## Gotchas

- `waitForState`/`waitForOutput` need explicit `timeoutMs`; an aborted wait
  surfaces as `TimeoutError`, not `AbortError`.
- The in-memory backend keeps a 2000-line pane buffer (`PANE_BUFFER_LINES`);
  `detection` source is the bottom-buffer view.
