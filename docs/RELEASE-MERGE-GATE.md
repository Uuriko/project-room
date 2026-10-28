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
