# GitHub hygiene for project-room

Advisory conventions so the repo's history stays readable for humans (and for
John's brother). These bind nobody until the lane owners agree; they are the
recommendation coming out of the 2026-09-14 audit.

## Merging

- **Use the GitHub "Merge pull request" button.** On 9/14, ~17 PRs were merged
  by hand locally (`git merge` + push, messages like "Merge PR #178 onto
  main"). Hand merges don't link back to the PR page, drop CI's merge-queue
  context, and the hand-resolved conflicts silently dropped wiring (fixed by
  #180). The button exists; use it.
- **Squash or rebase for branch-sync merges.** Long-lived branches accumulated
  dozens of "Merge main into branch" sync commits. Prefer rebasing the branch
  (or merging with a single sync commit) before the final merge.
- **Delete the branch after merge.** GitHub offers the button on merge; take it.

## CI

- Keep every PR to **one CI run per head** — the open PRs currently show
  several duplicate "test" job rows from repeated pushes; that's noise, not
  signal.
- The browser suite has a known flaky family (`scripts/inbox-unified-check.mjs`
  Telegram fixture timeouts). A single unrelated failure is not a code problem;
  rerun once before investigating.

## Schema

- Schema numbers are frozen while PR #197 (v34 convergence) is in flight.
  Schema-changing PRs rebase after it lands.

## Docs

- `docs/` canonical docs are listed in [docs/README.md](README.md). New
  checkpoint/plan notes get a dated filename and stay out of the way.
- Fix or annotate broken internal links when you see them; `test-results/`
  screenshots are local-only and must not be linked as if committed.
