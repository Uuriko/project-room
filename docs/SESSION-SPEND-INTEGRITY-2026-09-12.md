# Session spend integrity

Local follow-up to `e2ab723` on `codex/project-room-identity-scope`.
Canonical checkout, Grok G2, and historical reducers remain untouched.

## Reproduced defects

- A cumulative report of 80 cents could be replaced by 20 through a live command.
- Reporting 101 cents against a 100-cent cap stopped the session, but its stored
  spend stayed null. The enforcement event also discarded the reported amount.

Both new regression cases failed before the repair and passed afterward.

## Repair

The shared live command policy and dedicated endpoint preflight reject declining
cumulative reports with `409 invalid_session_spend`. Equal amounts remain valid;
omitting spend preserves the last report. Failed cleanup remains possible without
a new report, but cannot rewrite spending downward.

An automatic budget stop includes the submitted spend in its attributed event,
so the existing reducer retains that number in session state. No migration or
historical event reinterpretation is needed. A new interaction that submits a
lower report is rejected before any automatic stop side effects.

## Verification

24 focused tests passed, zero failed/skipped. Coverage checks both live entry
points, unchanged state/event count on rejection, equal-report acceptance,
cleanup preservation, and overage retention in both event and projected state.
`git diff --check` passed. `node scripts/check.mjs`: 1,151 passed,
zero failed/cancelled/skipped; test duration 23,824 ms.

## Remaining contract gaps

These are unverified agent reports, not provider billing or a financial hard cap.
Corrections/refunds need an explicit future accounting design, not silent
decreases to cumulative usage. Historical decreasing reports are not rewritten.

Start commands currently do not accept `spendCents` in their command shape,
although `SESSION-BUDGETS.md` broadly says any set-status mutation can report it.
Supporting start-time spend requires coordinated contract/replay and client work;
this checkpoint does not claim to deliver it. Runtime enforcement still happens
on interaction and does not prove external process cancellation. Independent G2
and alternate-runtime qualification remain open.
