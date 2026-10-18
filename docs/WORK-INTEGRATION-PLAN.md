# Integrated candidate and recovery qualification

Starting candidate: `87463452`. Selected remote main: `02cfd142` (2026-10-18).
This executes the next gates in [the cutover plan](WORK-CUTOVER-PLAN.md).

## Execution plan

1. Integrate the fetched main revision into the isolated candidate without rewriting
   its existing history. Inspect overlapping changes, regenerate the candidate
   manifest only if its inputs changed, and preserve upstream tests.
2. Identify the actual supported host contract and available execution facilities.
   Exercise the existing Mac host path, native launch guards and interruption/retry
   harnesses. Keep the Linux sandbox fail-closed; report unavailable facilities
   rather than removing protection or claiming simulated sleep is physical sleep.
3. Rehearse backup and restore with canonical work, exact receipts and later
   authority revocations. Verify full application-table comparison, retained
   evidence, stale authority detection, safe refusal and reopening/retry behavior.
   Use synthetic temporary databases only; do not restore production.
4. Fix genuine portability or integration defects surfaced by these checks.
   Retain meaningful negative controls. Run the affected tests, browser/Worker
   journeys, lint, documentation check and full unit suite on the final candidate.
5. Run the shared room benchmark once against selected main after code stabilizes;
   retain raw data and the complete table, including negative/inconclusive results.
6. Commit the integrated candidate and qualification evidence. State separately
   which gates passed, which failed and which cannot be exercised on this machine.
   No merge to public main, production deployment, physical laptop suspension or
   new third-party infrastructure is implied by this local qualification exercise.

## Completion criteria

Main is an ancestor of the candidate; upstream behavior remains covered. Recovery
proves work payload survival and stale-authority refusal. Host evidence names the
actual runtime and the boundary exercised. Every remaining failure has an exact
reproduction or a concrete next execution requirement. Release readiness is not
inferred from baseline-equivalent failures or from benchmark speed.

## Host architecture and observed evidence

Reuse App Server for native execution and retain Room ownership of authority,
publication and retry receipts. This fits the [official OpenAI guidance](https://developers.openai.com/blog/codex-as-a-platform)
on integrating an existing agent harness rather than rebuilding its lifecycle.
No new scheduler or runtime was introduced.

- Integrated main `02cfd142` with merge `57396753`; no conflicts. Upstream escrow
  lot-state indexing and its negative-control query-plan tests are retained.
- Fresh private profile: installed Codex 0.159.0 passed initialize, history and
  resume without model credentials or a model turn.
- [Live native-host report](work-integration-host.json): an existing dedicated
  authenticated profile completed one real synthetic model turn against local Room.
  The published result survived host-process/journal close and reopen. Retrying
  returned the same result, with exactly one total model start.
- The native transport/assistant tests additionally exercise controls, changed
  input, unknown outcomes and protocol failure using deterministic fake runtimes.
  These are not claims of physical sleep/wake or real-tool behavior.
- No Linux container runtime was available on this Mac. Linux isolated-host tests
  remain required on Linux; the implementation continues to refuse execution here.

## Recovery rehearsal

`node scripts/restore-rehearsal.mjs` now captures populated canonical work and its
command receipt, advances the live task, withdraws authority, and reopens the stale
backup. The captured payload and exact retry survive without a new event. All seven
withdrawn authority entries are detected. This proves detection and data survival;
it does not authorize putting a stale backup into service.

The recovery comparison regression also asserts that a later canonical task
revision appears as a work_entities difference and still refuses reopening. The
full recovery suite compares every application table and retained exact receipts.

## Portability defects repaired

The invariant gate compared lexical paths, so macOS /var → /private/var resolution
could silently prevent its main entrypoint from running. It now compares canonical
filesystem paths when needed; tests cover symlink identity, unrelated files and
paths with spaces. V8 coverage fixtures and the bridge assertion now use canonical
paths, matching the actual runtime/bridge contract without weakening isolation.

## Integrated benchmark

Ran once with the default six samples at 1,000 and 4,000 messages:
`npm run bench:room -- --base 02cfd142 --out docs/work-integration-bench.json`.
[Raw samples](work-integration-bench.json) are retained. Runtime source is the
integrated commit `57396753`; the dirty changes at measurement time were
qualification scripts, tests and docs. This compares the full integrated branch
against main, not just the latest portability repairs.

**Validity:** all 1,000-message writes succeeded. At 4,000 messages both sides
refused 140 of 200 writes in every round (1,680 total refusals), while projection
size reached 4,096 KiB. The larger-room write timings mix success and refusal and
must not be presented as successful-write performance. Replay is n/a there because
the event sequence exceeds the configured replay cap. Read measurements describe
the resulting saturated room, not an unrestricted growth workload. No rerun was
used to obtain favorable results.

Room-scale benchmark · head 57396753+changes vs base 02cfd142 (02cfd142)
6 runs per side, alternating, fresh process each · 200 writes per run · bodies inline · Node v24.19.0 · Apple M5 (10 cores)

Room of 1000 messages
| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 5.95 [5.35–6.75] | 5.06 [5.00–5.93] | 0.85x | 0.045 | **better** (15% less) |
| write p95 (ms) | 9.98 [9.27–11.05] | 8.98 [8.57–9.74] | 0.90x | 0.035 | **better** (10% less) |
| storedProjection (ms) | 0.88 [0.83–0.91] | 0.88 [0.85–0.95] | 0.99x | 0.777 | ~ |
| cold room() (ms) | 1.56 [1.55–1.79] | 1.65 [1.57–1.91] | 1.06x | 0.312 | ~ |
| projection (KB) | 1211 [1211–1211] | 1211 [1211–1211] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 3.69 [3.34–4.05] | 2.09 [1.88–2.86] | 0.57x | 0.017 | **better** (43% less) |
| GET full room (KB) | 1323 [1323–1323] | 1323 [1323–1323] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 9.19 [8.15–9.72] | 7.12 [6.66–8.10] | 0.78x | 0.017 | **better** (22% less) |
| GET recent window (KB) | 221 [221–221] | 221 [221–221] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 5.71 [5.52–6.15] | 4.45 [4.30–4.95] | 0.78x | 0.017 | **better** (22% less) |
| replay from log (ms) | 414 [390–543] | 109 [105–119] | 0.26x | 0.017 | **better** (74% less) |

Room of 4000 messages
| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 19.3 [17.7–21.6] | 19.6 [14.0–22.9] | 1.02x | 1.000 | ~ |
| write p95 (ms) | 38.9 [30.9–45.0] | 35.9 [32.0–37.9] | 0.92x | 1.000 | ~ |
| storedProjection (ms) | 3.42 [3.18–3.82] | 3.51 [2.84–4.50] | 1.03x | 1.000 | ~ |
| cold room() (ms) | 7.32 [6.27–7.79] | 6.60 [5.21–9.01] | 0.90x | 1.000 | ~ |
| projection (KB) | 4096 [4096–4096] | 4096 [4096–4096] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 12.7 [11.2–14.4] | 6.89 [5.53–9.29] | 0.54x | 0.015 | **better** (46% less) |
| GET full room (KB) | 4210 [4210–4210] | 4210 [4210–4210] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 27.1 [24.3–75.6] | 18.4 [14.3–22.4] | 0.68x | 0.015 | **better** (32% less) |
| GET recent window (KB) | 226 [226–226] | 226 [226–226] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 14.4 [13.4–16.6] | 8.27 [6.91–10.71] | 0.57x | 0.015 | **better** (43% less) |
| replay from log (ms) | n/a | n/a | n/a | n/a | n/a |

Note: 1680 benchmark writes were refused; check the fixture before trusting write numbers.
Verdicts need a Holm-adjusted p < 0.05 across this size's metrics and a move of 10% or more. Under 6 runs, intervals span the full range.

The 1,000-message case reports 15% lower write p50, 74% lower replay time and
43% lower snapshot-build time under the shared test's significance rule. These
are same-machine measurements, not service SLOs. The inline projection capacity
limit remains a release constraint; work-payload extraction does not remove the
message-cap problem. Qualify the selected message-storage mode before promising
large-room growth. The harness should suppress successful-write verdicts whenever
writes are refused; the raw refusal counts must remain visible.

## Final local qualification

[Machine-readable report](work-integration-qualification.json):

- Integrated runtime: `57396753`, with main `02cfd142` verified as an ancestor.
- Full suite: 11,107 pass, 25 fail, 8 skip (11,140 tests). Twenty-four failures
  exactly match baseline Linux-only host cases. The additional scanner false
  positive was found in the now-tracked shared benchmark diagnostic expression.
- That expression was rewritten without scanner exceptions. All 43 final targeted
  tests pass, including the complete secret-scan self-check, benchmark statistics,
  recovery comparison and invariant gate. The full suite was not rerun after this
  diagnostic-only repair; do not describe it as a fully green run.
- Initial focused integration/native/portability checks: 142 pass. Final browser,
  Worker and recovery journeys: 15 pass. Lint: zero errors, 290 warnings.
- Restore rehearsal: all seven stale authority records detected; canonical task
  payload and exact command receipt survive backup/reopen/retry without another event.
- The shared benchmark was not rerun after the diagnostic-only expression change.

## Open release gates and exact next actions

| Gate | State | Next execution |
|---|---|---|
| Selected-main integration | Complete locally | Review the integrated diff; do not reset shared main |
| Native Mac protocol and model/result restart | Passed for bounded synthetic request | Retain the private host journal for any uncertain future attempt |
| Backup/restore and stale authority | Passed on synthetic data | Keep production offline during any actual restore; reconcile current authority first |
| Linux isolated host | Not run on supported OS for this candidate | Publish the reviewed branch as a draft PR and run existing Ubuntu CI, which provisions Bubblewrap; no protection bypass |
| Physical interruption | Open | A coordinated real Mac sleep/wake and in-flight redirect trial; process restart alone is not equivalent |
| Large-room growth | Open | Qualify and select bounded/entity or bodies-at-rest mode against the same workload; retain the failed inline-capacity result |
| Production release | Standing authorization granted by John on 2026-10-18; qualification remains open | Exact-candidate green gates, release review and coordinated deployment |

A draft PR description with the complete benchmark table is prepared locally at
`/tmp/work-integration-pr-body.md`. No branch publication, public-main merge or
production deploy was performed at the original qualification checkpoint. John removed
the current-session publishing restriction on 2026-10-18; publish this candidate for
remote CI next. Local checks cannot certify the Linux boundary.
