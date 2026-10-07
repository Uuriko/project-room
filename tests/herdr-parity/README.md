# herdr parity suite (lane B9) — Phase-A gate

`tests/herdr-parity.test.js` + `tests/herdr-parity/`

The scripted scenario **claim → session → heartbeat → blocked → done** runs
TWICE — once against the legacy session backend, once against the
SessionAdapter contract — and the suite asserts IDENTICAL room-observable
outcomes: claim states, journal entries, API response shapes (claim card,
session card, heartbeat presence record), and event sequences. Any
divergence is a failure with a field-level diff. **Phase B cannot start
until this suite is green** (compat-plan §1, REDESIGN.md §4).

## Layout

| File | Role |
|---|---|
| `../herdr-parity.test.js` | the suite (node:test) |
| `parity-scenario.mjs` | backend-agnostic scenario: the five ops in order |
| `legacy-driver.mjs` | legacy backend: real `server/work-claims.mjs`, real `src/work-item-session.js` projection + `sessionCard`, real `server/agent-heartbeats.mjs` over in-memory SQLite |
| `herdr-driver.mjs` | adapter backend: session events sourced from B2's real `server/session-adapter.mjs` (`InMemorySessionAdapter`), projected through the same claim machine + session projection |
| `virtual-clock.mjs` | deterministic clock shared by both runs — timestamps assert exact-equal, never normalized |
| `room-journal.mjs` | append-only room event journal fixture (fixed vocabulary) |
| `parity-compare.mjs` | trace comparator with JSON-pointer-ish diffs |

## Design notes

- **Claims are backend-agnostic.** Both drivers use the real
  `server/work-claims.mjs` (room-arch mapping #7: UNAFFECTED; REDESIGN §1:
  herdr `done` ≠ claim `done`). The session-execution substrate is what
  differs — that is the seam.
- **Journal order is part of the contract.** Both drivers journal in the
  canonical per-op order; a reordering by a future integration is a
  divergence, not noise.
- **Heartbeat parity** compares the canonical presence record both
  backends project into the room's heartbeat/presence responses
  (`{agentId, hostId, mode, status, lastSeenAt, pendingWakes}`). The herdr
  heartbeat *is* the self-reported `reportState("working")` (the honest
  path); the lane's host transport (`pull-only` here) is a host property,
  unchanged by the session backend.
- **Adapter-internal events** (`pane.created`, `pane.agent_status_changed`,
  …) are recorded in the herdr trace for debugging but excluded from the
  parity verdict — they are not room-observable.
- The real adapter's method set is fixed and closed; optional-tier methods
  answer `supports() === false`. Unknown calls throw — no catch-all doubles.

## B2 dependency — landed

`herdr-driver.mjs` drives B2's real `server/session-adapter.mjs`
(`InMemorySessionAdapter`, merged as PR #1740). The B9-local
`stub-inmemory-adapter.mjs` was deleted when the swap landed; the adapter
contract tests in the suite (version-mismatch fail-closed, occupant pinning,
unknown-state rejection) run against the real implementation.

## Running

From the worktree root:

```
TMPDIR=<worktree>/.tmp node --test tests/herdr-parity.test.js
```
