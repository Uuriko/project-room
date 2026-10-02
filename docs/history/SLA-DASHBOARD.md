# SLA Dashboard (task 26)

The SLA dashboard is the end-of-day review surface for inbox responsiveness:
response-time percentiles, breach counts, and the open-conversation sweep
across Telegram and email. It is an on-demand, in-app read — never a push —
at `GET /api/inbox/sla/dashboard` (account-session auth, documented in
`docs/openapi.yaml`).

## What it shows

- **Response-time percentiles** (`percentiles.<channel>`): p50/p95/p99
  time-to-first-response per channel, measured over threads that received a
  first owner reply (`respondedMs` from the SLA clocks). A thread still
  awaiting a reply has no first response yet, so it feeds the breach counts
  instead of the percentiles — a deliberate survivorship note: the
  percentiles answer "how fast do answered threads get answered", the counts
  answer "how many are still waiting". Channels with no answered threads
  report `{ count: 0, p50Ms: null, p95Ms: null, p99Ms: null }` (nearest-rank,
  integer ms).
- **Breach counts** (`breaches`): total plus `byChannel` and `bySeverity`.
  Severity is banded against the channel's target: `high` = past target,
  `critical` = past 2x target. `atRisk` (at or past 75% of target, still
  inside it) is reported separately by channel — near-breaches, not breaches.
- **Journaled breach alerts** (`journaledAlerts`): the durable in-app breach
  receipts (`server/sla-breach-journal.mjs`) rolled up by channel, so the
  dashboard can be cross-checked against what the urgent path delivered.
- **Status rollup** (`statusByChannel`, `openByChannel`, `openCount`): the
  per-channel clock states the inbox list and the sweep use.
- **Open-conversation sweep** (`openSweep`): the "nothing closes unowned"
  review. Every thread still awaiting a reply — no response yet, whether or
  not it is within SLA — with no owner, worst first: severity
  (critical, high, medium, low), then longest wait. Each entry carries
  `owner: null` as the explicit review signal, plus `status`, `severity`,
  `awaitingSince`, `elapsedMs`, `targetMs`, `label`, and `deadlineAt`.

## Data sources

| Surface | Source |
|---|---|
| Clocks | `server/sla-clocks.mjs` (`assessSlaBatch`) — the same per-channel targets the inbox list and the sweep use. The dashboard reuses them; it never reimplements clock logic. |
| Threads | `Inbox.slaThreadScan` — the same thread pipeline as the thread view (same store, same visibility, same message→direction mapping). |
| Ownership | The open handoff journal (`InboxHandoffJournal`, task 23). A thread with an open handoff is someone's and is excluded from the sweep; a closed/completed handoff does not own the thread. |
| Breach alerts | `SlaBreachAlertJournal` — the durable in-app sink for the urgent breach path. |

Severity bands: `low` = on track, `medium` = at risk (≥75% of target),
`high` = breached (<2x target), `critical` = breached (≥2x target).
Nearest-rank percentiles over integer-ms samples.

## EOD sweep semantics

"End of day" means the review cadence, not a scheduled job: the owner opens
the dashboard when they want the review. The sweep lists open conversations
only — threads that have not yet received their first owner reply — and only
those with no owner (no open handoff). Ownership is journal-based, not
assumed: an empty owner set means every waiting thread is listed, never
invented threads. Responded threads, threads with nothing to clock
(`not_applicable`, `unknown_channel`), and owned threads are all excluded.
The sweep never writes, never sends, and holds no timers.

## Caveats

- Percentiles cover answered threads only; a channel whose threads are all
  still waiting shows `count: 0` with null percentiles and nonzero
  at-risk/breached counts.
- Targets are injectable policy (task 25): the defaults are Telegram/WhatsApp
  ≤ 2h, email ≤ 24h, matching the clocks. The dashboard measures; the owner
  sets the bar.
