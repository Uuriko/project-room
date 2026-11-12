# Release merge gate

The `ready-to-land` label requests optional hosted qualification. It is not permission to merge or deploy, and an independent review is advisory. A push by itself does not start the label-gated jobs. Choose useful validation for the change as described in [AGENTS.md](../AGENTS.md); reuse unchanged exact-source evidence where it remains applicable.

Actual GitHub protection and deployment workflow checks are separate enforcement. This document describes triggers; it does not waive those checks or require production to be healthy before an unrelated change can merge.

## ready-to-land

The landing loop adds the `ready-to-land` label with a user token (a personal access token or a GitHub App installation token). A label added with `GITHUB_TOKEN` does not start a new workflow run. GitHub suppresses workflow runs for events the default token causes, so the landing loop must not use `GITHUB_TOKEN` to apply this label.

The heavy workflows listen for `labeled` and `synchronize`. `labeled` is what starts the run when the label appears. `synchronize` re-runs it on later pushes while the label is still present. `ready_for_review` is also listed, so a labeled draft that is marked ready starts CI without another push.

Each heavy job is gated with:

```
github.event_name != 'pull_request' || (github.event.pull_request.draft == false && contains(github.event.pull_request.labels.*.name, 'ready-to-land'))
```

`github.event_name != 'pull_request'` is first, so a push to `main`, a schedule, `workflow_dispatch`, and `merge_group` do not read the label. On a pull request both sides are required: the PR is not a draft, and its labels include `ready-to-land`. A draft stays skipped even with the label on it.

`labeled` fires for every label change. While `ready-to-land` is already present, adding or removing a different label starts another run and the concurrency group cancels the older one. The landing loop should add `ready-to-land` once, then leave labels alone until that run finishes.

## Checks that report

On a non-draft pull request that has `ready-to-land`, these check names still report from `.github/workflows/test.yml`: `test`, `contract`, `lint`, `browser`, `cloudflare`. The job id is the check name. A docs-only diff still runs those jobs and short-circuits them to success, so the names report. An unlabeled pull request does not start them.

The redundant `room/release-lease` GitHub status is no longer required. The landing coordinator still serializes merges and verifies the current PR head and base; do not reinstall the old status requirement.

## What runs on every pull-request push

These stay ungated. They do not look at `ready-to-land` and they run on drafts:

- `pin-gate.yml` (still limited to workflow, action, and lockfile paths)
- `review-mechanical.yml`

## Pull-request safety net

`.github/workflows/test.yml` job `safety-net` runs on every pull request, including drafts. It does not look at `ready-to-land`. It runs `npm run lint`, the story unit tests, and the page-weight measurement with Chromium installed. The labeled unit job also keeps those tests in its selection, and the labeled browser shards keep the browser journey checks.

## Affected suites

A pull request with `ready-to-land` runs `node scripts/unit-ci.mjs --affected` and browser shards with `CI_BROWSER_SCOPE=affected`. Both selections come from `scripts/ci-affected.mjs` and always include the safety-net files. Pushes to `main`, `merge_group`, the nightly schedule, and `workflow_dispatch` run `unit-ci.mjs --all` and the full browser suite. `node_modules` and `cloudflare/node_modules` are cached from the lockfiles. Browser shard membership is balanced from `scripts/browser-ci-durations.json`.

## What stays on its previous trigger

Pushes to `main` still run `test`, `schema-gate`, `pr-gates`, `machine`, and `relay` the same way they did before the label. `deploy-prod.yml` and `rollback-prod.yml` are unchanged. Post-merge `pull_request_target` workflows (`room-work-sync`, `trace-entry`) are unchanged.

The label gate is on the pull-request jobs in:

- `test.yml`
- `schema-gate.yml` (docs-only pull requests still skip the workflow by path; the `main` push does not)
- `pr-gates.yml` (the nightly quarantined-tests job stays on schedule and `workflow_dispatch`)
- `machine.yml`
- `relay.yml`


## autoland

The `autoland` label opts in to squash-merging and then dispatching production
deployment through `deploy-prod.yml`, even when `ROOM_AUTO_DEPLOY` is unset.
It is not applied automatically. `.github/workflows/autoland.yml` squash-merges an open,
non-draft pull request only when all of these hold:

- The PR carries the `autoland` label and targets `main`.
- `mergeable_state` is `CLEAN`.
- Every latest check on the current head has completed successfully
  (or `skipped` / `neutral`), including individual browser shards. The
  repo does not mark those shards as optional.
- The named checks from this document are present and green:
  `safety-net`, `mechanical`, `test`, `contract`, `lint`, `browser`,
  `cloudflare`. Add `ready-to-land` so the labeled suite actually runs;
  `autoland` alone does not start it. `pin-gate` and `schema-gate` are
  required only when they reported on that head.

There is no review gate in this workflow. A user or GitHub App token
must be stored as the `LANDING_TOKEN` secret so the merge push can start
`test` and `schema-gate`. Merges made with `GITHUB_TOKEN` would not start
those workflows, so the job refuses to merge without the secret and writes
that gap to the job summary.

A required check name with only `skipped` results does not count as green:
that means the labeled suite never ran. When one name reports from several
runs on the head, a real result beats a later `skipped` one, so an unrelated
label change cannot hide an earlier failure.

After the batch, autoland dispatches the existing `deploy-prod.yml` workflow
on the new main tip right away. The deploy gate waits up to five minutes for
the `schema-gate` push run on that commit, so the dispatch does not race it.
Production smoke, recovery to the previous prod SHA, and deploy or rollback
receipts to the release room are unchanged and stay in `deploy-prod`. Autoland
itself posts one line per merge and deploy dispatch when `ROOM_RECEIPT_TOKEN`
is set; if that secret is missing, the same lines go only to the job summary.
If the dispatch itself fails, the job fails and posts a line saying so.
