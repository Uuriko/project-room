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
