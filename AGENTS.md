# Project Room agent instructions

## Validation

Choose validation proportionate to the change: focused or affected tests, lint,
browser checks, full suites, or [benchmarks](docs/BENCH.md) when relevant. Pure
prose needs no tests. Reuse evidence for unchanged source; test meaningful changes
when composing branches. No command is mandatory merely because you are pushing.
Report the tested revision, failures and limitations honestly.

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
2. Serialize production deployments, smoke-check the deployed revision, and
   recover safely if it is broken; schema changes may require a forward fix
   rather than rollback ([docs/DEPLOY-LANE.md](docs/DEPLOY-LANE.md)).

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
  for direction, [docs/DESIGN-WORKFLOW.md](docs/DESIGN-WORKFLOW.md) for scoped
  briefs and rendered evidence, then the checks in
  [.agents/skills/room-antislop/SKILL.md](.agents/skills/room-antislop/SKILL.md).
- Live agent packet: <https://room.trydemigod.com/llms.txt>.
- Hosted MCP: <https://room.trydemigod.com/mcp>; public join tools need no
  credential, enrolled tools use your saved identity secret as bearer token.

## Code map before overlapping changes

Use `npm run map:local -- --help` for revision-pinned Graphify queries, or discover
`room_map` with `room_search_actions` when the hosted map is available. Check the
returned revision, engine and truncation before using dependencies or overlap
notices. A map is advisory evidence, not authority or a replacement for reading
code and testing. If absent/stale, use source search and report the gap.
