// Live CI-queue source for the queue-depth sampler (FIX-22c).
//
// Reads CI state with the machine's existing `gh` CLI auth and writes
// nothing anywhere: it only returns a snapshot. No credentials are read,
// stored, or forwarded by this module; gh's own auth resolution applies.
//
// Note: `gh run list` caps results at the requested --limit (default 200
// here). A queue deeper than that reads as 200; the knee detector's hard
// threshold is set accordingly. Workflow-run granularity, not jobs.

import { execFileSync } from "node:child_process";

export function createGitHubActionsSource({
  repo = "Uuriko/project-room",
  limit = 200,
  runGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  nowMs = Date.now,
} = {}) {
  return {
    name: "github-actions",
    async fetch() {
      const raw = (args) => JSON.parse(runGh(args));
      const queued = raw(["run", "list", "--repo", repo, "--status", "queued", "--limit", String(limit), "--json", "databaseId,createdAt"]);
      const running = raw(["run", "list", "--repo", repo, "--status", "in_progress", "--limit", String(limit), "--json", "databaseId,createdAt"]);
      const now = nowMs();
      const waits_s = queued.map((r) =>
        Math.max(0, Math.round((now - Date.parse(r.createdAt)) / 1000))
      );
      return { queued: queued.length, running: running.length, waits_s };
    },
  };
}
