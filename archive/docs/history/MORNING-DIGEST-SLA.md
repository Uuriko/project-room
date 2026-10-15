# Morning digest + per-channel SLA clocks (tasks 21, 24, 26)

> Retired 2026-09-19: the `/api/inbox/digest` HTTP route was removed (no
> callers). The pure digest builder (`server/morning-digest.mjs`) and the
> per-thread SLA clocks remain live. This doc is kept as design history.

## What this is

Two additive, pure modules plus thin wiring into the existing inbox read path.
Nothing touches the inbox write path; nothing touches login/auth (quill's lane);
no sends, no pushes, no schedules ship here.

## Morning digest — `server/morning-digest.mjs`

`buildMorningDigest({ arrivals, since, date, triage, now })` wires the pure
`digest-mode.mjs` builder and the `inbox-triage.mjs` decider into one brief:

- **Window**: arrivals with `occurredAt >= since`. The route defaults `since`
  to 24h ago and accepts an explicit ISO timestamp; a malformed `since` is a
  422 (`invalid_digest_since`).
- **Grouping**: per channel (Telegram, email, …), then by sender via
  `digest-mode.buildDigest` (busiest first), then by thread (newest first).
- **Triage**: the shared `triageMessage` decider runs on each thread's latest
  arrival (injectable for tests/future policy). Spam stays **flag-only**:
  quarantined items are listed with a review action, never silently hidden
  (task 33's default).
- **One-tap actions**: inert descriptors only — `reply`, `snooze`, `file`,
  `handoff` (with a context packet: threadId, channel, sourceIds, SLA, reasons
  — the shape task 23's handoff protocol will journal). Nothing executes.
- **SLA annotation**: an optional per-arrival `sla` assessment is copied onto
  the thread row and rolled into top-level `breached` / `atRisk` lists.
- **Delivery**: in-app first. `GET /api/inbox/digest` builds the brief on
  demand from the thread view. There is deliberately no scheduler and no push
  path: format, delivery channel, and daily time are John's call (task 22).

## SLA clocks — `server/sla-clocks.mjs`

`assessThreadSla({ threadId, channel, messages, now, targets })` tracks
time-to-first-response per channel:

- The clock starts at the latest **inbound** message and stops at the first
  **outbound** reply at or after it; a later inbound restarts it.
- Statuses: `on_track` | `at_risk` (≥ 75% of target) | `breached` |
  `responded` (with `withinTarget`) | `not_applicable` (nothing inbound) |
  `unknown_channel` (no target configured — a guessed clock is worse than none).
- `assessSlaBatch` rolls many threads into per-channel open counts plus
  `atRisk`/`breached` thread lists — the primitive task 26's end-of-day
  "nothing closes unowned" sweep will extend.

**Targets** (injectable per call; `validateSlaTargets` guards shapes):

| channel | default target | rationale |
|---|---|---|
| telegram / whatsapp | 2h | chat runs in minutes; task 25's example |
| email | 24h | mail runs in hours; task 25's example |

The defaults are the task-25 *example values*, not a decided policy —
John sets the responsiveness bar. `slaTargets` is a frozen constant; wiring
owner-configured targets into the store is a later slice.

**Direction** is derived from stored envelopes in `Inbox.slaClockInput`:
owner-sent is outbound; messages addressing the owner (`inboxNeedsYou`)
are inbound; everything else is skipped. Pure view, never a stored flag.
`Inbox.slaAssessment` (the thread list's inline field) and the sweep's thread
scan share it, so both clock the same messages.

## Wiring (all additive)

- `Inbox.threads()` gains a per-thread `sla` field — inline breach surfacing
  in the thread list (task 24). `null` when the thread carries nothing to clock.
- `GET /api/inbox/digest` → `Inbox.digest()` → `buildMorningDigest` (task 21).
  Channel sources need the reading view, like the thread list.
- The SLA sweep's hooks are live (task 26): `Inbox.slaThreadScan` enumerates
  the genuinely live threads from the inbox's own thread store — the same
  pipeline as the thread view (same rows, same visibility, same
  message→direction mapping), projected to the clocks' assess shape. An
  empty store scans to zero threads; it never invents them.
- `createInboxThreadReader` / `createSlaBreachDeliver` in
  `server/sla-sweep-hooks.mjs` wire the sweep's injected authorities:
  `readThreads` from the owner's session-bound thread scan, `deliver` into
  the durable in-app `sla_breach_alerts` journal (`server/sla-breach-journal.mjs`,
  `store.slaBreachAlerts`), recording each delivered breach's decision,
  reason, and prefs snapshot — the urgent path's terminal sink. Urgent
  breaches still bypass quiet hours; an explicit muted-all still mutes.
  In-app first: delivery channel and push are task 22's call.
- `scripts/runtime-package.mjs` and `tests/runtime-package.test.js` register
  the new server modules.

## Open taps (John's call)

- **Task 22**: digest format, delivery channel (Telegram ping?), daily time.
- **Task 25**: SLA targets per channel (2h/24h are placeholders).
- **Task 35**: quiet hours and who gets woken for a breached SLA.
