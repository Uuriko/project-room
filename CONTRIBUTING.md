# Contributing to Project Room

People and agent-assisted contributors are welcome. Useful bug reports,
accessibility improvements, documentation and integration examples count too.
Start with the [README](README.md), [self-host guide](docs/SELF-HOSTING.md), and
[current product priorities](docs/PRODUCT-EXECUTION-PLAN.md).

## A small change, end to end

1. Search existing issues and PRs. For a substantial feature, open an issue with
   the user problem and proposed behavior before building it. Small fixes can
   go directly to a PR. Comment on an issue when starting work; check
   [the coordination thread #1160](https://github.com/Uuriko/project-room/issues/1160)
   if several contributors are changing the same area.
2. Fork the repository, clone it with history, create a focused branch, and run
   `npm ci` with Node 24.19 or newer. No hosted account or model API key is
   required to develop the core app.
3. Make the smallest cohesive change. Reuse existing domain operations; keep
   private Inbox data separate from room content and test authorization failures
   as well as the happy path. Add meaningful regression tests for behavior changes.
4. Run `npm run check` (including `npm run lint`). For UI changes, install Chromium with
   `npx playwright install --with-deps chromium` and run the affected browser
   checks; the full suite is `npm run test:browser`. Workers changes also need
   the checks in [cloudflare/README.md](cloudflare/README.md). Run all tests
   via `scripts/test-env.sh` (e.g. `scripts/test-env.sh npm test`) so TMPDIR
   points at the worktree-local `.tmp/` instead of the shared 512MB `/tmp`
   tmpfs, which is actively reaped and causes SQLITE_FULL failures.
5. Open a PR explaining the problem, resulting behavior, tests and limitations.
   CI includes lint, contract, unit, browser, cloudflare and component checks.
   Required CI must pass on the final revision. Maintainers handle merging and
   releases. Repository access never grants permission to access user data or
   deploy another person's service.

## Contributions and AI tools

### Replay and release evidence

For changes to event admission, reducers, projections or journals, explain three
compatibility cases in the PR: old history on new code, newly accepted events
on older code, and the supported recovery path. An unchanged database schema
does not establish replay or rollback compatibility. Exercise a persisted
history across close/reopen when the change affects recovery. Prefer validating
new commands before persistence over retroactively rejecting accepted history.

Use the existing read-only `scripts/release-checkpoint.mjs --pr NUMBER`
collector for a shared checkpoint instead of creating another status ledger.
Include the reviewed head and base, exact CI run, actual merge revision, and
each Worker's own revision in the release receipt. `/api/version` can report a
shared backend; it does not prove both entry Workers were uploaded. Collector
exit zero means collection completed, not permission or readiness to deploy.
Keep access, binding and recovery verification alongside that checkpoint, and
link updates to it rather than repeating unqualified “ready” or “shipped” claims.

Submit only work you have the right to contribute under [Apache-2.0](LICENSE).
Keep attribution and dependency notices. No copyright assignment or separate
CLA is required. Submission is under the project license; see its section 5.
Do not fabricate sign-offs for existing commits.

AI assistance is welcome under the same review standard. The submitting person
is responsible for reviewing the output, checking its provenance and reporting
which tests actually ran. Agent identity does not prove independent review.
Never include credentials, private messages or customer data in issues, test
fixtures, screenshots or prompts sent to services without authorization.
An agent must have its operator's permission to contribute; public discovery
of this repository does not authorize external actions.

## Review and community

Be respectful, specific and constructive. No harassment, threats, discrimination,
spam or disclosure of another person's private information. Maintainers may
remove harmful content or restrict participation; explain moderation decisions
when doing so is safe. These expectations apply to human and automated posts.

The repository owner, [@Uuriko](https://github.com/Uuriko), is the current final
maintainer for scope, merge and release decisions. Propose design changes in an
issue so decisions and tradeoffs remain public. **Review norm:** we give every PR a
first review or an acknowledgement. It is a norm, not a
guarantee — but we treat slow reviews as a bug, because review speed is what
turns a first PR into a second one. Repeated useful contributions can lead to additional maintainer access;
that access is granted explicitly, not inferred from activity or agent claims.

Use issues for bugs, ideas and setup questions. Use the private reporting path
in [SECURITY.md](SECURITY.md) for vulnerabilities. Please keep one issue per
problem and avoid automated duplicate reports or unsolicited bulk PRs.
