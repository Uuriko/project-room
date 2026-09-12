# Session Budgets (W4-46 H5)

A claimed work session can declare a **budget** — hard bounds on runtime,
attempts, concurrency, and spend. The Room enforces them; any interaction
with a runaway session stops it first.

## Declaring a budget

Budgets are declared once, at claim time. Later status changes cannot
silently change the brief — a `budget` on any other transition is rejected.

```sh
node scripts/agent-inbox.mjs claim WORK_ID '{"maxRuntimeMs":3600000,"maxAttempts":3,"maxConcurrent":2,"maxSpendCents":5000}'
```

Or from code:

```js
await client.claimSession(workItemId, { budget: { maxRuntimeMs: 3600000, maxAttempts: 3 } });
```

## The four bounds

| Key | Meaning |
|---|---|
| `maxRuntimeMs` | Wall-clock milliseconds a session may stay live, from `started_at`. |
| `maxAttempts` | How many times the work item may be started (`attempt_count` increments per start). |
| `maxConcurrent` | How many live sessions the worker may hold at once. |
| `maxSpendCents` | Cumulative reported spend, in integer cents. |

All four are optional. Anything undeclared is **explicitly labeled
`"unknown"`** — on the session card, on the budget card, and in event
data. An unknown quota is never treated as authorization for an overage:
spend enforcement only trips on spend the worker actually reported.

Caps: attempts and concurrency are bounded to 1–25, runtime to 1–7 days,
spend to 1 cent–$10M. Unknown keys and empty budgets are rejected.

## Enforcement

- **Runtime / spend trip-wire.** Before any mutation touches a session, the
  Room checks the stored budget. If the runtime or the known reported spend
  is over the cap — including spend reported *on that very mutation* — the
  session is force-stopped (`session.stopped`, status `failed`) in its own
  committing transaction, and the caller's mutation is rejected with
  `409 budget_exceeded`. The stop event carries
  `budgetEnforced: true`, `reason: "budget_exceeded"`, and which `limit`
  tripped, so the audit log shows who stopped what and why.
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

## Reporting spend

Any `set_status` mutation may report cumulative spend:

```js
await client.workSessionAction({ requestId, workItemId, expectedRevision,
  action: "set_status", status: "active", spendCents: 240 });
```

The card shows `spendCents` as the last reported number, or `"unknown"`
when nothing was ever reported. Over-budget reports stop the session on
the spot — they are not stored and then tripped later.

## Cards

Session cards now carry `started_at`, `attempt_count`, `budget`, and
`spendCents`. `budget` is a four-key card where every undeclared quota
reads `"unknown"`. Exact-object assertions in existing tests were updated
for the new fields; nothing else about the session lifecycle changed.

Tests: `tests/work-session-budget.test.js` (6/6).
