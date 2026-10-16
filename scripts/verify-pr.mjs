// verify:pr — one local command with hosted-CI gate parity (PERF-10X L14).
//
// Local `npm run lint` alone did not include scripts/untested-modules-lint.mjs,
// which hosted lint runs as a sibling step, and the contract censuses only
// ran inside hosted CI — so registration/bookkeeping omissions (untested
// modules, census pins, runtime-package registration, route docs, probe
// inventories) were discovered a full hosted round late. This command runs,
// in order, every non-test gate hosted CI runs for a PR:
//
//   1. lint                  npm run lint (eslint, design tokens,
//                            reachability, i18n, UI strings)
//   2. untested-modules      node scripts/untested-modules-lint.mjs — the
//                            hosted lint job's sibling step local lint lacked
//   3. contract              CI=1 node scripts/check.mjs — the hosted contract
//                            job exactly: node --check over every source file,
//                            UI strings, journey coverage, no-shadow-imports,
//                            route docs (openapi-gen --check), schema version,
//                            registry manifest, secret scan, open-route
//                            inventory (open-routes --check, which asserts
//                            ROUTE-AUTH-TABLE + INVITE-ONLY-CHECKLIST),
//                            wiki gates, workflow pins, doc links, GitHub App
//                            manifest, design contrast, token CSS sync.
//                            CI=1 is the hosted contract job's own switch:
//                            check.mjs then skips the root unit suite, which
//                            hosted CI runs in its dedicated unit jobs.
//   4. registration          node scripts/verify-pr-registration.mjs — a
//                            diff-keyed checklist: for each changed file it
//                            prints/asserts the registrations its class
//                            requires (runtime-package, candidate-runtime-
//                            fixture, tests/*.test.js direct import, census
//                            pins, route auth tables, endpoint PROBES).
//
// Every component runs even if an earlier one fails, each result is named,
// and the command exits non-zero if any component failed.
//
// Named SKIPs (never silent passes): the hosted unit, browser, cloudflare
// and coverage test suites are NOT run here — they are test suites, not
// gates this command claims parity with; run `npm run verify:affected` and
// `npm test` for tests. The hosted schema-gate / invariants / machine /
// relay workflows are likewise separate test suites, not contract censuses.
//
// Usage:
//   npm run verify:pr [-- --base <ref>] [--only lint,registration]
//                     [--skip contract] [--files a.mjs,b.mjs]
// Version: verify-pr v1 (2026-10-16). Gate tooling ships like a deploy:
// changes to this file or verify-pr-registration.mjs carry a version note
// in the PR body and land between landing waves, supervised.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const node = process.execPath;

const args = process.argv.slice(2);
function argValue(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}
const baseRef = argValue("--base") ?? "origin/main";
const files = argValue("--files");
const only = argValue("--only")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
const skip = new Set(argValue("--skip")?.split(",").map(s => s.trim()).filter(Boolean) ?? []);

const registrationArgs = ["scripts/verify-pr-registration.mjs", "--base", baseRef];
if (files) registrationArgs.push("--files", files);

export const STEPS = [
  {
    name: "lint",
    label: "lint (npm run lint)",
    command: ["npm", ["run", "lint"]],
  },
  {
    name: "untested-modules",
    label: "untested-modules (node scripts/untested-modules-lint.mjs)",
    command: [node, ["scripts/untested-modules-lint.mjs"]],
  },
  {
    name: "contract",
    label: "contract censuses (CI=1 node scripts/check.mjs — hosted contract job)",
    command: [node, ["scripts/check.mjs"]],
    env: { CI: "1" },
  },
  {
    name: "registration",
    label: "registration checklist (node scripts/verify-pr-registration.mjs)",
    command: [node, registrationArgs],
  },
];

if (args.includes("--list")) {
  for (const step of STEPS) console.log(`${step.name}: ${step.label}`);
  console.log("skip: unit/browser/cloudflare/coverage test suites and the schema-gate/invariants/machine/relay workflows (test suites, not contract gates — see header)");
  process.exit(0);
}

const results = [];
for (const step of STEPS) {
  if ((only && !only.includes(step.name)) || skip.has(step.name)) {
    console.log(`\n=== verify:pr — SKIP ${step.name} (excluded by ${only ? "--only" : "--skip"}) ===`);
    results.push({ name: step.name, status: "skipped-by-flag" });
    continue;
  }
  console.log(`\n=== verify:pr — ${step.label} ===`);
  const result = spawnSync(step.command[0], step.command[1], {
    cwd: root, stdio: "inherit", env: { ...process.env, ...(step.env ?? {}) },
  });
  const ok = result.status === 0;
  console.log(`--- verify:pr — ${step.name}: ${ok ? "PASS" : `FAIL (exit ${result.status ?? "signal"})`}`);
  results.push({ name: step.name, status: ok ? "pass" : "fail" });
}

console.log("\n=== verify:pr — summary ===");
for (const result of results) console.log(`  ${result.name}: ${result.status}`);
console.log("  suites: SKIP — unit/browser/cloudflare/coverage test suites and the schema-gate/invariants/machine/relay workflows are not run by verify:pr (test suites, not contract gates; use npm run verify:affected / npm test for tests)");
const failed = results.filter(r => r.status === "fail");
if (failed.length > 0) {
  console.error(`verify:pr FAILED — failing component(s): ${failed.map(r => r.name).join(", ")}`);
  process.exit(1);
}
console.log("verify:pr PASS — lint, untested-modules, contract censuses and the registration checklist are all green");
