# Gate G4: branch protection `strict: false` — behind-branch merges

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Evidence
Branch protection API on main: `required_status_checks.strict = false`.

## What it means
A PR whose head is behind main can merge as long as ITS OWN head's required
checks are green. The checks ran against a merge-base that is older than the
current main tip — i.e. the merge is never tested against the actual resulting
tree.

## Compounding factors in this repo
1. **Advisory reviews** (`required_approving_review_count: 0`): no human is forced
   to look at a stale branch before merge.
2. **High merge velocity**: many parallel lanes + bot PRs (trace-entry) mean main
   moves fast; a PR opened in the morning is routinely dozens of commits behind
   by merge time.
3. `enforce_admins: true` and `required_conversation_resolution: true` do not
   compensate — they gate different things.
4. Partial mitigation: several workflows (`test.yml`, `schema-gate.yml`, `mime-fuzz.yml`,
   `machine.yml`, `relay.yml`, `staging.yml`, `mcp-registry-publish.yml`) re-run on
   `push: [main]`, so the merged tree IS tested post-merge — but failures there are
   post-hoc (main is already red/broken) rather than preventive.

## Verdict: GAP CONFIRMED (config-level). Flipping `strict` to true needs John's
tap (repo-settings change) and has a real cost at this merge velocity (every PR
would need rebase + full CI re-run before merge). Documenting as a known,
accepted trade-off with post-merge push runs as the backstop — proposing it as
a tap item, not a BUG.
