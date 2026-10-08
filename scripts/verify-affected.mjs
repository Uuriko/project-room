#!/usr/bin/env node
// verify:affected: run only the unit tests related to your diff.
//
//   npm run verify:affected                  # diff vs origin/main (+ uncommitted + untracked)
//   npm run verify:affected -- --list        # print the selection and reasons, run nothing
//   npm run verify:affected -- --base=<ref> --budget=300
//
// --budget is seconds of wall time per test worker, estimated from the CI
// timings in scripts/unit-ci-durations.json. Hosted CI is much slower than a
// dev machine: the default ran 168 files in ~27s on 8 local cores.
//
// A Node-discovered test file (same discovery as `npm test`) is selected when:
//   1. it changed itself;
//   2. it imports a changed file, directly or transitively (static and
//      literal dynamic imports, require() and new URL(..., import.meta.url));
//   3. its source names a changed file's repo-relative path (docs, JSON,
//      workflow and fixture files that tests read).
// Closer tests win: distance 0 (the test or a path mention), then direct
// importers, then deeper importers, cheaper first, until the time budget
// (estimated from scripts/unit-ci-durations.json) is used up. Changed code
// with no related test, or a global file (package.json, the runner), adds a
// small smoke set. This is a fast local signal, not a replacement for CI.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, extname, join, normalize, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);
const RESOLVE_EXT = ["", ".js", ".mjs", ".cjs", "/index.js", "/index.mjs"];

export const SMOKE_TESTS = [
  "tests/demigod-contracts.test.js",
  "tests/channel-adapter-contracts.test.js",
  "tests/events.test.js",
  "tests/self-serve-join-contract.test.js",
  "tests/work-claim-events.test.js",
];

// Changing one of these can break any test; always add the smoke set.
export const GLOBAL_FILES = new Set([
  "package.json",
  "package-lock.json",
  "server.mjs",
  "scripts/check-deps.mjs",
  "scripts/unit-shards.mjs",
  "scripts/unit-ci.mjs",
  "scripts/verify-affected.mjs",
]);

const DEFAULT_ESTIMATE_MS = 15000;
// Files whose recorded CI time hits the 300s cap are skipped unless they
// changed themselves: one of them alone would blow the two-minute target.
const SLOW_MS = 120000;

const IMPORT_RES = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^'"`;]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];

export function parseImports(source) {
  const out = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

// Resolve a relative specifier from a repo-relative file to a repo-relative
// path in `known` (a Set). Bare and node: specifiers return null.
export function resolveSpecifier(fromFile, spec, known) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec.split(/[?#]/)[0]));
  if (base.startsWith("../")) return null;
  for (const ext of RESOLVE_EXT) {
    const candidate = base + ext;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

// files: repo-relative paths; read(file) -> source text.
// Returns Map<file, Set<importer>> (reverse edges) for every path a file
// references (code imports and new URL() asset references).
export function buildReverseGraph(files, read, known = new Set(files)) {
  const reverse = new Map();
  for (const file of files) {
    if (!CODE_EXT.has(extname(file))) continue;
    let source;
    try { source = read(file); } catch { continue; }
    for (const spec of parseImports(source)) {
      const target = resolveSpecifier(file, spec, known);
      if (!target || target === file) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  return reverse;
}

// BFS from changed files over reverse edges; returns Map<test, {distance, via}>.
export function relatedTests({ changed, tests, reverse, read }) {
  const testSet = new Set(tests);
  const hit = new Map();
  const note = (test, distance, via) => {
    const prev = hit.get(test);
    if (!prev || distance < prev.distance) hit.set(test, { distance, via });
  };
  for (const file of changed) {
    if (testSet.has(file)) note(file, 0, "changed");
    const seen = new Set([file]);
    let frontier = [file];
    for (let depth = 1; frontier.length; depth++) {
      const next = [];
      for (const node of frontier) {
        for (const importer of reverse.get(node) ?? []) {
          if (seen.has(importer)) continue;
          seen.add(importer);
          if (testSet.has(importer)) note(importer, depth, `imports ${file}`);
          next.push(importer);
        }
      }
      frontier = next;
    }
  }
  // Path mentions (non-test changed files). Nested paths match anywhere; a
  // root file (AGENTS.md, index.html) only as a quoted literal, so short
  // names do not match unrelated text.
  const mentionable = changed.filter((f) => !testSet.has(f));
  const mentions = (source, file) =>
    file.includes("/") ? source.includes(file) : ['"', "'", "`"].some((q) => source.includes(q + file + q));
  if (mentionable.length) {
    for (const test of tests) {
      let source;
      try { source = read(test); } catch { continue; }
      for (const file of mentionable) {
        if (mentions(source, file)) note(test, 0, `mentions ${file}`);
      }
    }
  }
  return hit;
}

// Pick tests closest first, then cheapest, within budgetMs of summed
// estimated time. Changed tests are always kept.
export function selectTests({ changed, tests, reverse, read, timings = {}, budgetMs, smoke = SMOKE_TESTS }) {
  const hit = relatedTests({ changed, tests, reverse, read });
  const estimate = (f) => (Number.isFinite(timings[f]) && timings[f] > 0 ? timings[f] : DEFAULT_ESTIMATE_MS);
  const ranked = [...hit.entries()].sort(
    ([a, x], [b, y]) => x.distance - y.distance || estimate(a) - estimate(b) || (a < b ? -1 : 1)
  );
  const selected = [];
  const skipped = [];
  let spent = 0;
  for (const [test, info] of ranked) {
    const ms = estimate(test);
    const mustKeep = info.via === "changed";
    if (!mustKeep && (ms >= SLOW_MS || spent + ms > budgetMs)) {
      skipped.push({ test, ...info, ms });
      continue;
    }
    selected.push({ test, ...info, ms });
    spent += ms;
  }
  const codeChanged = changed.filter((f) => CODE_EXT.has(extname(f)) && !f.startsWith("tests/"));
  const unmapped = codeChanged.filter((f) => ![...hit.values()].some((h) => h.via === `imports ${f}` || h.via === `mentions ${f}`));
  const reasons = [];
  if (!changed.length) reasons.push("no changes");
  if (changed.some((f) => GLOBAL_FILES.has(f))) reasons.push("global file changed");
  if (unmapped.length) reasons.push(`no related test for ${unmapped.slice(0, 3).join(", ")}${unmapped.length > 3 ? ", …" : ""}`);
  if (reasons.length) {
    const testSet = new Set(tests);
    for (const test of smoke) {
      if (!testSet.has(test) || selected.some((s) => s.test === test)) continue;
      selected.push({ test, distance: Infinity, via: "smoke", ms: estimate(test) });
    }
  }
  return { selected, skipped, smokeReasons: reasons };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function changedFiles(base, cwd) {
  let mergeBase = base;
  try { mergeBase = git(["merge-base", base, "HEAD"], cwd); } catch { /* fall back to the ref itself */ }
  const lists = [
    git(["diff", "--name-only", `${mergeBase}`, "--"], cwd), // committed + uncommitted tracked changes
    git(["ls-files", "--others", "--exclude-standard"], cwd), // untracked
  ];
  return [...new Set(lists.join("\n").split("\n").map((s) => s.trim()).filter(Boolean))].sort();
}

function parseArgs(argv) {
  const opts = { base: "origin/main", budget: 300, list: false, json: false };
  for (const arg of argv) {
    if (arg === "--list") opts.list = true;
    else if (arg === "--json") { opts.json = true; opts.list = true; }
    else if (arg.startsWith("--base=")) opts.base = arg.slice(7);
    else if (arg.startsWith("--budget=")) opts.budget = Number(arg.slice(9));
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`verify-affected: unknown argument ${arg}`);
  }
  if (!Number.isFinite(opts.budget) || opts.budget <= 0) throw new Error("--budget must be seconds > 0");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: npm run verify:affected -- [--base=origin/main] [--budget=300] [--list] [--json]");
    return 0;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const started = Date.now();
  const changed = changedFiles(opts.base, root);
  const { discoverUnitTests } = await import("./unit-shards.mjs");
  const tests = discoverUnitTests(".").filter((f) => !f.includes("node_modules"));
  const tracked = git(["ls-files"], root).split("\n").filter(Boolean);
  const known = new Set([...tracked, ...changed.filter((f) => existsSync(join(root, f)))]);
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, readFileSync(join(root, f), "utf8"));
    return cache.get(f);
  };
  const codeFiles = [...known].filter((f) => CODE_EXT.has(extname(f)) && !f.startsWith("node_modules/") && existsSync(join(root, f)));
  const reverse = buildReverseGraph(codeFiles, read, known);
  const timings = JSON.parse(readFileSync(join(root, "scripts/unit-ci-durations.json"), "utf8")).milliseconds;
  const workers = Math.max(1, availableParallelism() - 1);
  const result = selectTests({ changed, tests, reverse, read, timings, budgetMs: opts.budget * 1000 * workers });
  const planMs = Date.now() - started;

  if (opts.json) {
    console.log(JSON.stringify({ base: opts.base, changed, ...result, planMs }, (k, v) => (v === Infinity ? null : v), 2));
    return 0;
  }
  console.log(`verify:affected: ${changed.length} changed file(s) vs ${opts.base}; ${result.selected.length} test file(s) selected in ${planMs}ms`);
  for (const s of result.selected) console.log(`  ${s.test}  (${s.via})`);
  if (result.smokeReasons.length) console.log(`  + smoke set: ${result.smokeReasons.join("; ")}`);
  if (result.skipped.length) {
    console.log(`  ${result.skipped.length} more related test file(s) skipped for time (slow or over budget); CI runs them. Raise --budget to include.`);
  }
  if (opts.list) return 0;
  if (!result.selected.length) return 0;

  const scratch = resolve(root, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const env = { ...process.env, TMPDIR: process.env.TMPDIR || scratch };
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = env.TMPDIR;
  const run = spawnSync(process.execPath, ["--test", ...result.selected.map((s) => s.test)], { cwd: root, env, stdio: "inherit" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`verify:affected: exit ${run.status ?? 1} in ${secs}s (${result.selected.length} files)`);
  return run.status ?? 1;
}

if (process.argv[1] && normalize(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  // exitCode, not exit(): exit() can truncate piped stdout (--json) at 64 KiB.
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 2; });
}
