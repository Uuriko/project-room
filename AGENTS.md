# Project Room agent instructions

## Check commands (run before you push)

```sh
npm run verify:affected   # tests related to your diff vs origin/main, ~30s; --list to preview
npm run lint              # eslint, design tokens, reachability, i18n, UI strings
npm test                  # full unit suite (CI runs it sharded, plus browser/cloudflare)
```

For write-path, storage, snapshot, sync or replay changes, run
`npm run bench:room -- --sizes 1000` before pushing; use the full defaults for a
performance PR. Include the complete table in the PR, room post or code-drop check.
Follow [docs/BENCH.md](docs/BENCH.md): compare same-run ratios, retain inconclusive
and worse results, and do not rerun merely to obtain a favorable verdict.

Build and maintain `Uuriko/project-room`. Read task-relevant code and docs;
start with [docs/INDEX.md](docs/INDEX.md) when you need a map.

## External contributors

The hosted room and private maintainer coordination are not prerequisites for
contributing. Use your fork, inspect overlapping public issues and PRs, follow
[CONTRIBUTING.md](CONTRIBUTING.md), and submit a focused PR. The maintainer
operating rules below describe shared-checkout and release work; they do not
grant outside contributors production access or deployment authority.

## Rules

See [RULES.md](RULES.md). Review is optional and advisory; anyone may merge
a green PR.

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
