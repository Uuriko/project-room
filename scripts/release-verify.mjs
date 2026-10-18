#!/usr/bin/env node
// release:verify — the one releaser-runnable gate for the production lane.
//
//   npm run release:verify                      # offline plan: unit suite,
//                                               # cloudflare check suite,
//                                               # worker bundle build; the
//                                               # live stages skip (no target)
//   npm run release:verify -- --target https://staging.example
//                                               # also cold-start probe +
//                                               # live smoke against the target
//   npm run release:verify -- --target URL --require-live
//                                               # deploy-workflow mode: a
//                                               # skipped live stage fails
//   npm run release:verify -- build             # one stage (explicit = required)
//   npm run release:verify -- --list            # print the plan, run nothing
//
// Extra arguments after `--` in stage position are stage names; anything
// after a second `--` is passed through to the last named stage's script.
//
// Stage order is the lane order from the decision-17 fold design
// (docs: project-room-joining/e5-machine-extraction-prep.md §C):
//   1. unit       — the root unit suite (`npm test`)
//   2. cloudflare — the cloudflare check suite: tests/cloudflare/*.check.mjs
//                   once the fold lands; until then the legacy
//                   cloudflare/package.json scripts, when its deps exist
//   3. build      — worker bundle build (scripts/worker-ci-build.mjs)
//   4. cold-start — scripts/cold-start-probe.mjs --base <target>
//   5. live-smoke — scripts/live-smoke.mjs against <target>
//
// A stage whose prerequisites are absent (deps not installed, no --target)
// is SKIPPED and reported, never silently passed: the summary lists it.
// A skipped stage fails the run only when it was explicitly requested or
// --require-live applies to it. A stage that runs and fails fails the run.
import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STAGE_ORDER = ["unit", "cloudflare", "build", "cold-start", "live-smoke"];
const LIVE_STAGES = new Set(["cold-start", "live-smoke"]);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Pure plan: which stages run, which skip (and why), which block the run.
// facts: { target, offline, requireLive, explicit:Set<string>,
//          hasMovedChecks, hasLegacyPackage, legacyDepsInstalled,
//          wranglerInstalled }
export function planStages(facts) {
  const plan = [];
  const entry = (name, run, reason = "", blocked = false) => plan.push({ name, run, reason, blocked });
  for (const name of STAGE_ORDER) {
    const explicit = facts.explicit.has(name);
    if (facts.explicit.size && !explicit) continue;
    if (LIVE_STAGES.has(name)) {
      if (!facts.target || facts.offline) {
        const reason = facts.offline && facts.target ? "offline mode" : "no --target origin given";
        const blocked = explicit || facts.requireLive;
        entry(name, false, `skipped: ${reason}`, blocked);
      } else {
        entry(name, true);
      }
      continue;
    }
    if (name === "cloudflare" && !facts.hasMovedChecks && !facts.hasLegacyPackage) {
      entry(name, false, "skipped: no cloudflare check suite found", explicit);
      continue;
    }
    if (name === "cloudflare" && !facts.hasMovedChecks && facts.hasLegacyPackage && !facts.legacyDepsInstalled) {
      entry(name, false, "skipped: cloudflare/ deps not installed (pnpm --dir cloudflare install --frozen-lockfile --ignore-scripts)", explicit);
      continue;
    }
    if (name === "build" && !facts.wranglerInstalled) {
      entry(name, false, "skipped: wrangler not installed for the worker bundle build", explicit);
      continue;
    }
    entry(name, true);
  }
  return plan;
}

function detectFacts({ target, offline, requireLive, explicit }) {
  const movedChecks = globSync("tests/cloudflare/*.check.mjs", { cwd: ROOT }).sort();
  return {
    target, offline, requireLive, explicit,
    movedChecks,
    hasMovedChecks: movedChecks.length > 0,
    hasLegacyPackage: existsSync(join(ROOT, "cloudflare/package.json")),
    legacyDepsInstalled: existsSync(join(ROOT, "cloudflare/node_modules")),
    // The bundle build resolves wrangler from cloudflare/node_modules in the
    // current layout and from the root install once the fold completes.
    wranglerInstalled:
      existsSync(join(ROOT, "cloudflare/node_modules/wrangler")) ||
      existsSync(join(ROOT, "node_modules/wrangler")),
  };
}

function stageCommand(name, facts, passthrough) {
  switch (name) {
    case "unit":
      return { cmd: "npm", args: ["test", ...passthrough] };
    case "cloudflare":
      if (facts.hasMovedChecks) {
        return { cmd: process.execPath, args: ["--test", ...facts.movedChecks, ...passthrough] };
      }
      return { cmd: "npm", args: ["--prefix", "cloudflare", "test", ...passthrough], extra: [{ cmd: "npm", args: ["--prefix", "cloudflare", "run", "test:browser"] }] };
    case "build":
      return { cmd: process.execPath, args: ["scripts/worker-ci-build.mjs", ...passthrough] };
    case "cold-start":
      return { cmd: process.execPath, args: ["scripts/cold-start-probe.mjs", "--base", facts.target, ...passthrough] };
    case "live-smoke":
      return { cmd: process.execPath, args: ["scripts/live-smoke.mjs", ...passthrough], env: { ROOM_SMOKE_ORIGIN: facts.target } };
    default:
      throw new Error(`unknown stage: ${name}`);
  }
}

function runStage(name, facts, passthrough) {
  const spec = stageCommand(name, facts, passthrough);
  const commands = [spec, ...(spec.extra ?? [])];
  for (const command of commands) {
    console.log(`\n=== release:verify stage: ${name} — ${command.cmd} ${command.args.join(" ")}`);
    const result = spawnSync(command.cmd, command.args, {
      cwd: ROOT, stdio: "inherit", env: { ...process.env, ...(command.env ?? spec.env ?? {}) },
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  return 0;
}

export function parseArgs(argv) {
  const parsed = { target: null, offline: false, requireLive: false, list: false, explicit: new Set(), passthrough: [] };
  let passthroughMode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthroughMode) { parsed.passthrough.push(arg); continue; }
    if (arg === "--") { passthroughMode = true; continue; }
    if (arg === "--target") parsed.target = argv[++i] ?? null;
    else if (arg.startsWith("--target=")) parsed.target = arg.slice("--target=".length);
    else if (arg === "--offline") parsed.offline = true;
    else if (arg === "--require-live") parsed.requireLive = true;
    else if (arg === "--list") parsed.list = true;
    else if (STAGE_ORDER.includes(arg)) parsed.explicit.add(arg);
    else throw new Error(`release-verify: unknown argument: ${arg}`);
  }
  return parsed;
}

function main(argv) {
  const parsed = parseArgs(argv);
  const facts = detectFacts(parsed);
  const plan = planStages(facts);
  console.log("release:verify plan:");
  for (const step of plan) {
    console.log(`  ${step.name.padEnd(11)} ${step.run ? "run" : step.reason}${step.blocked ? " (REQUIRED — blocks)" : ""}`);
  }
  if (parsed.list) return 0;
  let failed = 0;
  for (const step of plan) {
    if (!step.run) {
      if (step.blocked) failed = 1;
      continue;
    }
    const status = runStage(step.name, facts, parsed.explicit.has(step.name) ? parsed.passthrough : []);
    if (status !== 0) {
      console.error(`release:verify: stage ${step.name} failed (exit ${status})`);
      failed = 1;
      break;
    }
  }
  console.log(failed ? "\nrelease:verify: FAILED" : "\nrelease:verify: OK");
  return failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`release:verify: ${error.message}`);
    process.exitCode = 1;
  }
}
