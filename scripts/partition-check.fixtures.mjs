// Fixtures for scripts/partition-check.mjs.
//
// REAL-DATA PASS FIXTURE (allWaves):
//   * worktree + branch names verified live 2026-10-08 ~19:00 PDT via
//     `git branch --show-current` in each ~/workspace/pr-* checkout.
//     pr-wave500-bughunt was on a detached HEAD (no branch) — recorded as [].
//   * NOTE (2026-10-08 ~19:30 PDT): most wave worktrees have since been
//     cleaned up after their waves ended (only pr-wave400-workflow,
//     pr-wave500-protocol and pr-wave500-coord-cost still exist — all three
//     branch names re-verified identical). The worktree + branch names here
//     stand as the 2026-10-08 ~19:00 PDT ground truth; the fixture keeps them
//     because that is the real data a pre-wave gate ran against.
//   * dirs/files are topic-derived illustrative scopes taken from each lane's
//     documented wave topic (WAVE-300/WAVE-400/WAVE-500 briefs); they are
//     disjoint by construction so this fixture must PASS. In real use the
//     planner (worker 9's partition-plan.mjs) emits actual scopes.
// DELIBERATE OVERLAP FIXTURE (overlapPair): constructed to FAIL every axis.
export const allWaves = {
  partitions: [
    {
      name: "pr-wave300-data-plane",
      worktree: "/home/hatch/workspace/pr-wave300-data-plane",
      branches: ["wave300/data-plane-fastpath"],
      claimIds: ["wave300-data-plane-01"],
      dirs: ["server/data-plane/"],
    },
    {
      name: "pr-wave300-reaper",
      worktree: "/home/hatch/workspace/pr-wave300-reaper",
      branches: ["wave300/reaper-landing"],
      claimIds: ["wave300-reaper-01"],
      dirs: ["server/reaper/"],
    },
    {
      name: "pr-wave300-backpressure",
      worktree: "/home/hatch/workspace/pr-wave300-backpressure",
      branches: ["wave300/honest-backpressure"],
      claimIds: ["wave300-backpressure-01"],
      dirs: ["server/backpressure/"],
    },
    {
      name: "pr-wave300-fanout",
      worktree: "/home/hatch/workspace/pr-wave300-fanout",
      branches: ["wave300-fanout-perf"],
      claimIds: ["wave300-fanout-01"],
      dirs: ["server/fanout/"],
    },
    {
      name: "pr-wave300-shards",
      worktree: "/home/hatch/workspace/pr-wave300-shards",
      branches: ["wave300/sharded-claim-boards"],
      claimIds: ["wave300-shards-01"],
      dirs: ["server/claims/"],
    },
    {
      name: "pr-wave300-payloads",
      worktree: "/home/hatch/workspace/pr-wave300-payloads",
      branches: ["wave300/payload-store"],
      claimIds: ["wave300-payloads-01"],
      dirs: ["server/payloads/"],
    },
    {
      name: "pr-wave300-replay",
      worktree: "/home/hatch/workspace/pr-wave300-replay",
      branches: ["wave300/replay-harness"],
      claimIds: ["wave300-replay-01"],
      dirs: ["server/replay/"],
    },
    {
      name: "pr-wave300-telemetry",
      worktree: "/home/hatch/workspace/pr-wave300-telemetry",
      branches: ["wave300/telemetry-prod"],
      claimIds: ["wave300-telemetry-01"],
      dirs: ["server/telemetry/"],
    },
    {
      name: "pr-wave400-docs-core",
      worktree: "/home/hatch/workspace/pr-wave400-docs-core",
      branches: ["wave400/docs-core"],
      claimIds: ["wave400-docs-core-01"],
      dirs: ["docs/core/"],
    },
    {
      name: "pr-wave400-docs-tooling",
      worktree: "/home/hatch/workspace/pr-wave400-docs-tooling",
      branches: ["wave400/docs-tooling"],
      claimIds: ["wave400-docs-tooling-01"],
      dirs: ["docs/tooling/"],
    },
    {
      name: "pr-wave400-elegant-server",
      worktree: "/home/hatch/workspace/pr-wave400-elegant-server",
      branches: ["wave400/elegant-server"],
      claimIds: ["wave400-elegant-server-01"],
      dirs: ["server/elegant/http/"],
    },
    {
      name: "pr-wave400-elegant-routes",
      worktree: "/home/hatch/workspace/pr-wave400-elegant-routes",
      branches: ["wave400/elegant-routes"],
      claimIds: ["wave400-elegant-routes-01"],
      dirs: ["server/elegant/routes/"],
    },
    {
      name: "pr-wave400-fuzz",
      worktree: "/home/hatch/workspace/pr-wave400-fuzz",
      branches: ["wave400/fuzz-harness"],
      claimIds: ["wave400-fuzz-01"],
      dirs: ["tests/fuzz/", "chaos/"],
    },
    {
      name: "pr-wave400-perf",
      worktree: "/home/hatch/workspace/pr-wave400-perf",
      branches: ["wave400/perf-lagging-detect"],
      claimIds: ["wave400/perf-01"],
      dirs: ["perf/"],
    },
    {
      name: "pr-wave400-workflow",
      worktree: "/home/hatch/workspace/pr-wave400-workflow",
      branches: ["wave400/workflow"],
      claimIds: ["wave400-workflow-01"],
      dirs: ["server/workflow/"],
    },
    {
      name: "pr-wave400-audit",
      worktree: "/home/hatch/workspace/pr-wave400-audit",
      branches: ["wave400/audit"],
      claimIds: ["wave400-audit-01"],
      dirs: ["scripts/audit/", "tests/audit/"],
    },
    {
      name: "pr-wave500-bughunt",
      worktree: "/home/hatch/workspace/pr-wave500-bughunt",
      branches: [],
      claimIds: ["wave500-bughunt-01"],
      dirs: ["tests/bughunt/"],
    },
    {
      name: "pr-wave500-claim-scale",
      worktree: "/home/hatch/workspace/pr-wave500-claim-scale",
      branches: ["wave500/claim-scale"],
      claimIds: ["wave500-claim-scale-01"],
      dirs: ["server/claim-scale/"],
    },
    {
      name: "pr-wave500-event-survival",
      worktree: "/home/hatch/workspace/pr-wave500-event-survival",
      branches: ["wave500/event-survival"],
      claimIds: ["wave500-event-survival-01"],
      dirs: ["server/event-survival/"],
    },
    {
      name: "pr-wave500-protocol",
      worktree: "/home/hatch/workspace/pr-wave500-protocol",
      branches: ["wave500/protocol"],
      claimIds: ["wave500-protocol-01"],
      dirs: ["docs/protocol/"],
    },
    {
      name: "pr-wave500-coord-cost",
      worktree: "/home/hatch/workspace/pr-wave500-coord-cost",
      branches: ["wave500/coord-cost"],
      claimIds: ["wave500-coord-cost-01"],
      dirs: ["docs/coord/"],
      files: [
        "scripts/partition-check.mjs",
        "scripts/partition-check.fixtures.mjs",
        "docs/PARTITION-CHECK.md",
      ],
    },
  ],
};

// Deliberately overlapping pair: must FAIL on all four axes.
// partition-a claims the whole server/ tree, the coord-cost branch,
// claim namespace wave500-coord-cost, and the same worktree as partition-b.
// partition-b claims a nested subdir/file inside server/ plus its own
// overlapping claims on the same branch/namespace/worktree.
export const overlapPair = {
  partitions: [
    {
      name: "overlap-a",
      worktree: "/home/hatch/workspace/pr-wave500-coord-cost",
      branches: ["wave500/coord-cost"],
      claimIds: ["wave500-coord-cost-02"],
      dirs: ["server/"],
      files: ["server/http.mjs"],
    },
    {
      name: "overlap-b",
      worktree: "/home/hatch/workspace/pr-wave500-coord-cost",
      branches: ["wave500/coord-cost"],
      claimIds: ["wave500-coord-cost-03"],
      dirs: ["server/claims/"],
      files: ["server/claims/board.mjs"],
    },
  ],
};
