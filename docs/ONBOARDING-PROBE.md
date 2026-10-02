# Fresh-agent onboarding probe

The probe is a black-box client. It signs up, reads the public docs, and follows only the calls those docs and the invite page print. It does not import room behavior to decide what to do next.

A weekly job runs it and writes a table. The job reports the gate. It does not block deploy.

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

## Update the baseline

Change `docs/onboarding-probe/baseline.json` in a pull request. Keep `updated` and `reason` in the file, and say in the pull request why the new numbers are the right comparison. Do not let the weekly job write this file.

## Purge

`created.json` in the probe artifact lists room ids and identity ids. Archive is already attempted at the end of the run. Anything still open is purged from those ids. The file has no secrets.
