# herdr adapter seam — integration contract (lane T1)

**Status:** test-lane contract, 2026-10-06. These are the assertions in
`tests/adapter-seam-integration.test.js`; B2 (adapter), B3 (bridge), and
B4 (worker wiring) must satisfy them. Fixture routes below mirror
`phase2/design-docs/bridge-transport.md` §1.1 (D3); the only deliberate
delta is the factory's `fallback`/`onDegraded` options, which make the
connect-time fail-closed rule (D3 §2.3, compat-plan §3) testable.

## Chain under test

```
test → createSessionAdapter({ transport:'bridge', ... })   [B2/B4]
     → HTTP (this contract) → fake bridge [tests/fixtures/fake-herdr-bridge.mjs]
     → Unix socket NDJSON  → fake herdr   [tests/fixtures/fake-herdr-socket.mjs]
```

## Factory contract (B4)

```js
import { createSessionAdapter } from '../server/session-adapter.mjs';

const adapter = await createSessionAdapter({
  transport: 'bridge',            // 'bridge' | 'socket' | 'inmemory'
  bridgeUrl: 'http://127.0.0.1:PORT',
  bridgeToken: '...',            // Authorization: Bearer <token>
  tenantId: 'lane-x',
  pinnedProtocolVersion: 22,     // exact; drift → VersionMismatchError
  pinnedHerdrVersion: '0.14.2',  // exact; drift → VersionMismatchError
  connectTimeoutMs: 10_000,      // connect incl. ping + version assert
  requestTimeoutMs: 15_000,      // per-call ceiling (waits use their own timeoutMs)
  fallback: <SessionAdapter>,    // optional: fail-closed-to-legacy at connect()
  onDegraded: (info) => {},      // optional: { phase:'connect'|'method', op, reason, detail }
});
await adapter.connect();         // asserts pinned versions + core methods; throws VersionMismatchError
```

- Error classes (names asserted): `VersionMismatchError`,
  `OccupantChangedError`, `SubscriptionLostError`, `MethodUnsupportedError`,
  `TransportError`, `TimeoutError`, `ServerError`. All carry
  `adapter: 'session-adapter'` and `backend: 'herdr'`.
- `spawnAgent` returns `{ agentId, paneId, occupantToken, ... }` — the
  handle pins the occupant; later `sendText`/`sendKeys`/`waitForState` with a
  stale occupant reject with `OccupantChangedError` (bridge 409
  `occupant_changed`).
- `subscribe(eventNames, handler, { onReconcile })`: herdr
  `pane.agent_status_changed` maps to domain
  `{ name:'agent.state_changed', agentId, paneId, state, previousState, occupantToken }`;
  on socket `events_lost`, the adapter re-snapshots via the SAME bridge,
  calls `onReconcile(snapshot, lostCount)`, then resubscribes (a fresh
  `GET /v1/events`). Callers never see a silent gap.
- Bridge unreachable at `connect()` **with** `fallback` → connect resolves,
  calls serve from legacy, `onDegraded({ phase:'connect', reason:'bridge_unreachable' })`.
  **Without** fallback → `connect()` rejects `TransportError`.
- Bridge dying mid-session → calls reject `TransportError`; never a silent
  mid-session downgrade to legacy (D3 §2.3 all-or-nothing rule).
- `waitForState`/`waitForOutput` timeout → `TimeoutError`. Malformed socket
  frames (bridge 502 `transport_error`/`malformed_frame`) → `TransportError`,
  always settled within `requestTimeoutMs` — never a hang.
- `supports('agent.start') === true`; `supports('worktree.create') === false`
  when not advertised. Missing core method at connect → `VersionMismatchError`.

## Fixture contracts

- Socket wire: `tests/fixtures/fake-herdr-socket.mjs` header documents the
  NDJSON frames (hello banner, `{id,method,params}` → `{id,ok,result|error}`,
  pushed `{"type":"event",...}` / `{"type":"events_lost",...}`).
- Bridge routes + error mapping: `tests/fixtures/fake-herdr-bridge.mjs`
  header. Auth is a static bearer in the fixture (D3's HMAC-derived
  per-tenant token is B3's production concern, out of scope here).
- Legacy stand-in: `tests/fixtures/fake-legacy-adapter.mjs`; results tagged
  `backend:'legacy'` so tests assert which backend served.
