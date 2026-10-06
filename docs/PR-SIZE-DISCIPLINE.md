# PR size discipline

Smaller diffs rebase cleaner, review faster, and collide less. This is the
room's standing norm, enforced by CI with a human fallback.

## The rule

- A pull request should change **300 lines or fewer** (added + deleted).
- A PR over the budget must carry a **justification section** in its body:

  ```markdown
  ## Why this is large

  <why this cannot be split into smaller PRs>
  ```

  Accepted headings (case-insensitive): `Why this is large`,
  `Size justification`, `Justification`, `PR size`, `Large PR justification`.
  The section needs real substance (at least 30 non-whitespace characters) —
  an empty heading does not count.

## The CI check

`.github/workflows/pr-size-discipline.yml` runs on every PR (opened, edited,
synchronize, reopened) and calls `scripts/pr-size-check.mjs`:

- Computes the diff with `git diff --numstat <base>...<head>`. Binary files
  count as one changed line each so they are not invisible to the budget.
- **warn mode (default):** the check stays green and posts (or updates, or
  removes when fixed) a warning comment on the PR.
- **require mode:** the check fails when the PR is over budget and unjustified.

### Configuration

Resolution order: defaults → `.github/pr-size.json` → environment / workflow
inputs.

| Setting | Default | Sources |
|---|---|---|
| `limit` | 300 | `.github/pr-size.json`, `PR_SIZE_LIMIT` env, repo variable `PR_SIZE_LIMIT` |
| `mode` | `warn` | `.github/pr-size.json`, `PR_SIZE_MODE` env, repo variable `PR_SIZE_MODE` |

To run locally against any two refs:

```bash
BASE_SHA=<base> HEAD_SHA=<head> PR_BODY="$(cat body.md)" node scripts/pr-size-check.mjs
```

or feed it directly:

```bash
git diff --numstat main...HEAD > /tmp/ns.txt
node scripts/pr-size-check.mjs --numstat-file /tmp/ns.txt --pr-body-file body.md --limit 300 --mode warn
```

## Room norm fallback

When CI cannot run (fork PRs with a read-only token, Actions outage), reviewers
apply the same rule by hand: over-budget and unjustified → ask for the section
or a split before approving. The check never blocks a merge on its own in warn
mode; it exists to make the norm visible at the moment of opening the PR.

## Splitting guidance

Before writing a justification, try:

1. **Stack it:** land the refactor first, the behavior change second.
2. **Slice by surface:** one PR per file-area or per endpoint.
3. **Separate test-only changes:** generated fixtures and snapshots inflate
   diffs; they are the cheapest thing to split out.

If none of those work, the justification section is the honest record of why.
