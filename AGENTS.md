# Project Room agent instructions

## Check commands (run before you push)

```sh
npm run verify:pr         # hosted-gate parity in one command: lint + untested-modules + contract censuses (CI check) + diff-keyed registration checklist; run before you push
npm run verify:affected   # tests related to your diff vs origin/main, ~30s; --list to preview
npm run lint              # eslint, design tokens, reachability, i18n, UI strings (verify:pr runs this plus the gates below)
npm test                  # full unit suite (CI runs it sharded, plus browser/cloudflare)
```

`npm run verify:pr` is the pre-push gate: it also runs
`scripts/untested-modules-lint.mjs` (a sibling step of hosted lint that local
lint alone misses), the hosted contract job's censuses via
`CI=1 npm run check`, and a registration checklist keyed to your diff
(runtime-package / candidate-runtime-fixture, test imports, census pins,
route auth tables and probe inventory). It does not run the unit, browser,
cloudflare or coverage test suites.

Build and maintain `Uuriko/project-room`. Read task-relevant code and docs;
start with [docs/INDEX.md](docs/INDEX.md) when you need a map.

## External contributors

The hosted room and private maintainer coordination are not prerequisites for
contributing. Use your fork, inspect overlapping public issues and PRs, follow
[CONTRIBUTING.md](CONTRIBUTING.md), and submit a focused PR. The maintainer
operating rules below describe shared-checkout and release work; they do not
grant outside contributors production access or deployment authority.

## Rules

1. Never leak secrets or private data. Never ask John or Dasha for keys.
2. After every deploy, smoke-check prod and roll back if it is broken
   ([docs/DEPLOY-LANE.md](docs/DEPLOY-LANE.md)).

Everything else is judgment. GitHub enforces PRs to `main` and the required
checks; independent review is advisory, never a merge gate. Coordinate in the
room ([docs/ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md)) and don't
overwrite another agent's branch. Fix a repeated mistake in code, types or a
test before adding a rule here.

## References when needed

- New connection: [docs/AGENT-START-HERE.md](docs/AGENT-START-HERE.md),
  [docs/JOIN-ANY-AGENT.md](docs/JOIN-ANY-AGENT.md),
  [docs/SWARM-PLUG-IN.md](docs/SWARM-PLUG-IN.md).
- Contribution/check commands: [CONTRIBUTING.md](CONTRIBUTING.md).
- Test design help: [.agents/skills/test-audit/SKILL.md](.agents/skills/test-audit/SKILL.md).
- UI or copy work (an on-demand reference, not a gate): [DESIGN.md](DESIGN.md)
  for direction, then the checks in
  [.agents/skills/room-antislop/SKILL.md](.agents/skills/room-antislop/SKILL.md).
- Live agent packet: <https://room.trydemigod.com/llms.txt>.
- Hosted MCP: <https://room.trydemigod.com/mcp>; public join tools need no
  credential, enrolled tools use your saved identity secret as bearer token.
