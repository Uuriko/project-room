# Contributing to Project Room

People and agent-assisted contributors are welcome. Bug reports, accessibility fixes, documentation, and integration examples count. Start with the [README](README.md), [self-host guide](docs/SELF-HOSTING.md), and [docs index](docs/INDEX.md).

## A small change, end to end

1. Follow [AGENTS.md](AGENTS.md) and [ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md) for authorization, collision checks and the outage fallback. Use the Room work-claim board (`GET /api/rooms/{roomId}/work-claims`) for shared work. Small fixes can go straight to an isolated pull request when they do not overlap held work.
2. Fork the repository, clone it with history, create a focused branch, and run `npm ci` with Node 24.19 or newer. No hosted account or model API key is required to develop the core app. If a test fails with `ERR_MODULE_NOT_FOUND` for a package that is listed in `package.json` (for example `yaml`), your `node_modules` predates the commit that added it — re-run `npm install`. `npm test` fails fast with exactly this diagnosis via `scripts/check-deps.mjs`, so you do not have to guess.
3. Make the smallest cohesive change. Keep private Inbox data separate from room content, and test authorization failures as well as the happy path.
4. Run checks relevant to the change. Documentation-only changes need `git diff --check` and `node scripts/docs-link-check.mjs`; they do not need a new test or the full local application suite. For code, `npm run lint` runs the canonical lint gate and `npm run check` runs the standard syntax/contract/lint and unit checks. For UI changes, install Chromium with `npx playwright install --with-deps chromium` and run affected browser checks (`npm run test:browser` is the full suite). Workers changes also need [cloudflare/README.md](cloudflare/README.md). Run tests via `scripts/test-env.sh` so TMPDIR points at the worktree-local `.tmp/`. Hosted CI still must pass on the final head before landing.
5. Open a pull request that states the problem, the resulting behavior, the tests, and the limits. CI includes lint, contract, unit, browser, cloudflare, and component checks. Required CI must pass on the final revision. Repository access never grants permission to read user data or to deploy someone else's service.

## Rename-proof tests

New tests that cover a non-default path driven by a field must be rename-proof:
the test has to fail if the consumed field is renamed in the source. A test that
still passes with the field renamed (or deleted, or hardcoded) is rename-blind —
it does not actually exercise the field, however green it looks.

Spot-check this with `scripts/test-rename-check.mjs` before submitting. It copies
the tree into a scratch dir under `.tmp/`, applies the rename to the source
file(s) only (never the test), runs the test against the mutated source, and
reports a verdict:

```
node scripts/test-rename-check.mjs \
  --test tests/spend-grants.test.js \
  --source server/spend-grants.mjs \
  --rename replay:replayz
```

- `RENAME-PROOF` (exit 0) — the test failed under the rename: it genuinely
  depends on the field.
- `RENAME-BLIND` (exit 1) — the test passed under the rename: flag it. Either
  the test never drives the field (strengthen it, or drop the coverage claim),
  or it covers the behavior without depending on the field's name (say so in
  the PR).
- exit 2 — the check itself errored: missing file, the field was not found in
  the source, or the test was already red before the mutation (the script runs
  the unmutated baseline first and refuses to judge a red test).

The rename is textual (word-boundary); the script prints the mutation diff so
you can confirm it only touched the intended identifier. Name the regression
each new test would catch, and run the rename check on any test whose fixture
sets a field the source consumes.

## Replay and release

For changes to event admission, reducers, projections, or journals, explain three cases: old history on new code, newly accepted events on older code, and the supported recovery path. An unchanged database schema does not establish replay or rollback compatibility.

Submit only work you have the right to contribute under [Apache-2.0](LICENSE). No copyright assignment or separate CLA is required. Do not fabricate sign-offs. AI assistance is welcome under the same review standard. The submitting person reviews the output and reports which tests actually ran. Never include credentials, private messages, or customer data in issues, fixtures, or prompts sent to services without authorization.

## Review

Be specific and constructive. Maintainers may remove harmful content. The repository owner, [@Uuriko](https://github.com/Uuriko), decides scope, merge, and release. Every pull request gets a first review or an acknowledgement. That is a norm, not a guarantee. Use [SECURITY.md](SECURITY.md) for vulnerabilities. Keep one issue per problem, and do not file automated duplicate reports.
