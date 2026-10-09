# server/claim-coordination.mjs — PR polling, outcomes, file leases

Room-native claim coordination. **No I/O in this module** — a closed
`pull_request` webhook payload and a polled pull API body both reduce to the
same outcome string, and the scheduled tick polls. Pure functions over claim
items.

## PR URL parsing

`parsePullRequestUrl(value)` → `{url, repo, number}` (frozen) or `null`.
Canonical form only: `https://github.com/{owner}/{repo}/pull/{number}`.
Refused (null, never throws): query strings, fragments, credentials, ports,
non-`github.com` hosts, `pull/0`, non-numeric numbers, >300 chars, bad shapes.
Canonicalized (accepted, normalized): trailing slash, default `:443` port,
surrounding whitespace, hostname case.

## Outcomes

- `pullRequestOutcomeFromWebhook(payload)`: only `action: "closed"` settles;
  `merged: true` → `"merged"`, else `"closed"`. Everything else → `null`.
- `pullRequestOutcomeFromApi(body)`: `merged === true` → `"merged"`;
  `state === "closed"` → `"closed"`; else `"open"`. Strict `=== true` —
  truthy non-booleans do not merge.
- `recordPullOutcome(item, url, outcome, nowMs)`: stamps one link (outcome,
  syncedAt, clears nextPollAt/rateLimitedUntil); unknown URLs leave links
  untouched. Current `pullRequest` = first open link, else the last link.
- `pullsReadyToSettle(item)`: every link has a `merged`/`closed` outcome.
- `batchPullOutcome(item)`: `"merged"` if any link merged, else `"closed"`.

## Settlement

`settlePullRequest(item, outcome, nowMs)` → `{action, previousOwnerId, paths,
item}` or `null`. Guards, in order:

1. Item must be in a live state (`claimed`/`in_progress`/`blocked`).
2. **#1526 B2: a lapsed lease is never settled** — a merged PR on a dead
   round is not credited as done (the `lease_expired` event stands).
3. All links decided (`pullsReadyToSettle`).
4. Outcome is `merged` or `closed`.

`merged` → state `done`, `deliveryMode: "merged"`, history `pr_merged`; the
settled record names the **merged link** (a later closed link must not stand
in for it). `closed` → state `unclaimed`, owner/lease/files/fileBlocks/
attestations/reviews cleared (same shape as a holder release), history
`pr_closed`. `paths` carries the files the claim held so receipts can name
the freed lane.

## Polling / backoff

- `nextPullBackoff(currentMs, token)`: authenticated polls grow
  1, 2, 4, 8, then 10 minutes (`PULL_BACKOFF_STEPS_MS`); unauthenticated →
  10 minutes flat (`PULL_BACKOFF_ANON_MS`) — 60 req/hour/IP shared with the
  land queue. `PULL_CANDIDATE_CAP` = 32.
- `usableEtag(value)`: short printable token or null.
- `rateLimitUntil({status, remaining, reset, retryAfter, message}, nowMs)`:
  429, or 403 with exhausted budget / "rate limit" message → hold-until ms.
  Bare 403 is **not** a rate limit. Missing/expired reset → `nowMs + 60s`
  so the tick doesn't hammer the refusal.
- `pullRequestDue(item, nowMs)`: link has URL, no outcome, live state, not
  rate-held, `nextPollAt` reached.
- `rememberPoll(item, nowMs, delayMs, {etag, rateLimitedUntil})`: records a
  non-settling poll (syncedAt/nextPollAt/backoff/etag).
- `holdForRateLimit(item, nowMs, until)`: pushes every open link's
  `nextPollAt` to at least `until`; keeps the ETag for conditional requests.

## CI rollup

`rollupClaimCi({status, checkRuns, pullUrl})` → `{state, url}`. Failure wins;
anything running → pending; all-success → success; only neutral/skipped or
no signal → neutral. `url` = first `https://` status target, else `pullUrl`,
else null. Hostile inputs (null runs, non-array, odd conclusions) never throw.

## File leases

- `fileLeaseConflicts(items, claimed)`: live claims whose declared files
  intersect the candidate's. Whole-file entry conflicts with any block label
  on that path; two block labels conflict only when equal. One entry per
  holding claim, sorted by claim id.
- `fileLeaseConflictBody(claimed, conflicts)`: the 409 body —
  `file_lease_conflict` with holder, files, and lease expiry.
- `readyClaims(items)`: unheld `unclaimed` items whose `dependsOn` are all
  `done`. **A missing dependency is not done** — deleting a claim waives its
  id from dependents' `dependsOn` (see work-claim-sqlite `delete`), so no
  claim is stranded ownerless and invisible.

## Gotchas

- `settlePullRequest` reads `item.pullRequests` via `pullLinks`, which falls
  back to the legacy single `item.pullRequest` — both shapes work.
- The lapsed-lease guard uses `Date.parse(leaseExpiresAt) <= nowMs`; a lease
  expiring *exactly* now is treated as lapsed (fail-closed).
- Backoff steps are compared with `step > current`, so re-polling at exactly
  a step boundary advances to the next step.
