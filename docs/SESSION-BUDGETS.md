# Session Budgets (W4-46 H5) and Work Controls (RC-2026-09-19-063)

A claimed work session can declare a **budget** — hard bounds on runtime,
attempts, concurrency, spend, work-loop rounds, and tool calls. The Room
enforces them; any interaction with a runaway session stops it first.

## Declaring a budget

Budgets are declared once, at claim time. Later status changes cannot
silently change the brief — a `budget` on any other transition is rejected.

```sh
node scripts/agent-inbox.mjs claim WORK_ID '{"maxRuntimeMs":3600000,"maxAttempts":3,"maxConcurrent":2,"maxSpendCents":5000,"maxRounds":20,"maxToolCalls":500}'
```

Or from code:

```js
await client.claimSession(workItemId, { budget: { maxRuntimeMs: 3600000, maxAttempts: 3, maxRounds: 20 } });
```

## The six bounds

| Key | Meaning |
|---|---|
| `maxRuntimeMs` | Wall-clock milliseconds a session may stay live, from `started_at`. |
| `maxAttempts` | How many times the work item may be started (`attempt_count` increments per start). |
| `maxConcurrent` | How many live sessions the worker may hold at once. |
| `maxSpendCents` | Cumulative reported spend, in integer cents. |
| `maxRounds` | Work-loop rounds the session may run. **Exceeding pauses, not stops** — see below. |
| `maxToolCalls` | Tool calls the session may make. Exceeding force-stops, like spend. |

All six are optional. Anything undeclared is **explicitly labeled
`"unknown"`** — on the session card, on the budget card, and in event
data. An unknown quota is never treated as authorization for an overage:
spend enforcement only trips on spend the worker actually reported.

Caps: attempts and concurrency are bounded to 1–25, runtime to 1–7 days,
spend to 1 cent–$10M, rounds to 1–10,000, tool calls to 1–1,000,000.
Unknown keys and empty budgets are rejected.

## Enforcement

- **Runtime / spend / tool-call trip-wire.** Before any mutation touches a
  session, the Room checks the stored budget. If the runtime, the known
  reported spend, or the reported tool calls are over the cap — including
  numbers reported *on that very mutation* — the session is force-stopped
  (`session.stopped`, status `failed`) in its own committing transaction,
  and the caller's mutation is rejected with `409 budget_exceeded`. The
  stop event carries `budgetEnforced: true`, `reason: "budget_exceeded"`,
  and which `limit` tripped, so the audit log shows who stopped what and
  why.
- **Round limit: pause, report, resume.** A session that exceeds
  `maxRounds` is **auto-suspended**, not stopped: the Room commits a
  `session.status_changed` to `suspended` with `suspendReason:
  "round_limit"` in its own committing transaction and rejects the
  caller's mutation with `409 round_limit_exceeded`. The worker keeps its
  claim through the pause but cannot self-resume — any resume by the
  worker is rejected with the same code. Only the room owner (or a member
  with `manage_claims`) can resume; the approved resume is recorded with
  `resumeApproved: true`, restarts the round count at 0, and hands the
  session back to the paused worker. The applier re-checks
  `resumeApproved`, so a tampered log entry cannot smuggle a resume past.
  The room owner is notified of every pause and every enforcement stop,
  even when they are not the accountable member on the card.
- **Attempts.** A start that would exceed `maxAttempts` is rejected with
  `409 budget_exceeded` before anything is written.
- **Concurrency.** The bound follows the worker: the new claim's
  declaration wins; otherwise the tightest `maxConcurrent` the worker
  already declared on a live session applies. Claiming a second session
  without restating the bound does not dodge it. Rejected with
  `409 budget_exceeded`.
- **Immutability.** The budget travels with the start event and is applied
  verbatim at replay; the applier re-validates it, so a tampered log entry
  cannot smuggle a wider brief.

## Reporting usage

Any `set_status` mutation may report cumulative usage:

```js
await client.workSessionAction({ requestId, workItemId, expectedRevision,
  action: "set_status", status: "active", spendCents: 240, rounds: 6, toolCalls: 41 });
```

Reports are **monotonic**: the Room keeps the max, so a stale, reordered,
or malicious report can never rewind the counters the limits are enforced
on. The card shows `spendCents` as the last reported number (or
`"unknown"` when nothing was ever reported), plus `rounds`, `toolCalls`,
and — for a paused session — `suspendedBy: "round_limit"`. Over-budget
reports stop (or pause) the session on the spot — they are not stored and
then tripped later.

## Result marks: fact / inference / proposal

A completion may mark passages of its result so consumers know what they
are acting on:

```js
await client.workAction("room_record_completion", { requestId, workItemId, expectedRevision,
  summary: "...", evidenceUrl: "https://…", evidenceVersion: "v1", nextAction: "…",
  segments: [
    { kind: "fact", text: "The endpoint returned 200 on three probes." },
    { kind: "inference", text: "The outage was likely a deploy, not a config change." },
    { kind: "proposal", text: "Add a canary check before the next deploy." }
  ] });
```

- `fact` — observed; `inference` — derived; `proposal` — suggested, never
  authoritative.
- Optional, 1–20 segments of 1–2000 characters each. Unmarked results stay
  unmarked — the Room never guesses marks.
- Validated on the way in and stored on the completion receipt; returned
  by `work-result` and the native-result audit. Legacy completions without
  segments replay with `segments: null`.
- The same `segments` field works on `room_submit_text_result`.

## Cards

Session cards now carry `started_at`, `attempt_count`, `budget`,
`spendCents`, `rounds`, `toolCalls`, and `suspendedBy`. `budget` is a
six-key card where every undeclared quota reads `"unknown"`. Exact-object
assertions in existing tests were updated for the new fields; nothing else
about the session lifecycle changed.

Tests: `tests/work-session-budget.test.js`, `tests/work-controls.test.js`.

## Room spend allowance (issue #6 C3)

Session budgets bound one run. The **room spend allowance** bounds the room:
the owner records how much agent sessions may commit over a rolling period,
and the Room refuses any start that would exceed it before anything is
written.

```sh
curl -X POST "$ROOM/api/rooms/commons/spend-allowance" -H "Authorization: Bearer $OWNER_KEY" \
  -H "Content-Type: application/json" -d '{"allowanceCents":5000,"periodDays":30}'
curl "$ROOM/api/rooms/commons/spend-allowance" -H "Authorization: Bearer $KEY"   # any member
```

The set route is owner-only (`403 owner_required` for anyone else); the
same event, `room.spend_allowance_set`, can be sent on the generic command
path and the reducer refuses non-owners there too. `allowanceCents` is an
integer of cents from 0 to 100,000,000 (`0` freezes starts), `periodDays`
1–365 (default 30). `{"allowanceCents": null}` removes the allowance and
restores the pre-allowance behaviour. Every change is an event with a
revision, the setter and the time, and replays with the log.

### The ledger

Derived from the projection alone (`spendLedger` in
`src/work-item-session.js`), so the server check, the read route and the
"Agent spend" card compute the same figures:

| Figure | Meaning |
|---|---|
| `spentCents` | Spend agents reported: measured usage of attempts that closed in the period, plus the latest cumulative report of every live session. |
| `reservedCents` | What live sessions may still spend under their declared `maxSpendCents`. A live session always counts, however old. |
| `heldCents` | The declared cap of every attempt that closed in the period without reporting spend. Unknown spend is held at its reservation, never assumed zero. |
| `committedCents` | `spent + reserved + held`. |
| `headroomCents` | `allowance − committed`, floored at 0; `overCents` is the excess, if any. |
| `sessions` | `live`, `unreserved` (live sessions with no spend cap, only possible for runs started before the allowance), `attemptsCounted`, `attemptsUnreported` (no report and no cap: named, adds nothing), `attemptsHeld`. |

### Enforcement

- **Start.** A `session.started` under an allowance must carry
  `budget.maxSpendCents` (a retry that declares no budget inherits the
  item's, as the applier does) — otherwise `422 spend_allowance_budget_required`.
  If `committed + maxSpendCents > allowance` the start is refused with
  `409 spend_allowance_exceeded` and the message names spent, reserved,
  held and what is left. Two claims cannot both reserve the last of the
  allowance: each start runs inside the write transaction against the
  ledger that includes the other.
- **Reports.** A spend report within the reservation changes nothing (the
  room already allowed it). A report beyond the reservation that would
  carry the room past the allowance is refused with
  `409 spend_allowance_exceeded`; on the work-sessions route the session's
  own `maxSpendCents` trip-wire fires first and force-stops the run.
- **Stops always land**, even above the cap or the allowance, so actual
  spend is recorded; a stop below the reservation frees the difference,
  a stop without a report holds the cap.
- **Lowering or zeroing** the allowance below what is committed blocks
  further starts; running sessions keep their reservations (use
  `request_stop`).
- A mention, an assignment or a proposal never sets a budget or an
  allowance; only the owner's explicit event does.

Tests: `tests/spend-allowance.test.js`, `scripts/spend-allowance-browser-check.mjs`.
