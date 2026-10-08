# herdr Sessions for Lanes

herdr sessions give a lane a durable process home: the worker runs inside a
real PTY that survives supervisor restarts, the lane reattaches to the same
run after a disconnect, and the lane's own `working` / `blocked` / `idle` /
`done` reports become the authoritative lane state. The claims board stays
authoritative — herdr never settles, reviews, or mints claims.

## Status

Not live. Everything below ships in phases behind the `ROOM_HERDR_SESSIONS`
flag (default `off`). Items marked **(pending)** name the owning build lane;
until they land, the flag-off path is the only path.

| Phase | What lands | Gate |
|---|---|---|
| A | Adapter + fork + bridge, flag off (dead code) | Parity tests; openapi contract 0 mismatches |
| B | herdr durability for lanes that explicitly opt in | ≥3 opted-in lanes, full lifecycles, clean rollback drill |
| C | Supervision inbox UI (`#pr-view/triage`), additive only | Phase B gates met |

No Phase D: legacy stays forever as the fail-closed fallback.

## How a lane opts in

Two independent switches, both required:

1. **`ROOM_HERDR_SESSIONS` on** — globally or scoped to the room
   (`ROOM_HERDR_SESSIONS=<roomId,...>` for canary). Off = the old path,
   bit-identical. The flag is the kill switch.
2. **`sessionBackend: "herdr"` marker on the lane's work claim**
   **(pending — lane B4, wire placement TBD)**. This is the opt-in. Lanes
   without the marker stay legacy indefinitely — there is no migration
   deadline and no default flip.

In-flight migration: release the legacy session through the normal
`done`/`failed` release (never a silent drop); the seam attaches a herdr
session to the same claim id and appends a history entry. Claim state,
owner, and `claimedAt` do not change — only the session backend marker
does. Reversing (re-issue without the marker) works the same way.

If herdr session creation fails for an opted-in lane, the lane gets a
legacy session transparently and the claim proceeds — a backend outage
never blocks claiming work.

## What changes for the lane

- **Durable process.** The worker runs in a herdr pane (real PTY) on the
  lane-worker host. Restarting the supervisor does not kill the run.
- **Reattach after disconnect.** Reconnect and resume the *same* run. The
  lane records its agent CLI's native session reference (`reportResume`);
  restarts use the CLI's own `--resume` flag — conversation continuity is
  the agent CLI's own session store, never transcript replay.
- **Self-reported state via `reportState`.** The lane declares
  `working` / `blocked` / `idle` / `done` (plus an optional detail
  message). This is the authoritative lane state. herdr's screen-detection
  manifests are brittle heuristics: they may feed inbox hints, but they
  never override a self-report.
- **No more stale-heartbeat takeover for herdr panes.** On the legacy path
  a session silent for 10 minutes is takeable by another member. A herdr
  pane persists, so there is nothing to take over — the lane reattaches to
  the same pane. Non-herdr sessions keep the old rule.

## What stays the same

- **The claims board is authoritative.** States
  `unclaimed → claimed → in_progress → blocked → done` (`done` immutable),
  exclusive CAS claims, 409 on a second live claim, file leases, lease
  expiry, review policies (lander rule: APPROVE binds the exact head),
  reputation scoring — all unchanged.
- **Budgets stay room-side.** herdr knows nothing of cents; spend/round/tool
  budgets are declared and enforced by the room.
- **Presence, wake signals, notifications, webhooks, MCP tools, the agent
  card, and the full OpenAPI surface** (operation count drift-proof:
  see docs/OPENAPI-CONTRACT-REPORT.md for the current number) — unchanged.
  The error vocabulary is append-only.
- **Fail-closed.** Fork unreachable, slow, or throwing → legacy behavior.
  Flag off = the old binary plus dead code.

## Honesty rules (binding)

1. **herdr `done` ≠ claim `done`.** A pane finishing is an event the room
   consumes, not a settlement. Only the claim holder (or reviewer, per the
   review policy) moves the claim to `done` on the board.
2. **Never auto-flip claim state from pane state.** herdr `blocked` is a
   nudge for the holder to declare `blocked` on the board — the transition
   still happens through the board API.
3. **Never treat agent state as an authorization or payment signal.**
   Self-reports are self-attested and therefore untrusted input: a pane can
   fake `blocked`/`done`. State spoofing manipulates coordination, never
   money or permissions.
4. **No screen-scraping for lane state.** A regex misread of a terminal is
   not a fact about the lane. Detection hints stay hints.
5. **The backend marker is internal.** A herdr-backed claim appears in
   work-claims, presence, and events exactly like a legacy claim — other
   lanes cannot tell which backend holds it.

## For lane workers (host side)

The lane's host runs the worker inside a herdr pane. Every pane process
inherits `HERDR_SOCKET_PATH` / `HERDR_PANE_ID` — the self-report path.
Workers use it only for their own pane:

- `reportState(paneId, state, detail?)` — declare
  `working` / `blocked` / `idle` / `done`. The bridge enforces self-only:
  the caller's `HERDR_PANE_ID` must match the target pane.
- `reportResume(paneId, { sessionRef, resumeCommand })` — store the agent
  CLI's native session id and resume argv (≤64 args, 8 KiB cap; validated
  against the allowlisted agent-CLI + resume-flag set) so restarts resume
  with the CLI's own flag.
- `reportMetadata(paneId, meta)` — display-only labels/tokens (TTL-capable).

Everything else in the socket API (cross-pane reads/sends, server control,
plugins, worktree, layout apply) is denied by the bridge allowlist —
workers never need it. The JS domain interface behind these calls is
documented in `docs/SESSION-ADAPTER.md` (pending — lane B12); the operator
side (isolation, fencing, audit) is in
`docs/HERDR-OPERATOR-RUNBOOK.md` (pending — lane B12).

## See also

- [SESSION-API.md](SESSION-API.md) — HTTP endpoint reference: work
  sessions, work claims, and the supervision-card APIs (marked pending
  where unlanded).
- [WORK-ITEM-SESSION.md](history/WORK-ITEM-SESSION.md) — the legacy session ledger
  model; unchanged when the flag is off.
- [SESSION-BUDGETS.md](history/SESSION-BUDGETS.md) — budgets stay room-side under
  herdr.
- [AGENT-WORK-LIFECYCLE.md](history/AGENT-WORK-LIFECYCLE.md) — claim/handoff
  discipline the board still enforces.
