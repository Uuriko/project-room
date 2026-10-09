# server/claim-coordination.mjs

Pure, I/O-free helpers for room-native claim coordination. Three jobs:

1. **Pull-request settlement**: parse canonical PR URLs, reduce webhook payloads
   and polled API bodies to outcomes (`merged`/`closed`/`open`), and settle live
   claims on PR close (merged → `done`, closed → released/unclaimed).
2. **File-lease exclusivity**: detect when two live claims hold overlapping
   repository paths (with optional named `fileBlocks` sub-slots).
3. **Dependency readiness**: `readyClaims` finds unclaimed claims whose
   `dependsOn` are all `done`.

The module also owns PR poll scheduling: backoff ladders (`nextPullBackoff`),
ETag handling (`usableEtag`), GitHub rate-limit holds (`rateLimitUntil`,
`holdForRateLimit`), and CI rollup (`rollupClaimCi`).

Does no I/O itself — callers (claim-pr-sync.mjs, work-claim-routes.mjs,
work-claims.mjs, claim-autolink.mjs) do the fetching/persisting.

## Public API

| Export | Behavior |
|---|---|
| `nextPullBackoff(currentMs, token)` | Next poll delay: 1→2→4→8→10 min with a token, flat 10 min anonymous. |
| `usableEtag(value)` | Accepts short printable tokens only; anything else → null. |
| `rateLimitUntil({status, remaining, reset, retryAfter, message}, nowMs)` | When GitHub is rate-limiting, the ms epoch to hold polls until. A bare 403 without budget exhaustion is *not* a limit. |
| `parsePullRequestUrl(value)` | Canonical `https://github.com/{owner}/{repo}/pull/{n}` or null. Refuses query strings, fragments, credentials, non-github hosts, >300 chars. |
| `pullRequestOutcomeFromWebhook(payload)` | Only `action === "closed"` settles; `merged: true` → `merged`, else `closed`. All other actions ignored. |
| `pullRequestOutcomeFromApi(body)` | Polled pull body → `merged` / `closed` / `open`. |
| `settlePullRequest(item, outcome, nowMs)` | Applies merged/closed to a live claim. Returns `{action, previousOwnerId, paths, item}` or null when not live / lease lapsed / PRs not all decided. Merged → `state: done`, `deliveryMode: "merged"`. Closed → released (owner, lease, files, attestations, reviews cleared). |
| `rememberPoll(item, nowMs, delayMs, {etag, rateLimitedUntil})` | Records an unsettling poll: `syncedAt`, `nextPollAt`, backoff, ETag. |
| `holdForRateLimit(item, nowMs, until)` | Holds every open link until GitHub's reset; keeps the ETag for conditional retry. |
| `rollupClaimCi({status, checkRuns, pullUrl})` | Reduces commit status + check runs to `{state: failure\|pending\|success\|neutral, url}`. Failure wins; neutral only when nothing ran or everything was neutral/skipped. |
| `pullRequestDue(item, nowMs)` | Whether the claim's PR needs polling now (has URL, no outcome, live, not rate-held, `nextPollAt` passed). |
| `pullLinks(item)` | All linked PRs: `pullRequests[]` when present, else the single `pullRequest`. |
| `recordPullOutcome(item, url, outcome, nowMs)` | Marks one link decided; repoints `pullRequest` at the first still-open link. |
| `pullsReadyToSettle(item)` | True when ≥1 link and every link has an outcome. |
| `batchPullOutcome(item)` | `merged` if any link merged, else `closed`. |
| `fileLeaseConflicts(items, claimed)` | Live claims whose declared files intersect `claimed`'s (block-aware). Sorted by claim id. |
| `fileLeaseConflictBody(claimed, conflicts)` | Shapes the `file_lease_conflict` 409 body naming the first holder + expiry. |
| `readyClaims(items)` | Unclaimed, ownerless claims whose `dependsOn` are all `done`. Missing dependency = not done. Empty deps = ready. Sorted by id. |

Constants: `PULL_POLL_BACKOFF_MS` (60s), `PULL_MISSING_BACKOFF_MS` (1h),
`PULL_CANDIDATE_CAP` (32).

## Lease / settlement lifecycle (ASCII)

```
unclaimed ──claim──▶ claimed ──renew──▶ claimed (lease extended)
    │                    │  heartbeat (implicit via renew)
    │                    ├──release──▶ unclaimed
    │                    ├──expire──▶  unclaimed (lease_expired event)
    │                    └──PR merged──▶ done (deliveryMode merged)
    │                    └──PR closed──▶ unclaimed (files cleared)
    └──readyClaims: unclaimed + all dependsOn done → eligible to claim
```

`#1526 B2` rule: a lapsed lease is **never** settled — a merged PR on a dead
round keeps the `lease_expired` event, it is not credited as done.

## Invariants

- Pure: no I/O, no clock (all functions take `nowMs`).
- `settlePullRequest` returns null unless the claim is live, the lease is
  current, and *every* linked PR has an outcome.
- The settled record names the PR the outcome was decided on: the merged link
  when the batch settled merged, otherwise the last recorded link.
- File conflicts compare paths as stored; a claim with no files never conflicts.
- Block-aware slots: two claims conflict on the same path only when at least
  one of them names no block, or both name the same block.

## Top callers

- `server/claim-pr-sync.mjs` — poll scheduling + outcome application.
- `server/work-claim-routes.mjs` — HTTP paths, file-lease conflict checks.
- `server/work-claims.mjs` — state machine integration.
- `server/claim-autolink.mjs` — PR URL parsing.

## Gotchas

- `PULL_BACKOFF_STEPS_MS` is frozen; the ladder is 1/2/4/8/10 minutes —
  anonymous GitHub (60 req/hr per shared IP) waits the full 10 min.
- `usableEtag` silently drops anything non-printable or >200 chars; a dropped
  ETag just means the next poll is unconditional, not an error.
- `rollupClaimCi` returns `neutral` when *nothing ran* — callers must not read
  that as "CI passed".
- `readyClaims` treats a dependency id with no matching item as not-done
  (never ready), so a dangling `dependsOn` permanently parks the claim.

## Stale comments

None found — the header comment accurately describes the module (no webhook
receiver in this service; the tick polls), and inline comments match the code.
