// test-rename-check.mjs — mutation-testing-lite for the COLLIDE-4 failure mode.
//
// A new test that covers a non-default path driven by a field must be
// rename-proof: it has to FAIL when the consumed field is renamed in the
// source. A test that still passes with the field renamed (or deleted, or
// hardcoded) is rename-blind — it does not actually exercise the field,
// however green it looks.
//
// Given a test file and a field rename, this script copies the repo tree
// into a scratch dir under .tmp/ (so the real tree is never mutated),
// applies the rename to the SOURCE file(s) only (never the test), runs the
// test against the mutated source, and reports a verdict.
//
// Usage:
//   node scripts/test-rename-check.mjs \
//     --test tests/spend-grants.test.js \
//     --source server/spend-grants.mjs \
//     --rename replay:replayz [--source <another.mjs>] [--keep]
//
// The rename is textual (word-boundary); the script prints the mutation diff
// so you can confirm it only touched the intended identifier. Pass every
// source file that produces or consumes the field via --source (repeatable);
// the rename must cover the field's full source-side surface, otherwise the
// mutated run can fail for an unrelated cross-file contract break.
//
// Exit codes:
//   0  RENAME-PROOF — the test failed under the rename: it depends on the field.
//   1  RENAME-BLIND — the test passed under the rename: flag it (see CONTRIBUTING.md).
//   2  the check itself errored: bad usage, missing file, the field was not
//      found in the source, or the test was already red before the mutation
//      (the unmutated baseline runs first and a red baseline refuses verdict).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { PROOF: 0, BLIND: 1, ERROR: 2 };
export const VERDICT_PROOF = "RENAME-PROOF";
export const VERDICT_BLIND = "RENAME-BLIND";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SKIP_DIRS = new Set([".git", ".tmp", "node_modules"]);
const DIFF_LINE_CAP = 200;
const DIFF_HUNK_CAP = 40;

export function parseArgs(argv) {
  const opts = { sources: [], keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--test") opts.test = argv[++i];
    else if (a === "--source") opts.sources.push(argv[++i]);
    else if (a === "--rename") {
      const v = argv[++i] || "";
      const idx = v.indexOf(":");
      opts.oldName = v.slice(0, idx);
      opts.newName = v.slice(idx + 1);
    } else if (a === "--keep") opts.keep = true;
    else if (a === "--scratch-name") opts.scratchName = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.test) throw new Error("missing required --test <path>");
  if (opts.sources.length === 0) throw new Error("missing required --source <path> (repeatable)");
  if (!opts.oldName || !opts.newName) throw new Error("missing required --rename old:new");
  return opts;
}

export function printUsage() {
  console.log(`usage: node scripts/test-rename-check.mjs --test <test> --source <src> [--source <src>] --rename old:new [--keep] [--scratch-name <n>] [--timeout-ms <ms>]
  --test          test file, repo-relative (e.g. tests/spend-grants.test.js)
  --source        source file the rename applies to, repo-relative; repeatable
  --rename        old:new field rename applied to the source file(s) only
  --keep          keep the scratch dir under .tmp/rename-check/ (default: removed)
  --scratch-name  scratch dir name (default: <test>-<old>-to-<new>-<timestamp>)
  --timeout-ms    per-run node --test timeout (default 120000)
exit codes: 0 = RENAME-PROOF (test failed under rename), 1 = RENAME-BLIND (test passed),
            2 = check error (usage, missing file, no replacements, red baseline)`);
}

// Full-tree copy so the scratch keeps a working import closure (relative
// imports keep resolving). Skips .git, .tmp (which holds the scratch dir
// itself) and node_modules.
export function copyTreeForCheck(root, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(root, dest, {
    recursive: true,
    filter: src => !SKIP_DIRS.has(basename(src)),
  });
}

// Word-boundary textual rename across the given absolute source paths.
// Returns per-file replacement counts plus old/new contents for the diff.
// Throws when nothing was replaced — a silent no-op rename would invert the
// verdict, so it is a hard error, not an empty result.
export function applyRenameToFiles(absPaths, oldName, newName) {
  if (!IDENT.test(oldName) || !IDENT.test(newName)) {
    throw new Error(`rename names must be identifiers, got "${oldName}:${newName}"`);
  }
  if (oldName === newName) throw new Error("rename old and new names are identical");
  const pattern = new RegExp(`\\b${oldName}\\b`, "g");
  const files = [];
  let totalReplacements = 0;
  for (const p of absPaths) {
    const oldContent = readFileSync(p, "utf8");
    let replacements = 0;
    const newContent = oldContent.replace(pattern, () => {
      replacements++;
      return newName;
    });
    if (replacements > 0) writeFileSync(p, newContent, "utf8");
    files.push({ path: p, replacements, oldContent, newContent });
    totalReplacements += replacements;
  }
  if (totalReplacements === 0) {
    throw new Error(`no replacements: "${oldName}" not found in ${absPaths.length} source file(s)`);
  }
  return { files, totalReplacements };
}

export function mutationDiffText(mutation, displayRoot) {
  const lines = [];
  for (const f of mutation.files) {
    if (f.replacements === 0) continue;
    lines.push(`--- ${relative(displayRoot, f.path)} (${f.replacements} replacements)`);
    const oldLines = f.oldContent.split("\n");
    const newLines = f.newContent.split("\n");
    let shown = 0;
    for (let i = 0; i < oldLines.length && shown < DIFF_HUNK_CAP; i++) {
      if (oldLines[i] !== newLines[i]) {
        lines.push(`  L${i + 1} - ${oldLines[i].slice(0, DIFF_LINE_CAP)}`);
        lines.push(`  L${i + 1} + ${newLines[i].slice(0, DIFF_LINE_CAP)}`);
        shown++;
      }
    }
    if (shown >= DIFF_HUNK_CAP) lines.push("  ... (diff truncated)");
  }
  return lines.join("\n");
}

export function runNodeTest({ scratchRoot, testAbsPath, timeoutMs }) {
  const scratchTmp = join(scratchRoot, ".tmp");
  mkdirSync(scratchTmp, { recursive: true });
  const started = Date.now();
  const env = { ...process.env, TMPDIR: scratchTmp, XDG_RUNTIME_DIR: scratchTmp };
  // A nested `node --test` started from inside another test runner inherits
  // NODE_TEST_CONTEXT and then silently skips running files ("run() is being
  // called recursively ... skipping running files", exit 0). That would make
  // every check report RENAME-BLIND. Strip the runner's context vars so the
  // scratch run is always a fresh runner.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const res = spawnSync(process.execPath, ["--test", testAbsPath], {
    cwd: scratchRoot,
    env,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`;
  return {
    passed: res.status === 0,
    exitCode: res.status,
    signal: res.signal,
    timedOut: Boolean(res.error) && res.error.code === "ETIMEDOUT",
    durationMs: Date.now() - started,
    output,
  };
}

// Runs the full check synchronously. Returns a result object; never throws
// for check-level problems (those become exitCode 2 with error set).
export function runRenameCheck(opts) {
  const { root, test, sources, oldName, newName } = opts;
  const scratchParent = opts.scratchParent || join(root, ".tmp", "rename-check");
  const keep = Boolean(opts.keep);
  const timeoutMs = opts.timeoutMs || 120000;
  const fail = error => ({
    verdict: null, exitCode: EXIT.ERROR, error,
    baseline: null, mutated: null, mutation: null, scratchDir: null,
  });

  const testAbs = resolve(root, test);
  if (!existsSync(testAbs)) return fail(`test file not found: ${test}`);
  const sourceAbs = [];
  for (const s of sources || []) {
    const a = resolve(root, s);
    if (!existsSync(a)) return fail(`source file not found: ${s}`);
    sourceAbs.push(a);
  }
  if (!IDENT.test(oldName) || !IDENT.test(newName)) {
    return fail(`rename names must be identifiers, got "${oldName}:${newName}"`);
  }
  if (oldName === newName) return fail("rename old and new names are identical");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = basename(test).replace(/\.(test|spec)\.(mjs|js|cjs)$/, "");
  const scratchName = opts.scratchName || `${base}-${oldName}-to-${newName}-${stamp}`;
  const scratchDir = join(scratchParent, scratchName);
  mkdirSync(scratchParent, { recursive: true });
  copyTreeForCheck(root, scratchDir);

  try {
    const baseline = runNodeTest({
      scratchRoot: scratchDir,
      testAbsPath: join(scratchDir, relative(root, testAbs)),
      timeoutMs,
    });
    if (baseline.timedOut) {
      return { ...fail(`baseline run timed out after ${timeoutMs}ms`), baseline, scratchDir };
    }
    if (!baseline.passed) {
      return {
        ...fail(`baseline test failed before any mutation (exit ${baseline.exitCode}); fix the test first`),
        baseline, scratchDir,
      };
    }
    let mutation;
    try {
      mutation = applyRenameToFiles(
        sourceAbs.map(a => join(scratchDir, relative(root, a))),
        oldName,
        newName,
      );
    } catch (e) {
      return { ...fail(e.message), baseline, scratchDir };
    }
    const mutated = runNodeTest({
      scratchRoot: scratchDir,
      testAbsPath: join(scratchDir, relative(root, testAbs)),
      timeoutMs,
    });
    const proof = !mutated.passed;
    return {
      verdict: proof ? VERDICT_PROOF : VERDICT_BLIND,
      exitCode: proof ? EXIT.PROOF : EXIT.BLIND,
      error: null, baseline, mutated, mutation, scratchDir,
    };
  } finally {
    if (!keep) rmSync(scratchDir, { recursive: true, force: true });
  }
}

function tailLines(text, n) {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function printReport(root, opts, result) {
  console.log("test-rename-check");
  console.log(`  test:    ${opts.test}`);
  console.log(`  sources: ${(opts.sources || []).join(", ")}`);
  console.log(`  rename:  ${opts.oldName} -> ${opts.newName}`);
  if (result.error) {
    console.log(`  ERROR: ${result.error}`);
    if (result.scratchDir) console.log(`  scratch: ${result.scratchDir}`);
    return;
  }
  console.log(`  baseline: PASS (${(result.baseline.durationMs / 1000).toFixed(1)}s)`);
  console.log(`  mutation: ${result.mutation.totalReplacements} replacements`);
  console.log(mutationDiffText(result.mutation, result.scratchDir));
  const m = result.mutated;
  console.log(`  mutated run: ${m.passed ? "PASS" : "FAIL"} (${(m.durationMs / 1000).toFixed(1)}s)`);
  if (!m.passed) {
    if (m.output.includes(opts.newName)) {
      console.log(`  (failure mentions the renamed field "${opts.newName}")`);
    }
    console.log("  --- failing output (tail) ---");
    console.log(tailLines(m.output.trimEnd(), 30));
    console.log("  --- end ---");
  }
  if (result.scratchDir && opts.keep) console.log(`  scratch kept: ${result.scratchDir}`);
  console.log(`VERDICT: ${result.verdict}`);
}

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`test-rename-check: ${e.message}`);
    printUsage();
    process.exit(EXIT.ERROR);
  }
  if (opts.help) {
    printUsage();
    process.exit(0);
  }
  const result = runRenameCheck({
    root,
    scratchParent: join(root, ".tmp", "rename-check"),
    ...opts,
  });
  printReport(root, opts, result);
  process.exit(result.exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
