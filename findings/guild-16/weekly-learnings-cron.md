# weekly-learnings cron — doc verification

Generated 2026-10-09T11:16:32.383Z. The cron lives outside the repo (runtime cron tool, like wave-seeder/verified-digest); this checks the doc against the script and tests.

- script exists: true
- tests exist: true

## Claim check

| claim | in doc |
|---|---|
| schedule: Mondays ~08:05 PDT | yes |
| posts one digest to muse-room | yes |
| skip when signal < 3 | yes |
| week never posted twice (sent.log) | yes |
| watermark committed only after successful post | yes |
| dry runs strictly read-only | yes |
| spill file on page-cap then exit 1 | yes |
| state dir override WEEKLY_LEARNINGS_STATE_DIR | yes |

## Script cross-check

| behavior | in script |
|---|---|
| 4000 char cap | yes |
| sent.log write | yes |
| spill write before cursor advance | yes |
| --dry-run flag | yes |
| --post flag | yes |
| exit 1 on error | yes |

**Drift:** none found — doc matches script

## Failure modes

- gh unauthenticated → exit 1, no state written (watermark fail-closed).
- room API failure mid-walk → spill file written BEFORE cursor advance; next run replays the spill (no fetched event skipped).
- Event walk hits page cap on dry run → clean fail, no state written.

## Gotchas

- NOT in the repo's workflow set: registration is manual via the runtime cron tool. If the cron is deleted, nothing in CI notices — the doc is the only record.
- Requires gh auth + ~/.config/jill-room credentials on the machine that runs it.
