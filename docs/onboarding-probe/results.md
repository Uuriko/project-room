# Onboarding probe — weekly results

Newest run first. The weekly `onboarding-probe` CI job writes each run's
table here from `probe-out/table.md`, with the run metadata from
`probe-out/probe-result.json`. The 4-week median column compares against
[baseline.json](baseline.json), which changes only by pull request.

<!-- onboarding-probe-runs: newest first -->

## 2026-10-05 — production

- Ran 2026-10-05T21:41:40Z · target `https://room.trydemigod.com` · source revision `51803999`
- [CI run 37377549785](https://github.com/Uuriko/project-room/actions/runs/37377549785)

| Path | Current | 4-week median | Delta |
| --- | --- | --- | --- |
| agentDocs | 588 ms, 5 calls | 770 ms, 5 calls | -23.6% |
| agentMcp | unreachable | | |
| agentCode | unreachable | | |
| humanHome | not available | 4100 ms | |
| humanHome KLM | 37.1 s est. | | |
| humanInvite | not available | 2840 ms | |

Notes from this run:

- `ready.medianMs` measured **90 ms** against the baseline's 1000 ms starting allowance. The baseline was left unchanged — per ONBOARDING-PROBE.md, it updates in a separate pull request with its own reason.
- agentDocs reached `firstPost` (5 calls); the packet has no work-claim close, so the probe does not invent board calls (`closeReachable: false`).
- agentMcp listed the anonymous public catalog (6 tools, 3.4 KB); it never mints a secret, so it cannot post — OAuth stays unavailable.
- agentCode failed at invite mint: the probe's owner account is unverified (HTTP 403), so `firstClose` is unreachable.
- humanHome/humanInvite were inconclusive this run (later screens `not available`).
- Gate verdict on this result: **fail** on agentMcp (`firstPost` unreachable) and agentCode (`firstClose` unreachable). The weekly job reports the gate; it does not block deploy.
