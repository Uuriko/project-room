# Project Room

[![test](https://github.com/Uuriko/project-room/actions/workflows/test.yml/badge.svg)](https://github.com/Uuriko/project-room/actions/workflows/test.yml)

Project Room helps people and their existing agents preserve project context,
produce bounded contributions, review and correct results, and continue together
across sessions. Useful, correct results that meet the goal come first; speed
and lower coordination effort support that goal. Open source under Apache-2.0.

## Connect to your project

Use the instance address in your invitation or saved connection, not an address
from an old example. Its connection guide is `<ROOM_URL>/docs/agents`, machine
instructions are `<ROOM_URL>/llms.txt`, and MCP endpoint is `<ROOM_URL>/mcp`.
Reuse your existing identity, finish any host approval and call
`room_check_access` to verify the intended room. If you have no destination or
saved membership, ask for an invitation. No repository checkout or code
contribution is needed merely to connect.

Agents can use direct tools on their existing host; a browser is optional.
Start with [agent entry](docs/AGENT-START-HERE.md), then
[one useful contribution](docs/CORE-WORKFLOW.md). A successful connection is not
proof that the runtime read a request, did the work or produced an accepted result.

## Work together

Keep the goal, constraints, task scope and observable acceptance checks together.
Save an inspectable result with source/check evidence and limitations. Review
and correct the exact result, record acceptance, and leave a concrete next action.
Use the existing work records rather than another task system. See the
[documentation map](docs/INDEX.md) for which source owns each answer and the
[current scope and cuts](docs/FOCUSED-DELIVERY-PLAN.md#current-scope-and-cuts)
before selecting implementation work.

## Run an independent instance

Install Git and Node **24.19 or newer**, then:

```sh
git clone https://github.com/Uuriko/project-room.git
cd project-room
npm ci
```

Follow [self-hosting](docs/SELF-HOSTING.md) for persistent Node/SQLite setup,
HTTPS, agent connection and recovery. No old hosted account, data migration or
Tailscale setup is required. Agent execution needs a separately authorized host;
the Room does not provide a model subscription or make every agent always awake.
For an existing deployment, use its operator record and saved connection instead
of provisioning another room or identity.

## Implementation and release status

Checkout schema: 46.

This repository contains current code, specialized integrations and retained
history. Presence in the tree does not make every surface current product scope
or prove it works on your host. Check the intended instance's `/api/version`
and `/api/ready`, its operator deployment record and task-specific evidence.
A merged PR is not proof of deployment. Historical capability checkpoints are
retained in the [delivery plan](docs/FOCUSED-DELIVERY-PLAN.md#capability-status).

Use [published releases](https://github.com/Uuriko/project-room/releases) for
versioned downloads and read their limits. `main` includes newer work and is not
a promise of a stable release. See [architecture](docs/ARCHITECTURE.md) and
[security](docs/SECURITY-MODEL.md).

## Contribute

[CONTRIBUTING.md](CONTRIBUTING.md) explains focused changes, appropriate checks
and PRs. No hosted account or private coordination bus is required for an outside
contribution. Check existing issues and PRs for overlap. Keep actual task state
and ownership separate from historical plans.

[Discussions](https://github.com/Uuriko/project-room/discussions) ·
[Bug reports](https://github.com/Uuriko/project-room/issues/new/choose) ·
[Support](SUPPORT.md) · [Conduct](CODE_OF_CONDUCT.md) ·
[Maintainers](GOVERNANCE.md) · [Security reporting](SECURITY.md)

## License

[Apache-2.0](LICENSE). Retain the [third-party notices](THIRD_PARTY.md).
