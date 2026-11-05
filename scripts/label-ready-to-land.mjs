#!/usr/bin/env node
/**
 * Label a PR ready-to-land once its ungated checks are green.
 *
 * Why a user token is required
 * ---------------------------
 * docs/RELEASE-MERGE-GATE.md: a label applied with GITHUB_TOKEN does
 * not start the labeled heavy workflows. The landing loop (or this
 * script with a personal / app installation token) must apply the
 * label so test.yml / schema-gate / pr-gates / machine / relay run.
 *
 * Usage
 *   GH_TOKEN=... node scripts/label-ready-to-land.mjs <pr-number>
 *   GH_TOKEN=... node scripts/label-ready-to-land.mjs <pr-number> --force
 *
 * Ungated gates checked (must be success or skipped/neutral):
 *   safety-net, mechanical (review-mechanical), pin-gate (when present)
 *
 * --force skips the check gate and only adds the label.
 */
import { spawnSync } from "node:child_process";

const REPO = process.env.GITHUB_REPOSITORY || "Uuriko/project-room";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const pr = Number(process.argv[2]);
const force = process.argv.includes("--force");

if (!Number.isInteger(pr) || pr < 1) {
  console.error("usage: node scripts/label-ready-to-land.mjs <pr-number> [--force]");
  process.exit(2);
}
if (!token) {
  console.error("GH_TOKEN (user/app token) required; GITHUB_TOKEN will not start labeled jobs");
  process.exit(2);
}

function ghJson(args, input) {
  const r = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    input: input ?? undefined,
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  if (r.status !== 0) {
    throw new Error(`gh api ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const prData = ghJson([`repos/${REPO}/pulls/${pr}`]);
if (prData.draft) {
  console.error(`#${pr} is a draft; refuse to label`);
  process.exit(1);
}
const labels = (prData.labels || []).map((l) => l.name);
if (labels.includes("ready-to-land")) {
  console.log(`#${pr} already has ready-to-land`);
  process.exit(0);
}

const head = prData.head.sha;
if (!force) {
  const checks = ghJson([
    `repos/${REPO}/commits/${head}/check-runs?per_page=100&filter=latest`,
  ]);
  const byName = new Map();
  for (const run of checks.check_runs || []) {
    byName.set(run.name, run);
  }
  const required = ["safety-net", "mechanical"];
  // pin-gate only reports on workflow/action/lockfile paths; require when present.
  if (byName.has("pin-gate")) required.push("pin-gate");

  const bad = [];
  for (const name of required) {
    const run = byName.get(name);
    if (!run) {
      bad.push(`${name}: missing`);
      continue;
    }
    if (run.status !== "completed") {
      bad.push(`${name}: ${run.status}`);
      continue;
    }
    if (!["success", "skipped", "neutral"].includes(run.conclusion)) {
      bad.push(`${name}: ${run.conclusion}`);
    }
  }
  if (bad.length) {
    console.error(`#${pr} @ ${head.slice(0, 8)} not ready:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
}

const next = [...new Set([...labels, "ready-to-land"])];
ghJson(
  ["--method", "PATCH", `repos/${REPO}/issues/${pr}`, "--input", "-"],
  JSON.stringify({ labels: next }),
);
console.log(`labeled #${pr} ready-to-land @ ${head.slice(0, 8)}`);
