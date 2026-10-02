# Contributing to Project Room

People and agent-assisted contributors are welcome. Bug reports, accessibility fixes, documentation, and integration examples count. Start with the [README](README.md), [self-host guide](docs/SELF-HOSTING.md), and [docs index](docs/INDEX.md).

## A small change, end to end

1. Coordinate substantial work in the room on the work-claim board (`GET /api/rooms/{roomId}/work-claims`). GitHub issues are not the coordination board. Small fixes can go straight to a pull request.
2. Fork the repository, clone it with history, create a focused branch, and run `npm ci` with Node 24.19 or newer. No hosted account or model API key is required to develop the core app.
3. Make the smallest cohesive change. Keep private Inbox data separate from room content, and test authorization failures as well as the happy path.
4. Run `npm run check` (it includes `npm run lint`). For UI changes, install Chromium with `npx playwright install --with-deps chromium` and run the affected browser checks. The full suite is `npm run test:browser`. Workers changes also need the checks in [cloudflare/README.md](cloudflare/README.md). Run tests via `scripts/test-env.sh` (for example `scripts/test-env.sh npm test`) so TMPDIR points at the worktree-local `.tmp/`.
5. Open a pull request that states the problem, the resulting behavior, the tests, and the limits. CI includes lint, contract, unit, browser, cloudflare, and component checks. Required CI must pass on the final revision. Repository access never grants permission to read user data or to deploy someone else's service.

## Replay and release

For changes to event admission, reducers, projections, or journals, explain three cases: old history on new code, newly accepted events on older code, and the supported recovery path. An unchanged database schema does not establish replay or rollback compatibility.

Submit only work you have the right to contribute under [Apache-2.0](LICENSE). No copyright assignment or separate CLA is required. Do not fabricate sign-offs. AI assistance is welcome under the same review standard. The submitting person reviews the output and reports which tests actually ran. Never include credentials, private messages, or customer data in issues, fixtures, or prompts sent to services without authorization.

## Review

Be specific and constructive. Maintainers may remove harmful content. The repository owner, [@Uuriko](https://github.com/Uuriko), decides scope, merge, and release. Every pull request gets a first review or an acknowledgement. That is a norm, not a guarantee. Use [SECURITY.md](SECURITY.md) for vulnerabilities. Keep one issue per problem, and do not file automated duplicate reports.
