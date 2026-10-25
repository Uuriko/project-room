# Release merge gate

Heavy pull-request CI runs when a pull request is about to land. A push by itself does not start those jobs.

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

`room/release-lease` is a commit status from the landing coordinator. It is not a job in these workflows.

## What runs on every pull-request push

These stay ungated. They do not look at `ready-to-land` and they run on drafts:

- `pin-gate.yml` (still limited to workflow, action, and lockfile paths)
- `review-mechanical.yml`

## What stays on its previous trigger

Pushes to `main` still run `test`, `schema-gate`, `pr-gates`, `machine`, and `relay` the same way they did before the label. `rollback-prod.yml` is unchanged. Post-merge `pull_request_target` workflows (`room-work-sync`, `trace-entry`) are unchanged. `deploy-prod.yml` adds an hourly schedule; the manual path and the optional `ROOM_AUTO_DEPLOY` path are unchanged.

## Landing

`land-ready` merges open, non-draft pull requests to `main` that carry `ready-to-land` and whose current head checks are green. One job merges that batch, oldest pull request number first. It does not push to the other pull request branches and it does not wait for main CI between merges, so those merges do not cancel the other pull requests' runs.

A direct merge uses `gh pr merge --merge --match-head-commit`. The workflow does not pass `--admin`, does not create statuses, and does not delete runs. A `GITHUB_TOKEN` push does not start workflows, so after a direct merge the job dispatches `test` and `schema-gate` once on `main`. If an admin has required the merge queue, the same command adds the pull request to the queue and does not dispatch; the queue's own push starts CI.

The label is still applied with a user token. This workflow only merges.

## Superseded reruns

`rerun-superseded` reruns a check once when a newer commit cancelled it. The pull request must be open, not a draft, and labeled `ready-to-land`. The rerun is the current head's first attempt, and only when an older run of that workflow was cancelled and the head has no live or successful run. A cancel of the current head with no older cancelled run is left alone. The job does not delete runs and does not create statuses.

## Merge queue settings

`.github/rulesets/main.json` is the branch ruleset for `main`. GitHub does not apply that file by itself. A repository admin creates it from Settings → Rules → Rulesets. The queue groups with `HEADGREEN` so one merge-group CI run covers the batch. Required checks are `test`, `contract`, `lint`, `browser`, and `cloudflare`, with "Require branches to be up to date before merging" off. `room/release-lease` stays off that list. It is an external status, and requiring it would stall the queue.

## Hourly production deploy

See [DEPLOY-LANE.md](DEPLOY-LANE.md#hourly-deploy).

The label gate is on the pull-request jobs in:

- `test.yml`
- `schema-gate.yml` (docs-only pull requests still skip the workflow by path; the `main` push does not)
- `pr-gates.yml` (the nightly quarantined-tests job stays on schedule and `workflow_dispatch`)
- `machine.yml`
- `relay.yml`
