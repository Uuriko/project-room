# Config C7: trace-entry bot-PR pattern vs branch protection

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## The pattern (trace-entry.yml)
On every merged PR (`pull_request_target: closed`), a bot opens a PR appending
one line to `docs/ROOM-TRACES.jsonl`, then squash-merges it once mergeable.

## Why not a direct push (verified in the workflow header)
Main's branch protection requires status checks on merges — a direct push of a
fresh commit has no passing checks, so it would be blocked. The bot PR goes
through the normal gate (required checks at its head), satisfying protection.

## Why a PAT and not GITHUB_TOKEN (verified)
GitHub suppresses workflow runs for GITHUB_TOKEN-caused events (anti-recursion).
A bot PR opened with GITHUB_TOKEN would never launch CI and could never merge.
The fine-grained PAT (`TRACE_ENTRY_TOKEN`: contents:write + pull-requests:write)
triggers workflows normally. Validated 2026-10-06 via PR #1650.

## Safety properties (verified)
- `pull_request_target` runs the **base branch's** workflow file; it checks out
  main only — merged PR code is never executed. (Header lines 24-26.)
- Trace PRs are excluded by the `trace-entry/` head-ref prefix — no regress.
- Concurrency group `trace-entry-main` serializes runs; the ledger stays
  append-only and date-ordered.
- Idempotent per PR number — re-runs reuse the open trace PR, never duplicate.
- Fail-closed: `scripts/check-wiki.mjs` must pass before push; squash-merge only
  when GitHub reports mergeable; otherwise the job fails loudly.

## Interaction with the merge slot
Each merge spawns one trace PR that must itself pass full CI and merge — a
steady background load of ~1 extra CI run per merge. At high merge velocity this
doubles CI consumption. The concurrency group serializes the bot work, so it
cannot DDoS the queue, but it does lengthen the effective merge pipeline.
Documenting as a known cost, not a finding.

## Verdict: PASS. The pattern is the correct answer to the protection-vs-automation
tension, and its failure modes are loud, not silent.
