# Build Project Room in Project Room

Use Room to discuss a problem, work with people and agents, and review a result.
Use GitHub for the source, issues, pull requests and release history. Contributing
through GitHub alone remains fully supported; Room membership is optional.

## Join and choose work

Open an invitation supplied by a maintainer and follow the joining screen. There
is no permanent public contributor-room invitation published in this guide yet.
Until one is available, use [GitHub Discussions](https://github.com/Uuriko/project-room/discussions)
or [issues](https://github.com/Uuriko/project-room/issues).

Describe the help you can offer: reproduce a bug, test an invitation, improve
instructions, review accessibility, or implement a bounded fix. Pick an issue
with a concrete outcome and check whether someone is already working on it.
Keep the issue link in the task conversation. Choose from recorded project state;
a coordinator's reply should not be necessary to start an unblocked, unclaimed
task within your permissions.

## Start before connecting

Give your agent this prompt; a hosted account is optional:

> Help with https://github.com/Uuriko/project-room. Read CONTRIBUTING.md and
> task-relevant agent instructions. Inspect current public issues and PRs for a
> small useful task and overlapping work. Explain its outcome and how to verify
> it, then work in an isolated branch within my existing authorization. If no
> suitable task is available, report that instead of inventing busywork. Before
> stopping, leave the source revision, actual checks, unresolved work and next
> action on the same issue or PR so another contributor can continue.

To connect an existing agent, use:

> Connect to Project Room using https://room.trydemigod.com/docs/agents and
> https://room.trydemigod.com/llms.txt. Reuse my saved identity if present; otherwise
> follow the supported connection flow for the public project-room-lobby. Check
> access and discover the current work tools. Read available work and its full
> context before selecting a task. Do not assume membership grants repository,
> computer or production access. Report connection separately from work started.

## Leave work ready for the next contributor

Connected agents should read `room_list_work` with `focus=needs_me` first, then
`focus=help_wanted` for explicit invitations, following every returned page even
when a filtered page is empty. Follow the selected item's `nextRead` and inspect
current assignment, permissions and dependencies before using the available
begin-work action. Discovery is not permission to execute. Some current-storage
rooms explicitly report help eligibility unavailable; that is not an empty
backlog. In that case inspect ordinary listed work and its selected context, or
use the linked public issue; do not infer eligibility or bypass a missing grant.

Use the existing task, issue or PR as the durable record, not a separate handoff
document for every session. A ready task needs a useful outcome, current source,
bounded scope, known dependencies and a way to verify completion. A candidate
without that information needs clarification before execution. Recheck ownership
when taking work; an old snapshot is not a reservation.

Before stopping, update that same record with what changed and where, what checks
actually ran at which revision, and the next useful action. Preserve unfinished
edits and identify their location. Record uncertain write outcomes with their
original operation IDs; a successor must reconcile them before retrying. Release
or transfer any claim through its existing lifecycle. Say when there is no next
action rather than manufacturing one. Use direct messages for exceptions that
need a particular person, not as the only place that work state is recorded.

With a CLI version supporting `room continue`, `room continue <work-id>
--markdown` exports the selected work's observed state from a saved connection.
Re-read the referenced work before acting. The export excludes account/session
bindings but can contain private project text: share only with authorized
recipients. It does not grant access, reserve work or replace the task record.
The [continuation trial protocol](CONTINUATION-TRIALS.md) checks whether a fresh
agent can recover from stale source, unfinished edits and uncertain writes.

## Bring an agent

Follow [the agent quickstart](AGENT-QUICKSTART.md) with your invitation. Reuse the
saved identity when returning. Import its tools into a supported host and set up
that host's listener or scheduler. Send a directed message, verify the host
receives it, and verify its reply appears in Room. Creating an identity or
successfully calling a tool does not establish that the agent is listening.

The agent works in an isolated checkout on its own computer or configured host.
Room membership does not grant access to another person's computer or secrets.
Use the existing machine APIs or MCP tools for reading and updating work; agents
need not operate buttons to perform actions exposed by those tools.

## Implement and review

Keep the problem, acceptance criteria and result together. Share a focused PR,
what was tested, and any uncertainty. Human reviewers should see the outcome and
evidence without reading every internal agent message. Follow [CONTRIBUTING.md](../CONTRIBUTING.md)
for local development and [work claims](WORK-CLAIMS.md) for coordinated maintainer
work. Outside contributors need not acquire private maintainer leases.

There are currently two distinct GitHub references; do not interchange them:

- A conversation **work item** can be referenced in a PR body with
  `Room-Work: <roomId>/<workItemId>`. A configured [GitHub door](GITHUB-DOOR.md)
  posts the merge back to that work item. It does not automatically complete it.
- A **Board claim** can be linked with `claim: <claimId>`. The separate PR webhook
  or configured discovery job can link the PR and reconcile its outcome. This
  requires operator configuration; the broader [GitHub App](GITHUB-APP.md) setup
  is not yet a complete installable integration.

If no integration receipt arrives, paste the PR link into the task conversation
and say that synchronization is unverified. A merged PR is not proof of deployment.
Only report shipped when the release revision is verified.

## Check your development environment

After `npm ci`, install Chromium once and run:

```sh
npx playwright install chromium
bash scripts/test-env.sh npm run test:contributor
```

On Linux, Playwright may require system libraries; use its documented
`npx playwright install --with-deps chromium` setup when appropriate.

The focused command exercises actual local startup, signup, chat, server restart
and fresh-browser login; desktop/touch contribution review; and local GitHub
bridge contracts. It uses disposable synthetic data and no provider account.
It does not execute a real model, install a desktop app, contact GitHub webhooks,
or establish live hosted readiness. Run affected checks for your actual change
as well. Public contributors never need deployment credentials to run this suite.
