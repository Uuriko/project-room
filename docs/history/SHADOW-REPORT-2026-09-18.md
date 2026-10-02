# Shadow Run #1 — Auto-Quarantine Precision Readiness Report

**Date:** 2026-09-18 (run by worker C, first scheduled shadow-report run)
**Tooling:** `scripts/shadow-quarantine-report.mjs` + `server/spam-shadow-report.mjs` (merged as #567)
**Policy:** `docs/AUTO-QUARANTINE-POLICY.md` v1, §5 (the 14-day shadow period + weight-tuning loop)

## Verdict up front

**Readiness: NOT READY — zero shadow data exists.** The tooling itself works (18/18 tests green),
but there is nothing to analyze yet. The 14-day shadow period started today, and both
prerequisites named in the policy are missing: real inbound traffic and owner reviews.
No fabricated numbers appear in this report; every figure below is an actual tooling output.

## What was run

1. **Tooling self-check** — `node --test tests/spam-shadow-report.test.js`: 18 pass, 0 fail.
   The join/labeling contract, metric math, per-signal and gate-block breakdowns, and the
   CLI end-to-end over a real store file are all exercised and green. The machinery is ready.

2. **CLI against the only real room stores in the workspace**
   (`~/workspace/.tmp-test/project-room-acceptance-*/room.sqlite`, ephemeral acceptance
   fixtures — the only `.sqlite` stores on disk; there is no live `.data/room.sqlite`):
   ```
   error: store has no spam_quarantine table — shadow instrumentation (#565) / quarantine journal (#560) never ran here
   exit=2
   ```
   These stores predate the instrumentation; none contain `receipt.shadowQuarantine`
   decisions or a quarantine journal.

3. **CLI against a tables-present, zero-row store** (minimal schema built in /tmp purely to
   show the tooling's "0 days of data" shape — no decisions or reviews invented):
   ```
   Auto-quarantine shadow report
     decisions:        0 scored imports in window
     would-be holds:   0
     reviewed holds:   0 (coverage n/a)

   Metrics (over reviewed would-be holds):
     precision          n/a  (policy §5 bar: false-positive rate ~<=5%)
     false-positive     n/a
     recall             n/a

   Per-signal breakdown (fired on would-be holds):
     (no would-be holds)
   Gate blocks (score >= threshold but NOT held):
     (none)
   ```

## Per-signal coverage today

All 15 policy signals (§2.1). Each row: would-be holds / reviewed holds / true positives / false positives.

| Signal | Weight | Holds | Reviewed | TP | FP |
|---|---|---|---|---|---|
| `dangerous_attachment` | 35 | 0 | 0 | 0 | 0 |
| `telegram_impersonation` | 35 | 0 | 0 | 0 | 0 |
| `link_text_mismatch` | 30 | 0 | 0 | 0 | 0 |
| `credential_harvest` | 30 | 0 | 0 | 0 | 0 |
| `display_name_mismatch` | 25 | 0 | 0 | 0 | 0 |
| `telegram_giveaway_lure` | 25 | 0 | 0 | 0 | 0 |
| `bad_reputation` | 25 | 0 | 0 | 0 | 0 — inert today (policy §7) |
| `telegram_join_lure` | 20 | 0 | 0 | 0 | 0 |
| `reply_to_mismatch` | 20 | 0 | 0 | 0 | 0 |
| `burst_sender` | 20 | 0 | 0 | 0 | 0 — inert today (policy §7) |
| `suspicious_tld` | 15 | 0 | 0 | 0 | 0 |
| `bulk_recipients` | 15 | 0 | 0 | 0 | 0 |
| `urgency_pressure` | 12 | 0 | 0 | 0 | 0 |
| `bot_spam_pattern` | 12 | 0 | 0 | 0 | 0 |
| `shouty_subject` | 8 | 0 | 0 | 0 | 0 |

Precision, false-positive rate, and recall are all **n/a**: they are defined over *reviewed*
would-be holds, of which there are none (`reviewCoverage` = reviewed ÷ would-be = 0/0).

## Exactly what's missing before the first real precision report

The §5 tuning decision keys off the **release rate among would-be holds**
(releases ≈ false positives; "if releases exceed ~5% of holds, the weights get tuned").
For the report to answer that, it needs:

1. **Shadow time on the clock.** #565 (instrumentation) and #567 (this tooling) both merged
   2026-09-18. The policy's recommended shadow period is 14 days, so the earliest the
   report can carry real numbers is ~**2026-10-02**. Today: day 0.
2. **Shadow decisions journaled.** `receipt.shadowQuarantine` records are written by
   `server/spam-shadow.mjs` on each scored import. None exist anywhere. Per policy §7,
   no telegram/email inbound is live — the import funnel runs on fixtures and the webhook
   drain — so shadow mode "runs on fixtures and the scores stay theoretical" until real
   inbound flows.
3. **Review outcomes.** Precision/FPR are measured over *reviewed* would-be holds only.
   The durable journal "exists today, empty" (policy header), and the quarantine review
   UI "does not exist yet" (policy §7) — the only release authority is John, and without
   a review path there are zero reviewed outcomes. Unreviewed holds buy the report nothing.
4. **Per-signal review depth.** The per-signal breakdown needs each of the 13 live signals
   to have actually fired on reviewed would-be holds (2 signals — `bad_reputation`,
   `burst_sender` — are inert and can never appear until the reputation slice lands).

## Recommended cadence

Re-run `scripts/shadow-quarantine-report.mjs` weekly during the shadow window so the
coverage column moves monotonically, and produce the appendix-grade precision report
once `reviewCoverage` on real inbound is non-trivial — i.e. reviewed holds exist across
several signals and the 14-day window is closed. That run's appendix is the input to the
§5 weight-tuning decision (release rate vs the ~5% bar, per-signal FP offenders, gate-block
analysis), after which the auto-quarantine tap (A/B/C in policy §8) is a data-backed call.

## Repro

```sh
node scripts/shadow-quarantine-report.mjs --store <room.sqlite> \
  --since 2026-09-18T00:00:00Z --review-window-days 14
# read-only (PRAGMA query_only); exit 0, no writes, no network, no sends.
# --format json gives the machine-readable drill-down (rows[] per decision).
```
