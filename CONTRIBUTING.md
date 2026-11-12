# Contributing to Project Room

People and agents can contribute through GitHub. No Project Room account,
agent enrollment or model API key is needed for a core-app contribution.
Bug reproductions, accessibility fixes, documentation and integration examples count.

## Start with your agent

Copy this into the coding agent you already use. Include an issue or shared task
link if you have one:

> Help with https://github.com/Uuriko/project-room. Read CONTRIBUTING.md and
> task-relevant AGENTS.md instructions. If I supplied a task link, read its current
> state; otherwise inspect public issues for a small useful change. Check existing
> PRs before starting so you do not duplicate work. State the intended result and
> how to verify it, then implement in an isolated branch within my authorization.
> Follow the project's existing submission path; a Room account is optional.
> Run the relevant checks and open a focused PR when authorized, or leave a ready
> diff. Include the source revision, actual checks, remaining uncertainty and next
> action. If no suitable task is available, report that rather than inventing work.

Prefer to work directly? Follow the five steps below. The
[starter issues](https://github.com/Uuriko/project-room/contribute) are one option,
not a queue you must join. If those already have active PRs, reproduce an open bug,
review an existing PR, or submit a small improvement you can demonstrate. Discuss
substantial new features first. Check current issue and PR activity before coding;
an unassigned issue is not proof that nobody is working on it.

## A small change, end to end

1. Check existing issues and pull requests for overlapping work. For a small fix, open a focused pull request directly; for a substantial feature, discuss the approach in an issue first. No hosted account, private coordination bus, or live-room claim is required for an outside contribution. Maintainers working on shared checkouts or production use [ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md). Agents should also read [AGENTS.md](AGENTS.md).
2. Fork the repository, clone it with history, create a focused branch, and run `npm ci` with Node 24.19 or newer. No hosted account or model API key is required to develop the core app. If a test fails with `ERR_MODULE_NOT_FOUND` for a package that is listed in `package.json` (for example `yaml`), your `node_modules` predates the commit that added it — re-run `npm install`. `npm test` fails fast with exactly this diagnosis via `scripts/check-deps.mjs`, so you do not have to guess.
3. Make the smallest cohesive change. Keep private Inbox data separate from room content, and test authorization failures as well as the happy path.
4. Run checks relevant to the change. Documentation-only changes need `git diff --check` and `node scripts/docs-link-check.mjs`; they do not need a new test or the full local application suite. For code, `npm run lint` runs the canonical lint gate and `npm run check` runs the standard syntax/contract/lint and unit checks. For UI changes, install Chromium with `npx playwright install --with-deps chromium` and run affected browser checks (`npm run test:browser` is the full suite). Workers changes also need [cloudflare/README.md](cloudflare/README.md). Run tests via `scripts/test-env.sh` so TMPDIR uses the macOS private per-user temporary directory or the worktree-local `.tmp/` on Linux. Hosted CI still must pass on the final head before landing.
5. Open a pull request that states the problem, the resulting behavior, the tests, and the limits. CI includes lint, contract, unit, browser, cloudflare, and component checks. Required CI must pass on the final revision. Repository access never grants permission to read user data or to deploy someone else's service.

## After you open a pull request

- **Checks start on their own.** Pull requests from forks get lint, a secret scan, a docs link check and the tests selected for the files you changed, on every push (`contributor-ci`). No label is needed. On your first pull request GitHub may hold the run until a maintainer approves it; after that it runs on its own.
- **Review within about two working days.** Maintainers here include people and agents. When the change looks right they add `ready-to-land`, which runs the maintainer qualification checks selected for the change, and then merge.
- **Nothing is closed by a bot.** If a pull request goes quiet, a maintainer asks before anything happens to it. If it conflicts with main it may be labelled `needs-rebase`.

## Replay and release

For changes to event admission, reducers, projections, or journals, explain three cases: old history on new code, newly accepted events on older code, and the supported recovery path. An unchanged database schema does not establish replay or rollback compatibility.

Submit only work you have the right to contribute under [Apache-2.0](LICENSE). No copyright assignment or separate CLA is required. Do not fabricate sign-offs. AI assistance is welcome under the same review standard. The submitting person reviews the output and reports which tests actually ran. Never include credentials, private messages, or customer data in issues, fixtures, or prompts sent to services without authorization.

## Review

Be specific and constructive. Maintainers may remove harmful content. The repository owner, [@Uuriko](https://github.com/Uuriko), decides scope, merge, and release. We aim to acknowledge contributions, but response times depend on maintainer availability. A submission does not guarantee acceptance. Use [SECURITY.md](SECURITY.md) for vulnerabilities. Keep one issue per problem, and do not file automated duplicate reports.

## Find your way around

Use the [project overview](README.md) for entry points and the [local setup guide](docs/SELF-HOSTING.md) to run it. The [architecture map](docs/ARCHITECTURE.md) explains the code: browser code lives in `src/`, server modules in `server/`, agent clients in `client/`, machine integration in `machine/`, and native Mac code in `desktop/macos/`. Follow nearby tests for the area you change. See [support](SUPPORT.md), [community conduct](CODE_OF_CONDUCT.md), and [governance](GOVERNANCE.md).

## Work together in Project Room

See [Build Project Room in Project Room](docs/CONTRIBUTING-IN-ROOM.md) for the
optional shared conversation, agent connection and GitHub handoff. For a focused
local readiness check, install Playwright Chromium and run
`bash scripts/test-env.sh npm run test:contributor`. This uses synthetic local
data and needs no hosted credentials; it is not a substitute for the tests
relevant to your change.

## Shared-checkout maintainers

Maintainers coordinate overlapping work through the selected room's current
work and ownership records. In native rooms, follow `room_list_work` pagination,
read the selected task and use its allowed lifecycle actions. The `work-claims`
board and `scripts/room-coord.mjs` are legacy-only; compatibility reads do not
make legacy claim writes available in native rooms. Follow
[ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md) for the current route and
serialized releases. Room participation is optional for an outside fork or PR.
