# Release qualification execution plan

Complete the existing architecture candidate before adding features. Candidate starts at 000d6f78, PR #4114. John granted standing execution and publication authorization on 2026-10-18.

## 1. Exact-candidate CI

Inspect every required GitHub check, diagnose failures from logs, distinguish baseline/environment failures from candidate regressions, and repair real failures. Keep the full Linux sandbox checks enabled. Push verified repairs and require green checks on the resulting SHA before merge.

## 2. Capacity and trustworthy measurements

First repair the shared benchmark so refused writes cannot earn a speed verdict and failed seeding cannot masquerade as the requested room size. Preserve raw refusal evidence. Measure bodies-at-rest with the same base/head workload, including replay beyond the fixture sequence. Investigate bounded entity mode if bodies-at-rest still scales unacceptably. Qualify complete message fidelity, old-message access, replies, restart, migration and replay before changing production defaults. Never solve the capacity limit merely by raising it.

Acceptance: every seeded and measured write succeeds at 1,000 and 4,000 messages, recovery agrees with live state, and report includes latency, projection bytes and storage mode. Larger growth tests establish the next limit; they are not substitutes for full fidelity checks.

## 3. Interruption recovery

Extend the existing real native host trial with interruption while a request is in flight and reconciliation from its persisted journal. Verify no duplicate published result and no blind model restart after an uncertain outcome. Physical sleep/wake requires an actual observed OS suspend/resume; process suspension or restart must not be reported as equivalent. Capture evidence and retain any unfulfilled hardware gate explicitly.

## 4. Coordinated release

After the preceding gates: inspect current main and deployment ownership/freeze, reconcile any new main commits, merge through normal required checks, then qualify the merged SHA. Use the existing pinned-SHA production workflow with schema-compatible recovery. Smoke-check production entry, authenticated conversation/work flow, storage continuity and acceptance authority. Roll back only where schema compatibility permits; otherwise roll forward. Record the deployed SHA, checks and recovery target.

## Execution record

- PR #4114 published; Linux and other checks pending at plan creation.
- Previous inline run at 4,000 messages refused 140/200 measured writes per sample; no successful-write claim may use those latencies.
- Prior native trial proves a real model turn plus duplicate-free process restart, not physical sleep/wake.

### Production-mode benchmark and in-flight recovery

The deployment workflow already pins `ROOM_BODIES_AT_REST=1`; no new flag rollout is needed merely to avoid the inline 4 MB cap. One six-round base/head run at 1,000 and 4,000 messages completed with zero refused fixture or measured writes. At 4,000, projection was 767 KB, replay median 4992 to 471 ms (91% less), snapshot 9.22 to 6.19 ms (33% less). Write p50 was 12.7 to 13.0 ms, inconclusive; storage/hydration still grows with message count. This qualifies capacity for the measured workload, not flat writes or unbounded scale.

The real native in-flight disconnect trial reconciled its original turn as `interrupted`; one model start, no duplicate execution, no result publication. The earlier successful-completion/restart trial remains separate. Neither proves physical sleep/wake.

 · head 000d6f78+changes vs base 02cfd142 (02cfd142)
6 runs per side, alternating, fresh process each · 200 writes per run · bodies at rest · Node v24.19.0 · Apple M5 (10 cores)

Room of 1000 messages
| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 3.75 [3.13–4.13] | 3.41 [3.00–3.95] | 0.91x | 1.000 | ~ |
| write p95 (ms) | 5.93 [5.15–6.52] | 5.30 [5.04–6.72] | 0.89x | 1.000 | ~ |
| storedProjection (ms) | 1.65 [1.52–2.61] | 1.87 [1.63–2.09] | 1.13x | 1.000 | ~ |
| cold room() (ms) | 2.90 [2.65–4.71] | 3.19 [2.71–4.04] | 1.10x | 1.000 | ~ |
| projection (KB) | 226 [226–226] | 226 [226–226] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 2.67 [2.44–3.51] | 1.91 [1.64–2.78] | 0.72x | 0.197 | ~ |
| GET full room (KB) | 1323 [1323–1323] | 1323 [1323–1323] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 6.34 [5.29–15.89] | 6.53 [5.73–8.78] | 1.03x | 1.000 | ~ |
| GET recent window (KB) | 221 [221–221] | 221 [221–221] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 3.66 [3.38–7.59] | 3.76 [3.20–4.10] | 1.03x | 1.000 | ~ |
| replay from log (ms) | 377 [318–512] | 113 [96–130] | 0.30x | 0.017 | **better** (70% less) |

Room of 4000 messages
| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 12.7 [11.9–16.0] | 13.0 [11.0–16.5] | 1.03x | 1.000 | ~ |
| write p95 (ms) | 18.4 [17.0–23.6] | 19.0 [16.6–33.6] | 1.03x | 1.000 | ~ |
| storedProjection (ms) | 7.56 [6.06–8.64] | 7.63 [6.13–9.80] | 1.01x | 1.000 | ~ |
| cold room() (ms) | 14.8 [11.3–17.1] | 14.6 [12.3–19.5] | 0.99x | 1.000 | ~ |
| projection (KB) | 767 [767–767] | 767 [767–767] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 9.22 [7.84–10.75] | 6.19 [5.07–7.97] | 0.67x | 0.030 | **better** (33% less) |
| GET full room (KB) | 4348 [4348–4348] | 4348 [4348–4348] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 17.9 [14.5–19.4] | 15.1 [13.2–23.4] | 0.84x | 0.898 | ~ |
| GET recent window (KB) | 221 [221–221] | 221 [221–221] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 6.41 [5.44–7.49] | 5.02 [4.12–6.97] | 0.78x | 0.390 | ~ |
| replay from log (ms) | 4992 [4042–5380] | 471 [400–779] | 0.09x | 0.017 | **better** (91% less) |

Verdicts need a Holm-adjusted p < 0.05 across this size's metrics and a move of 10% or more. Under 6 runs, intervals span the full range.


### Execution constraints observed

GitHub PR checks remain queued without assigned runners; the shared room reports the same queue on main. No check failures can be diagnosed until jobs execute, and neither merge nor deploy can be certified green from queued checks. The large-diff gate was run locally and passes with the explicit integration justification added to PR #4114.

A noninteractive administrator capability check failed on this Mac. Scheduling a reliable automatic wake for a real whole-machine sleep trial is therefore unavailable to this session. Suspending the shared Mac without a verified wake plan would interrupt the active local and other-agent workloads; physical sleep/wake remains unqualified, not replaced by the passing process-disconnect trial.


### Growth qualification

The standalone 8,000-message bodies-at-rest trial passed: zero failed seeds, 8,001 messages after a new reply to the oldest message, exact retry without sequence advance, byte-for-byte message-record parity after restart and replay, and 1,487,641 projection bytes. See `release-capacity.json` and reproduce with `node scripts/qualify-room-capacity.mjs 8000 /absolute/report.json`. This was a fidelity run alongside tests, not a benchmark.

All 411 selected affected test files passed; 66 focused Node/Worker checks passed. The contract gate identified stale schema references in README, CURRENT-ROOM and SERVICE; corrected to 42 and the schema consistency check passes. Lint is being repeated after the full suite to avoid a concurrent i18n test's temporary source probe.


### Full suite and main reconciliation

Full suite: 11,141 tests, 11,109 passed, 24 failed, 8 skipped; every failed file/name matches the recorded baseline Linux-only cases. The nested deliberately failing CI probe is not an additional failure. See `release-qualification.json`. This run preceded integration of main `9c409dec`; that merge was conflict-free and has a separate focused integration/contract check. No claim of an all-green Mac suite or final Linux result is made.


### CI-discovered Worker assumptions

Cloudflare CI on the first published head failed 20 historical upgrade checks and one record-rails check. The upgrade assertion compared raw schema-42 work references to old inline payloads. It now hydrates and validates referenced work rows before comparing the complete original payload; rollback still compares raw rows/catalog exactly. The record-rails assertion uses the current schema constant instead of stale 41. These are test-contract repairs, with no production behavior change.

After main integration: 47 targeted tests passed; full contract check passes; lint has 0 errors and 290 existing warnings; schema migration gate 4/4 and documentation links 586/586 pass. The earlier lint collision cleared when rerun after the full suite.


All 21 repaired Worker checks pass locally, including historical v8–v27 upgrades, rollback, old-writer refusal and persisted restart. Changed-file ESLint is clean. PR #4114 must still complete its new-head Linux/Worker CI before merge; the physical sleep/wake and production deployment gates remain open.
