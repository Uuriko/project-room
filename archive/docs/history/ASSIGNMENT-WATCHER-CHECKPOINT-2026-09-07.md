# Assignment watcher checkpoint

## Outcome

Built an opt-in local foreground assignment/review watcher, including one-shot
checks, durable restart recovery, quiet semantic deduplication and explicit stop.
It reuses the same next-step model as humans and authenticated agents. No extra
screen, hosted runtime, subscription or dependency is required.

The broad capability/retention/growth goal remains **active and incomplete**.
This is a tested foundation for returning to relevant work, not proof of retention
lift, viral growth, human preference or autonomous collaboration.

## Implemented

- `agent-inbox watch start|status|stop`, with a dedicated private directory and
  optional `--once`; direct Node and silent npm examples are documented.
- Current-assignment/review filtering for the authenticated member; existing work
  labelled initial catch-up. Irrelevant events and historical reviews stay quiet.
  Time-only claim expiry is reevaluated. Concurrent ticks coalesce.
- Snapshot-based evaluated-through checkpoint separate from the human read cursor.
  Fixed identity/account epoch, room-created event and last-event history anchors.
  Explicit matching-key rotation restart works; changed/revoked identity stops.
- Atomic local checkpoint/semantic attention/outbox updates. Stable IDs survive
  unknown output and restart; fresh reconciliation suppresses obsolete pending work.
- Separate lifetime SQLite ownership lock and short-transaction state database.
  Real simultaneous, paused and killed process tests prove exclusion/recovery.
  No stale-PID lock deletion, expiring lease takeover or automatic state reset.
- Private files, schema/data checks, consistent observer read snapshots, bounded
  rows/payload/pages, rollback, and no stored credentials or full room projection.
- Bounded transient retry and Retry-After handling, cancellable reads including
  response bodies, slow/broken output handling, sanitized diagnostics and stop.

Production additions are three small modules (watcher, journal, CLI runner), plus
thin changes to the existing inbox/client. No Room schema or browser asset changed.
The local watcher schema is independent v1, **not** a Room v9 migration.

## Evidence

- Syntax plus **332/332 core/API checks** passed: 254 prior checks and 78 new
  watcher/client checks (24 domain/watcher, 25 journal, 27 CLI, 2 actual HTTP/CLI).
- **62/62 browser checks** passed, preserving desktop/mobile, keyboard, accessible
  reflow, invitation/session, portable-work and private-reminder journeys.
- **7/7 local Cloudflare checks** passed, including current v7→v8 recovery and
  actual Workers/browser restart. Existing local self-signed TLS probe diagnostics
  appeared; all assertions passed and production certificate trust was not weakened.
- Actual subprocess CLI over a disposable HTTP service made authenticated GETs
  only; Room snapshot and human read cursor remained unchanged. Separate-process
  stop interrupted an outstanding network read. No hosted service was contacted.
- [Credential-free terminal evidence](evidence/assignment-watcher-2026-09-07.txt)
  preserves the observed initial notification, quiet restart and final status.
- Fresh `first-use-desktop-guest.png` and `reminders-mobile-due.png` screenshots
  were inspected. Existing controls remained readable and in bounds. No new
  watcher UI, external human user study or live AI worker is claimed.

Three disjoint agent test lanes independently reviewed service relevance, local
durability and CLI behavior. They found and reproduced malformed catalog/record
acceptance, mixed-snapshot validation and swallowed body-timeout/cancellation
errors; fixes and regression tests are included. Scope remained this checkout.

## Limits and release state

Notifications are an observation, never permission to execute. Snapshots may miss
intermediate changes; output is only as fresh as the recorded evaluation. Successful
stdout writing is not proof of downstream receipt. Crash replay can repeat a stable
ID, and consumers must deduplicate. No exactly-once or off-app alert guarantee.
Use owner-private local storage with working POSIX permissions/SQLite file locks;
macOS/Node24.19 was exercised locally. Network/synchronised filesystems and moving
state across computers are unsupported. The local clock influences expiry notices.

All changes in this checkpoint are **local, not pushed or deployed**. Recorded live
remains application `fb90a70`, isolated staging Worker `901be347`, Room schema v7.
The preceding portable-work/reminder checkpoints remain unpublished as well.
Reminders require Room v8 and a compatible fallback/recovery plan before release;
old v7 code cannot safely roll back migrated v8 data. No hosted CI result is claimed.

No deployments, live migration, provider changes, DNS, Dasha/Desk changes, paid
compute, Stripe/stablecoin actions, outreach or recurring automation were performed.

## Now / next / later

**Now:** preserve this checkpoint and its operator guide; keep the long-running goal
active. Do not reimplement watchers or restart research from scratch next turn.

**Next:** review the human first-use/return experience with the current screenshots
and existing invitation/portable-work loop. Plan one small measurable improvement
to finding a first useful contribution or returning to a due task, without adding
another navigation layer. In particular, review repeated catch-up controls and
technical event-count copy while preserving explicit acknowledgement semantics.
Use progressive disclosure, keyboard/mobile checks and a clear voluntary invitation
route. Define an experiment contract, not an invented growth result.

**Later:** durable acknowledged output channels and hosted watcher/runtime need
separate authority/delivery/cost contracts; task-scoped context and a thin MCP layer
need reviewed access boundaries. Templates/shared outcomes, account recovery,
bounties/payments and Dasha remain staged optional integrations under the full goal.

[Operator guide](ASSIGNMENT-WATCHER.md) ·
[Source-backed implementation plan](ASSIGNMENT-WATCHER-PLAN-2026-09-07.md) ·
[Long-running goal](PROJECT-ROOM-LONG-RUN-GOAL-2026-09-07.md)
