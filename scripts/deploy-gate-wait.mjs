// Wait for a workflow's push run on one commit to finish. Zero dependencies.
//
// deploy-prod's gate reads the `schema-gate` push run on the exact commit. That
// run starts a few seconds after the merge and takes about 15 seconds (median
// of the last 100 main runs; p90 103s), so a dispatch or an autoland step that
// fires right after the merge sees "queued", "in_progress" or "missing" and the
// gate refused (run 42957405592 on e92ded22). This waits for the run to reach a
// terminal state instead of refusing on a transient one. It decides nothing:
// the gate's own policy still reads the final conclusion.
//
// States: success | failure (any other terminal conclusion) | pending | missing
// CLI: node scripts/deploy-gate-wait.mjs --repo OWNER/REPO --sha SHA
//        [--workflow schema-gate] [--timeout-ms 300000] [--poll-ms 10000] [--missing-grace-ms 90000]
// Prints one JSON line. Exit 0 when the run succeeded, 1 for a terminal
// non-success, 3 when still pending at the timeout, 4 when no run ever appeared.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function latestRun(runs, name) {
  const rows = (runs || []).filter(run => run && run.name === name);
  rows.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
  return rows.at(-1) || null;
}

export function classifyRun(run) {
  if (!run) return "missing";
  if (run.status !== "completed" && !run.conclusion) return "pending";
  return run.conclusion === "success" ? "success" : "failure";
}

export async function waitForRun({
  list, name = "schema-gate", timeoutMs = 300000, pollMs = 10000, missingGraceMs = 90000,
  now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const start = now();
  for (;;) {
    const run = latestRun(await list(), name);
    const state = classifyRun(run);
    const waited = now() - start;
    const base = { workflow: name, state, waitedMs: waited, runId: run?.id ?? null, conclusion: run?.conclusion ?? null };
    if (state === "success" || state === "failure") return base;
    // A push run is registered within seconds; give "missing" a short grace so a
    // commit that never starts the workflow does not hold the gate for the full window.
    if (state === "missing" && waited >= missingGraceMs) return base;
    if (waited >= timeoutMs) return base;
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - waited)));
  }
}

export function ghListRuns(repo, sha, spawn = spawnSync) {
  return () => {
    const result = spawn("gh", ["api", `repos/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=100`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`gh api failed: ${(result.stderr || "").trim().slice(0, 200)}`);
    return JSON.parse(result.stdout).workflow_runs || [];
  };
}

const EXIT = { success: 0, failure: 1, pending: 3, missing: 4 };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const repo = opt("--repo");
  const sha = opt("--sha");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("usage: deploy-gate-wait.mjs --repo OWNER/REPO --sha <40-hex> [--workflow NAME] [--timeout-ms N] [--poll-ms N] [--missing-grace-ms N]");
    process.exit(2);
  }
  let result;
  try {
    result = await waitForRun({
      list: ghListRuns(repo, sha), name: opt("--workflow", "schema-gate"),
      timeoutMs: Number(opt("--timeout-ms", 300000)), pollMs: Number(opt("--poll-ms", 10000)),
      missingGraceMs: Number(opt("--missing-grace-ms", 90000)),
    });
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(5);
  }
  console.log(JSON.stringify({ sha, ...result }));
  process.exit(EXIT[result.state]);
}
