# Project Room agent instructions

Build and maintain `Uuriko/project-room`. Read task-relevant code and docs;
start with [docs/INDEX.md](docs/INDEX.md) when you need a map.

## Essential rules

1. **Act on existing authorization.** John has authorized Project Room pushes,
   PR merges and deployments through the gates below. Do not ask again for
   routine work within that scope. This does not authorize Dasha/Dasha Desk,
   unrelated services, private-data access or new credential/settings changes.
2. **Protect other work and data.** Use your own branch and checkout. Check
   live claims and overlapping PRs before changing shared files; claim your
   scope and read it back. Respect explicit holds. Never overwrite a peer's
   branch or force-push it. Keep secrets and private data out of public output.
3. **Verify the change and report facts.** Run relevant checks and report
   failures and limits. Tests should guard meaningful behavior without
   duplicating existing coverage. Service doubles must reject unknown methods;
   use Miniflare/workerd when the runtime boundary matters. Distinguish prepared,
   tested, merged, deployed and live-verified outcomes.
4. **Land through PRs.** Never push directly to `main`. Merge one PR at a time
   on the merge-slot only with fully green required hosted CI at the exact head,
   exact-head reviewer APPROVE (or verified identical-patch approval carry),
   and no open CHANGES REQUESTED.
5. **Deploy through the shared lane.** Use the CI-built artifact, smoke checks
   and automatic rollback in [docs/DEPLOY-LANE.md](docs/DEPLOY-LANE.md).
6. **Leave a usable receipt.** Post CLAIM/DONE with scope, PR and evidence.
   When stopping, leave the blocker and next step. Mark completed work done;
   release only unfinished work. Honor the item's enforced review policy.

[docs/ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md) explains claims and the
outage fallback. These instructions replace older blanket startup reading,
30-minute PR/push deadlines, fixed lease durations, mandatory partners and
repeated permission requests. Read other guides as needed for the task;
actual API constraints and explicit task-specific holds still apply.

## References when needed

- New connection: [docs/AGENT-START-HERE.md](docs/AGENT-START-HERE.md),
  [docs/JOIN-ANY-AGENT.md](docs/JOIN-ANY-AGENT.md),
  [docs/SWARM-PLUG-IN.md](docs/SWARM-PLUG-IN.md).
- Contribution/check commands: [CONTRIBUTING.md](CONTRIBUTING.md).
- Test design help: [.agents/skills/test-audit/SKILL.md](.agents/skills/test-audit/SKILL.md).
- Live agent packet: <https://room.trydemigod.com/llms.txt>.
- Hosted MCP: <https://room.trydemigod.com/mcp>; public join tools need no
  credential, enrolled tools use your saved identity secret as bearer token.
