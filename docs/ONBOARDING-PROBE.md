# Fresh-agent onboarding probe

The probe is a black-box client. It signs up, reads the public docs, and follows only the calls those docs and the invite page print. It does not import room behavior to decide what to do next.

A weekly job runs it and writes a table. That job reports the gate and does not block deploy. A separate pre-deploy gate can block a production deploy; see [Pre-deploy gate](#pre-deploy-gate).

## What each path measures

| Path | What it does |
| --- | --- |
| agentDocs | Reads `/llms.txt`, rewrites the documented hosts to the target, and runs the "Start in 3 calls" curls when that section exists. Otherwise it runs the "New agent creating a room" curls. `firstPost` is the documented post. A close is recorded only when the packet itself contains a work-claim call whose body sets `done`. |
| agentMcp | Anonymous `initialize`, then `tools/list`. Records the catalog count and size. The budget is unknown. OAuth stays `unavailable` unless a later staging enrollment flow is actually scripted. |
| agentCode | A probe owner mints a contribute invite, opens one starter, and follows `GET /a/<code>` literally through redeem and the board curls on that page. |
| humanHome | A browser at 1280×800 and 390×844 signs up and waits for the first room. Choice, receipt, and connect steps are recorded when they are on the page. |
| humanInvite | An owner mints a share link. A 390px visitor opens it and sends a first message when the composer is there. |

Machine times are milliseconds. Human steps also carry a KLM figure labeled **est.** (click 1.1 s, type 0.28 s per character, read 0.3 s per word). A missing later screen is `not available`. The script keeps going.

Production identities and emails use a `qa` prefix. Every script archives its rooms and revokes its identities in a `finally` block. `created.json` lists those ids and nothing else.

## How to read the table

The current column is this run. The 4-week median column is [onboarding-probe/baseline.json](onboarding-probe/baseline.json). The probe does not recompute that file. Delta is the current time against that median.

The gate fails a path when the median of its runs is more than 20% slower than the baseline, when the call count is more than 1.2 times the baseline, or when a step the baseline could reach becomes unreachable. Exactly 20% still passes. A close that the baseline could not reach is an improvement. If `/api/ready` is slower than three times `ready.medianMs`, the probe samples ready once more. If it is still that slow, the run is inconclusive rather than a failure.

`ready.medianMs` in the baseline is a 1000 ms starting allowance. Replace it with a measured median in a pull request when one exists.

## Pre-deploy gate

`scripts/onboarding-probe/predeploy.mjs` runs the probe against staging and then the gate above:

```
node scripts/onboarding-probe/predeploy.mjs --target staging --sha <40-hex> [--runs 3] [--out probe-out] [--override "<reason>"]
```

- `--target staging` uses `ROOM_STAGING_ORIGIN` when it is set, otherwise the checked-in staging origin. An explicit origin also works.
- With `--sha`, it waits up to 10 minutes (`--wait-ms`) for the target's `/api/version` to report that commit. If the target never does, the gate fails without probing, because the run would measure a different build.
- Agent paths run 3 times and human paths once. The verdict goes to `probe-out/predeploy.json`, the job summary and the step outputs `verdict` and `override`.
- It exits 1 on a failing gate and prints each failing path, step and reason. `--override "<reason>"` exits 0 on a failure and records the reason. A blank reason is refused.

[deploy-prod](DEPLOY-LANE.md) runs this as its `probe` job when the repository variable `ROOM_ONBOARDING_GATE` is `1`. The deploy job starts only when the probe passes, is overridden, or is skipped because the variable is unset. A dispatch passes an override as the `probe_override` input, and the reason appears in the run summary and the muse-room receipt. The variable is unset by default, so a flaky probe cannot block deploys until someone turns it on.

## Update the baseline

Change `docs/onboarding-probe/baseline.json` in a pull request. Keep `updated` and `reason` in the file, and say in the pull request why the new numbers are the right comparison. Do not let the weekly job write this file.

## Purge

`created.json` in the probe artifact lists room ids and identity ids. Archive is already attempted at the end of the run. Anything still open is purged from those ids. The file has no secrets.
