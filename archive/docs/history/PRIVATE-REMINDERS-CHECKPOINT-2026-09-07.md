# Private reminders: local checkpoint

September 7, 2026. **Implemented and tested locally; not pushed or deployed.**

## Result

Work Details → Remind me schedules one personal reminder with a common preset or
custom local time. The resolved date/offset is shown and the chosen instant is
frozen before Save. Due reminders appear in Catch me up; future reminders stay
under Scheduled. Copy is short and advanced controls remain contextual.

Reminders survive restart and ordinary logout/key rotation. They are private to
the authenticated member, with no new shared event, task state, agent dispatch,
human read acknowledgement, email or push notification. Agents can manage their
own reminders through the existing authenticated client; this is not permission
to read a human's private preferences.

Resolved/superseded work and revoked member/account access retire reminders.
Review/owner-decision gates use the shared terminal-work predicate. Reopening or
re-enabling does not resurrect an old reminder. A new explicit schedule can be
made for work that becomes unresolved again.

Unknown outcomes retain the exact request. Reconciliation stays reachable after
work resolves; historical successful receipts are returned with the current view,
so an old Set cannot masquerade as an active reminder after removal. Stale edits
require reopening/review. Read requests are coalesced and identity-owned; private
state and timers clear at identity loss.

## Schema and packaging

- Schema v8 adds private reminder rows and immutable command receipts. Startup
  checks the exact schema/receipt guards and current writer fence, including
  read-only audit startup. Existing v7 data migrates atomically.
- Node retains verified historical guards and adds v8 guards. Pre-open v7 writers
  cannot write after migration.
- Cloudflare replaces verified old marker guards with a synchronous closed-when-idle
  writer permit. Current writes open/close it atomically; reads do not open it.
  A cached v7 adapter cannot silently skip new lifecycle rules.
- Fourteen public assets are allowlisted. A new import-graph test catches missing
  modules. Test scripts and CI explicitly include the reminder/browser/upgrade gates.

## Verification actually performed

| Check | Result |
| --- | --- |
| Syntax checks, followed by the full core/API suite | Passed; final core suite **254/254** |
| Full configured desktop/mobile browser suite | **62/62** passed |
| Cloudflare non-browser runtime tests | **6/6** passed |
| Local Cloudflare two-browser/restart journey | **1/1** passed |
| Exact asset packaging and local import coverage | Passed for **14** assets |
| Independent service, UI and runtime reviews | Completed; findings addressed |

New coverage includes independent member/agent reminders, immutable receipts,
restart, exact retries after removal/retirement, capacity limits with cancellation
still available, strict time input, DST gap/offset behavior, review/decision gates,
retirement rollback, membership/account revocation, normal logout/key rotation,
unchanged public state/cursor, normal HTTP Origin/CSRF/binding behavior and obsolete
browser identity results. Actual HTTP agent-client requests exercised the endpoint;
this is scripted protocol testing, not a new autonomous-agent field study.

The new actual workerd upgrade fixture starts with synthetic v7 schema/records
and a cached historical adapter. It verifies failed migration restores the exact
catalog, successful migration preserves every old table row, cached old writes
are rejected, corrupt old guards fail closed, affected-row counts stay accurate,
read transactions stay ungated, write failure rolls back, and v8 restart preserves
reminders. The separate older marker-only compatibility experiment is not the
evidence for cached-writer safety.

Eight screenshots are retained in ignored `test-results/reminders-{desktop,mobile}-
{schedule,due,retry,large-text}.png`. All states were visually inspected, including
mobile due content and reachable controls at enlarged text. Simulated browser
journeys cover persistence, clock-driven due visibility, fixed displayed time,
lost-response recovery after supersession, another device's first reminder,
focus fallback, cancellation and sign-out cleanup. They are not recruited user tests.

The local Cloudflare browser harness emitted its known self-signed TLS probe
diagnostics; the scenario passed. Production trust settings were not changed.
Disposable test data was used; existing preview databases and live rooms were
not opened for migration or changed. No hosted assertions or remote CI run are
claimed for this local source.

## Research and long-running goal

[Calm cooperation research](CALM-COOPERATION-RESEARCH-2026-09-07.md) records primary
documentation from Linear, Basecamp, Things, Superhuman, Plane and Vikunja, plus
concrete now/next decisions. No competitor code was copied and no service purchased.

John requested a detailed long-running goal for product depth, retention and growth.
The goal is active and references the full
[working goal](PROJECT-ROOM-LONG-RUN-GOAL-2026-09-07.md). Measurement guidance shaped
three primary measures—collaborative activation, repeat useful collaboration and
value-bearing referral activation—with explicit cohorts, privacy/control guardrails
and no invented baseline or growth claims. The overall goal is **not complete**.

## Next checkpoint and release gates

Next: plan/build a user-enabled notify-only watcher with its own processing
checkpoint/outbox, stable output IDs and explicit stop. Then improve onboarding,
return flows and voluntary invitation/portable-work growth loops. Keep inference,
payments, Dasha, off-app delivery and recovery decisions separately scoped.

Recorded live remains app `fb90a70`, Worker
`901be347-7a39-4b56-8777-f4052bf81b38`, schema v7. The unpublished portable-work
commit is also part of this local candidate. **Do not roll a migrated v8 database
back to the older v7 app.** Prepare a v8-compatible fallback/roll-forward artifact,
test recovery, run exact-source remote CI and obtain current release authorization
before hosted migration. Old release/rollback documentation is labelled pre-v8.

No push, deployment, live migration, new provider, payment, inference, Dasha,
DNS, contact outreach or recurring product automation occurred in this checkpoint.
