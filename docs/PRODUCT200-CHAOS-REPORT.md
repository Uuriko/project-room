# PRODUCT-200 Reliability — Chaos Properties Final Report (C12–14 consolidated synthesis)

Date: 2026-10-08 · Worker C12–14 (consolidated respawn; prior attempt died on an infra error with no work done) · coordinator: product200-reliability
Repo anchor: `Uuriko/project-room` @ `957e13ffa` (origin/main, 2026-10-09)
Verified by: re-ran the full landed chaos/property harness locally against the anchor, inspected every `~/workspace/product200-c*/` work dir, every `jill/product200-c*` branch, and every `product200-c*` PR. Nothing is marked landed or covered that was not verified.

## Headline

- **8 property/chaos suites are on main**, all auto-wired into CI (`scripts/unit-shards.mjs` discovers every `tests/*.test.js`; the `unit-shards` job is a merge gate). No manual wiring exists or is needed.
- **This session re-ran all 8 suites against origin/main: 51/51 pass** (~28 min wall clock, single-threaded, `node --test` with deps from a clean `npm ci`).
- **Bug classes now permanently guarded**: claim-board lifecycle races (deadlocks, strike-two limbo, forged/early/terminal strike-twos, receipt double-count, heartbeat-grace violations, task-id reuse), webhook redelivery double-processing under replay/race/out-of-order schedules, Durable Object mid-write partial state, money-path double-spend / nonce-replay / grant-leakage, ingestion contract violations (MIME, headers, timestamps, Telegram updates), writer-fence drift, and SSE resume gaps/duplicates.
- **Pending: exactly one worker produced unlanded work** — C2's claim-lifecycle race properties (PR #2151, OPEN, CI red on its own fail-first tests). C1/C3/C5/C9–C11: no committed work and no PRs found anywhere; marked honestly as nothing delivered.

## Worker-slice status (C1–C11, honest)

| Slice | Scope | Branch | Status |
|---|---|---|---|
| C1 | chaos scaffold | `jill/product200-c1-chaos-scaffold` | **nothing delivered** — zero commits ahead of main, no PR. The scaffold concept lives on in the landed suites below |
| C2 | claim-lifecycle races | `jill/product200-c2-chaos-races` | **PR #2151 OPEN, CI red** — `tests/chaos/claim-lifecycle-races.test.js` + `tests/chaos/claim-race-ops.mjs` (+ `.gitignore`, + a `server/work-claims.mjs` error-message wording tweak). Unit shard 1/3 fails on its own fail-first tests "P1 catches a weakened anti-collision guard" and "fail-first: weakened guards are caught". **PENDING** |
| C3 | torn writes | `jill/product200-c3-chaos-torn-writes` | **nothing delivered** — zero commits, no PR |
| C5 | chaos events | `jill/product200-c5-chaosevents` | **nothing delivered** — zero commits, no PR |
| C9–C11 | consolidated chaos properties | `jill/product200-c911-chaos-properties` | **nothing delivered** — zero commits, no PR. This report is the consolidation |

(An all-PRs search for `product200-c` head refs returned only #2151; the other branches exist only as stale local checkouts behind main.)

## Properties table (landed on main)

| Suite | File | Tests | What it guards | Seed | Landed via | Verified this session |
|---|---|---|---|---|---|---|
| claims state machine | `tests/claims-state-machine.property.test.js` | 12 (P1, P2, P2b, P3, P4, P5a/b/c, P6 + table/trace/permission invariants) | claim-board races: unreachable states/deadlock, illegal transitions, strike-stamps on done claims (no resurrection), strike-two → submitted (never limbo), receipt double-count on replayed dones, heartbeat grace rules, task-id reuse | fixed `20260926`; `PROPERTY_TEST_SEED` shifts | PR #1860 (2026-10-07) | ✅ 12/12 |
| webhook dedupe | `tests/channel-webhook-dedupe-property.test.js` | 3 | Telegram webhook redelivery double-journaling under random replay schedules, racing duplicates, out-of-order singles | deterministic mulberry32, base `0xD3D946`, per-round `+ round*7919` | PR #1860 | ✅ 3/3 (~97 s) |
| chaos drill (F024) | `tests/chaos-drill.test.js` | 5 (describe/it) | DO kill mid-write: no partial state, writer-permit reset, abort-controller rollback, retry commits fully, eviction keeps committed data | deterministic drill (no randomness) | originated PR #282; carried by #1860 | ✅ 5/5 |
| spend grants | `tests/spend-grants-property.test.js` | 5 (P1–P5) | money: grant overdraw, nonce double-charge across authorize/settle/void/replay interleavings, single-use grant reuse, cross-agent grant leakage, room-allowance over-commit | fixed `20261005`; `PROPERTY_TEST_SEED` shifts | PR #1860 | ✅ 5/5 |
| email envelope | `tests/email-envelope-property.test.js` | 8 | MIME type handling, folded headers, addr-spec validation, timestamp acceptance, round-trip + tamper refusal, JSON normalizer contract errors | fixed-seed generator; `PROPERTY_TEST_SEED` shifts | PR #1860 | ✅ 8/8 |
| telegram | `tests/telegram-property.test.js` | 6 | update normalization round-trip, source identity, single-field corruption refusal, body-text acceptance, getUpdates cursor discipline, normalizer contract errors | fixed-seed generator; `PROPERTY_TEST_SEED` shifts | PR #1860 | ✅ 6/6 |
| writer fence | `tests/writer-fence-property.test.js` | 5 | trigger drift (exactly one trigger per table×operation), unwriter writes refused, version stamping, idempotent installs, schema-version growth | fixed `0xfe0ce001`–`0xfe0ce004`; `PROPERTY_TEST_SEED` shifts | PR #1860 | ✅ 5/5 (~858 s) |
| SSE reconnect chaos (REL-19) | `tests/sse-reconnect-chaos.test.js` | 7 | stream resume: no gap/no duplicate after drops, Last-Event-ID precedence, 10 drop/reconnect cycles, bad cursors → 422/409 (never 500) | deterministic cycles | Fo, commit `13c183b29`, PR #2096 (2026-10-08) | ✅ 7/7 |

Totals: **8 suites, 51 tests, 51 pass, 0 fail.**

## Seeds & reproducibility

Every landed suite is deterministic in CI: fixed default seeds (table above); `PROPERTY_TEST_SEED` env var shifts the fast-check suites for an extra exploratory run. `chaos-drill` and `sse-reconnect-chaos` are deterministic drills with no randomness. The one randomized-but-seeded case (`channel-webhook-dedupe`) derives per-round seeds deterministically (`0xD3D946 + round * 7919`).

## CI wiring status

- **Automatic**: `scripts/unit-shards.mjs` discovers every Node-discovered `tests/*.test.js` and places it in exactly one of 3 unit shards; the `unit` job requires all three shards green. The 8 chaos/property files need no registration — a future chaos suite lands in CI the moment it is merged as `tests/*chaos*.test.js` / `tests/*.property.test.js`.
- **Gap (minor)**: none of the 8 files has a measurement in `scripts/unit-ci-durations.json`, so shard balancing uses the conservative 5 s default. Measured locally this session: writer-fence ~858 s, claims-state-machine ~600 s (fast-check), webhook-dedupe ~97 s. Shard wall-clock estimates are therefore understated; recommend adding the 8 measured durations to `unit-ci-durations.json`.
- `PROPERTY_TEST_SEED` is not set in CI — exploratory shifted runs are manual only.

## Known gaps

1. **C2 pending (PR #2151, CI red)** — the only server/`work-claims.mjs` race-property coverage. Its own fail-first tests fail in CI ("P1 catches a weakened anti-collision guard", "fail-first: weakened guards are caught"). Likely cause: P1 weakens claimWork's anti-collision guard, but the per-item legality oracles check each item in isolation — a double-claimed item (state `claimed`, owner = second agent) is still *per-item legal*, so the oracle cannot see the semantic race of two holders on one claim. A cross-holder invariant (at most one active holder per claim id across the store) is needed. The PR also edits `server/work-claims.mjs` message wording, which keeps drifting against the weakening string specs. Needs HELP-100 rebase-rescue + a property-design fix; out of this worker's scope.
2. **C3 produced no torn-write suite** — torn lease/owner pairing on claim items is guarded only by route-level tests (#2088-era), not chaos properties.
3. **C5 produced no event-ordering suite** — only SSE resume is covered; general event-ordering chaos (interleaved store events) has no property suite.
4. **Fail-first (guard-weakening) coverage exists only in C2's pending PR** — the landed suites never run against weakened-guard modules in CI.
5. **Explicitly out of scope** in the landed suites' own coverage limits: two overlapping sweeps (enforcer-lock concurrency), live board posting (dry-run only), clock-skew compensation.
6. **WAVE-400 boundary**: this report covers the permanent prevention layer (deterministic, seeded, in-repo, every-PR). WAVE-400's one-off fuzzing runs (k6 harnesses, qa2-fuzz, mime-fuzz, external probes) are not duplicated here.

## Files

- This report: `~/workspace/project-room-qa/product200-reliability/CHAOS-REPORT.md`
- Docs PR copy: `docs/PRODUCT200-CHAOS-REPORT.md` (follows the B12 `docs/PRODUCT200-IDEMPOTENCY-REPORT.md` convention)
- Verify log: `~/workspace/product200-c1214-consol/.tmp/chaos-verify.log` (batches 2–3) — local only, not committed
