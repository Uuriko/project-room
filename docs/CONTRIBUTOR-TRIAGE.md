# Contributor review and backlog triage

Use GitHub issues and PRs as the public contribution record. A contributor should
be able to find the next action without joining a private room or reading agent
transcripts. Start with [CONTRIBUTING.md](../CONTRIBUTING.md) for local setup.

## Pick a bounded contribution

- [Good first issues](https://github.com/Uuriko/project-room/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) should name a reproduction, likely files, a small acceptance check and a maintainer willing to help. Do not use this label for uninvestigated failures.
- [Help wanted](https://github.com/Uuriko/project-room/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22) can include investigation and specialist work. State the expected output and required environment.
- Comment on the issue before substantial work; a maintainer records the owner and next step there. Small fixes can arrive directly as a PR. An old issue or silence is not an exclusive claim.

## Make the next action visible

Keep one current review disposition on each active PR, updating it when the head
changes: **review needed**, **author action needed**, **CI pending**, **held with
reason**, or **accepted for landing**. Name the next actor and link the specific
evidence. Use existing `needs-rebase`, `priority:now`, `priority:next` and
`priority:later` labels to organize work; labels are not approval or test results.
Avoid repeated acknowledgement comments and don't promise a response deadline
unless someone has agreed to own it.

The current hosted workflow needs a non-draft PR and the maintainer-applied
`ready-to-land` label to run substantive CI. That label starts testing; it does
not certify readiness. A green **NOTHING RAN** summary is not a pass. For forks,
maintainers may also need to approve the Actions run under GitHub's repository
policy. Contributors never need production credentials. Inspect untrusted
changes before enabling workflows; do not move fork execution to privileged
`pull_request_target` jobs to bypass approval.

## Snapshot the queue without changing it

From an authenticated read-only GitHub CLI session, inventory metadata first.
Fetching every historical check for hundreds of PRs can time out:

```sh
gh pr list --repo Uuriko/project-room --state open --limit 1000 \
  --json number,title,url,headRefOid,isDraft,mergeable,updatedAt,labels,reviewRequests \
  > /tmp/project-room-prs.json
node scripts/contributor-triage.mjs /tmp/project-room-prs.json --limit 1000 \
  > /tmp/project-room-triage.json
```

Then inspect a bounded, explicitly selected queue with checks:

```sh
gh pr list --repo Uuriko/project-room --state open --search 'label:priority:now' --limit 50 \
  --json number,title,url,headRefOid,isDraft,mergeable,updatedAt,labels,reviewRequests,statusCheckRollup \
  > /tmp/project-room-selected-prs.json
node scripts/contributor-triage.mjs /tmp/project-room-selected-prs.json --limit 50
```

Metadata-only records say `ci-unobserved`, not failed or skipped. Counts describe
the exported query, so a selected queue is never a repository-wide inventory.
Only run the report after the export command succeeds; a failed export is not an
empty queue.

The report records exact heads and separates drafts, conflicts, running checks,
failures, absent tests and candidates needing review. If `possiblyTruncated` is
true, increase the export limit and regenerate before reporting repository-wide
counts. Unknown mergeability stays unknown. Cancelled or failed older duplicate
runs are conservatively flagged for inspection. The report never closes, labels,
merges, approves or deploys anything, and no bucket means release-ready.

For a selected PR, re-read its head and inspect the relevant run's actual jobs.
Distinguish affected tests from full suites. If main also fails, compare exact
failure names and revisions; an unrelated PR's failure is not a baseline proof.
Use [the deployment lane](DEPLOY-LANE.md) for release work.

## Reduce the backlog without losing contributions

Close a duplicate or superseded PR only after linking the accepted replacement
and checking that its intended behavior is covered. If useful work remains,
record that remainder in an issue before closing, with the old PR and source
revision linked. A closure comment should state the reason and how to reopen or
continue. A deliberate scope rejection needs a specific maintainer decision.

Age, conflicts, draft status, a failed check or an unavailable author alone are
not evidence that a contribution is obsolete. Use `needs-rebase` or
`priority:later` and record the next action. Preserve author branches by default;
review unique commits, dependent PRs and recovery needs before deleting one.
Do not run blanket stale-close or branch-deletion automation.

## Check whether this process helps

For outside contributions, record time to first actionable response, time from
review request to disposition, and how many PRs have a named next actor. Count
withdrawn and rejected submissions as dispositions, not merged successes. Track
reopened closures and contributor return visits; fewer open PRs alone is not
proof of a healthier community.
