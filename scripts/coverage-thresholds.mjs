// Per-module coverage thresholds gate (backlog Q015).
//
// Measures line coverage per module from the root `node --test` suite using
// V8 coverage (NODE_V8_COVERAGE, zero dependencies) and fails when any
// configured module drops below its ratchet threshold in
// coverage-thresholds.json. Thresholds are set at measured levels (ratchet):
// the gate prevents silent decay, it does not demand improvement.
//
// Usage:
//   node scripts/coverage-thresholds.mjs            # collect (runs the suite) + evaluate
//   node scripts/coverage-thresholds.mjs --collect-only
//   node scripts/coverage-thresholds.mjs --coverage-dir <dir>   # evaluate existing data
//   node scripts/coverage-thresholds.mjs --evaluate <dir> [<dir> ...]
//       # T-1: merge per-shard coverage payloads (collected inside the unit
//       # shards by scripts/unit-ci.mjs --coverage) and evaluate the SAME
//       # thresholds with the SAME semantics — no second full-suite run.
//       # Each <dir> is searched recursively for coverage-*.json payloads;
//       # a dir with no payloads is a usage error (exit 2), so a missing
//       # shard fails closed instead of silently evaluating partial data.
//       # When shard coverage-manifest.json files are present, the set
//       # must be complete (every shard 1..total exactly once), successful
//       # (status 0), and bound to one plan/revision/run — else exit 2.
//   node scripts/coverage-thresholds.mjs --baseline             # collect + print measured JSON
//   node scripts/coverage-thresholds.mjs --config <path>        # alternate config
//
// Exit codes: 0 = all thresholds met; 1 = threshold breach or suite failure;
// 2 = usage/config error.
//
// Measurement notes (approximations, applied identically on every run so the
// ratchet stays comparable):
// - Coverage is computed PER TEST PROCESS from that process's own V8 ranges
//   (where boundaries are self-consistent), then unioned across processes: a
//   line counts as covered when any process covers it. Raw ranges are never
//   merged across processes, because V8 range boundaries for the same code can
//   differ between processes — merging them lets a zero-count child span from
//   one process shadow a positive parent span from another, making coverage
//   non-monotonic in the test set.
// - Within one process, a source line is "covered" when its code span touches
//   executed bytes (count > 0 ranges minus count == 0 ranges nested inside
//   them). Lines overlapped by a never-called function's own span are
//   uncovered — this matches how the zero-count `unused` function in an
//   otherwise-executed file must not count as covered.
// - "Coverable" lines exclude blank lines and comment-only lines (//, /* */,
//   and * continuations, with block-comment state tracked across lines).
// - Files in a module that were never loaded by the suite count as 0 covered
//   but still contribute coverable lines, so a brand-new untested module file
//   drags the module percentage down and trips the gate.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(join(here, ".."));
export const DEFAULT_CONFIG_PATH = join(ROOT, "coverage-thresholds.json");

// Files that are never production source, excluded from every module.
const ALWAYS_EXCLUDE_SUFFIXES = [
  ".test.js",
  ".test.mjs",
  ".test.cjs",
  ".check.js",
  ".check.mjs",
];

/**
 * Load and validate the thresholds config.
 * Shape: { version: 1, note?: string, modules: { [name]: { dir, threshold, exclude?: string[] } } }
 * `dir` is relative to the repo root; `exclude` entries are filename suffixes
 * matched against the path relative to the module dir (e.g. "-check.mjs").
 */
export function loadConfig(configPath, root = ROOT) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`coverage config not found at ${configPath}: ${err.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`coverage config at ${configPath} is not valid JSON: ${err.message}`);
  }
  if (!config || typeof config !== "object" || !config.modules || typeof config.modules !== "object") {
    throw new Error(`coverage config at ${configPath} must have a "modules" object`);
  }
  for (const [name, mod] of Object.entries(config.modules)) {
    if (!mod || typeof mod !== "object") throw new Error(`module "${name}": must be an object`);
    if (typeof mod.dir !== "string" || mod.dir.length === 0)
      throw new Error(`module "${name}": "dir" must be a non-empty string`);
    if (!statSync(join(root, mod.dir), { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`module "${name}": dir "${mod.dir}" does not exist under ${root}`);
    if (typeof mod.threshold !== "number" || Number.isNaN(mod.threshold) || mod.threshold < 0 || mod.threshold > 100)
      throw new Error(`module "${name}": "threshold" must be a number in [0, 100]`);
    if (mod.exclude !== undefined && !Array.isArray(mod.exclude))
      throw new Error(`module "${name}": "exclude" must be an array of filename suffixes`);
  }
  return config;
}

/** Run the root `node --test` suite with V8 coverage into coverageDir. Returns the suite exit status. */
export function collectCoverage({ root = ROOT, coverageDir, tmpDir } = {}) {
  const dir = coverageDir || join(root, "coverage");
  const tmp = tmpDir || join(root, ".tmp");
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  // Drop stale coverage files so a re-run never mixes old and new data.
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".json")) rmSync(join(dir, name));
  }
  const res = spawnSync(process.execPath, ["--test"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_V8_COVERAGE: dir, TMPDIR: tmp },
  });
  return { status: res.status ?? 1, coverageDir: dir };
}

/** Read every coverage-*.json payload in dir, yielding parsed payloads one at a time. */
export function* readCoveragePayloads(coverageDir) {
  if (!existsSync(coverageDir)) return;
  for (const name of readdirSync(coverageDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      yield JSON.parse(readFileSync(join(coverageDir, name), "utf8"));
    } catch {
      // A truncated write from a killed child must not fail the gate.
    }
    // Hint GC: each payload is large; don't let them pile up behind the iterator.
  }
}

const isCoveragePayloadName = name =>
  name.startsWith("coverage-") && name.endsWith(".json") && name !== "coverage-manifest.json";

/**
 * Recursively list V8 coverage payload files (coverage-*.json) under dir,
 * sorted for deterministic evaluation. Missing dirs yield []. Only payload
 * names match: shard receipts, junit files, and coverage-manifest.json in
 * the same tree are evidence, not payloads.
 */
export function listCoveragePayloadFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const walk = absDir => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const full = join(absDir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isCoveragePayloadName(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Read payload files listed by listCoveragePayloadFiles, tolerating truncated writes. */
export function* readCoveragePayloadFiles(files) {
  for (const file of files) {
    try {
      yield JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Same tolerance as readCoveragePayloads: a truncated write from a
      // killed child must not fail the gate.
    }
  }
}

/** Recursively find and parse every coverage-manifest.json under the given dirs. */
export function readCoverageManifests(dirs) {
  const manifests = [];
  const walk = absDir => {
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const full = join(absDir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "coverage-manifest.json") {
        try {
          manifests.push(JSON.parse(readFileSync(full, "utf8")));
        } catch {
          manifests.push(null); // surfaced as an error by checkCoverageManifests
        }
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return manifests;
}

/**
 * Validate the shard coverage manifest set (T-1). An empty set is valid:
 * payloads collected without manifests (e.g. a plain --coverage-dir run or
 * synthetic fixtures) keep the pre-T-1 evaluate behaviour. When manifests
 * ARE present they must describe one complete, successful shard run:
 * every shard index 1..total exactly once, all agreeing on planHash,
 * revision, runId, and runAttempt, each with status 0 and >= 1 payload.
 * Returns { ok, errors } — callers treat !ok as a usage error (exit 2),
 * never as a threshold verdict.
 */
export function checkCoverageManifests(manifests) {
  const errors = [];
  if (!Array.isArray(manifests) || manifests.length === 0) return { ok: true, errors };
  for (const m of manifests) {
    if (!m || typeof m !== "object" || m.kind !== "unit-shard-coverage") {
      errors.push("coverage manifest is missing, unparseable, or not a unit-shard-coverage manifest");
      break;
    }
  }
  if (errors.length) return { ok: false, errors };
  const first = manifests[0];
  const total = first.total;
  if (!Number.isInteger(total) || total < 1) {
    return { ok: false, errors: ["coverage manifest has an invalid shard total"] };
  }
  const seen = new Set();
  for (const m of manifests) {
    if (m.total !== total) errors.push(`shard ${m.index}: total ${m.total} disagrees with ${total}`);
    if (!Number.isInteger(m.index) || m.index < 1 || m.index > total) {
      errors.push(`coverage manifest has invalid shard index ${m.index}`);
      continue;
    }
    if (seen.has(m.index)) errors.push(`duplicate coverage manifest for shard ${m.index}/${total}`);
    seen.add(m.index);
    if (m.status !== 0) errors.push(`shard ${m.index}/${total}: shard run did not succeed (status ${m.status})`);
    if (!(m.payloadCount >= 1)) errors.push(`shard ${m.index}/${total}: manifest records no coverage payloads`);
    for (const field of ["planHash", "revision", "runId", "runAttempt"]) {
      if (m[field] !== first[field]) {
        errors.push(`shard ${m.index}/${total}: ${field} disagrees with shard ${first.index}/${total} (stale or mixed run)`);
      }
    }
  }
  for (let i = 1; i <= total; i++) {
    if (!seen.has(i)) errors.push(`missing coverage manifest for shard ${i}/${total}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Group raw V8 coverage payloads by script URL WITHOUT merging ranges across
 * payloads. Each payload keeps its own function/range list, because V8 range
 * boundaries for the same code can differ between processes: merging raw
 * ranges by (startOffset, endOffset) with max count lets a zero-count child
 * span from one process shadow a positive parent span from another (the same
 * tests split across processes then report less coverage than together —
 * non-monotonic). Coverage is instead computed per payload and unioned.
 * Returns Map<url, Array<{ name, ranges: [{ start, end, count }] }>>.
 */
export function groupFunctionsByUrl(payloads, root = ROOT) {
  const rootPrefix = pathToFileURL(root + sep).href;
  const grouped = new Map();
  for (const payload of payloads) {
    const scripts = payload?.result;
    if (!Array.isArray(scripts)) continue;
    for (const script of scripts) {
      const url = script?.url;
      if (typeof url !== "string" || !url.startsWith("file://")) continue;
      if (!url.startsWith(rootPrefix) || url.includes("/node_modules/")) continue;
      const functions = [];
      for (const fn of script.functions || []) {
        const ranges = [];
        for (const range of fn.ranges || []) {
          const { startOffset: start, endOffset: end, count } = range;
          if (typeof start !== "number" || typeof end !== "number" || end <= start) continue;
          ranges.push({ start, end, count });
        }
        if (ranges.length === 0) continue;
        functions.push({ name: fn.functionName || "", ranges });
      }
      if (functions.length === 0) continue;
      let list = grouped.get(url);
      if (!list) {
        list = [];
        grouped.set(url, list);
      }
      list.push(functions);
    }
  }
  return grouped;
}

/** Split text into lines as [startOffset, endOffset) spans (end excludes the newline). */
export function splitLineSpans(text) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  spans.push([start, text.length]);
  return spans;
}

/**
 * Per-line coverability: false for blank lines and comment-only lines.
 * Tracks /* ... *\/ block comments across lines; a line that starts with code
 * (e.g. `} /* end *\/`) still counts as coverable. Approximation, documented
 * above; applied identically on every run.
 */
export function coverableLines(text) {
  const lines = text.split("\n");
  const out = new Array(lines.length).fill(true);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") {
      out[i] = false;
      continue;
    }
    if (inBlock) {
      out[i] = false;
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*")) {
      out[i] = false;
      continue;
    }
    if (t.startsWith("/*")) {
      const close = t.indexOf("*/", 2);
      if (close === -1) {
        out[i] = false;
        inBlock = true;
      } else {
        // `/* ... */ code();` still has executable code on the line.
        const rest = t.slice(close + 2).trim();
        out[i] = !(rest === "" || rest.startsWith("//"));
      }
      continue;
    }
  }
  return out;
}

/** Subtract cut intervals from base intervals; both are [start, end) lists. */
export function subtractIntervals(base, cuts) {
  let out = base.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [cs, ce] of cuts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) {
        next.push([s, e]);
        continue;
      }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    out = next;
    if (out.length === 0) break;
  }
  return out;
}

/**
 * Covered line indices (0-based) for one source file from ONE payload's V8
 * functions. Boundaries are only ever compared within a single payload, where
 * V8's ranges are self-consistent; callers union these sets across payloads.
 *
 * A line is covered when its code span (first to last non-whitespace char)
 * touches executed bytes (count > 0 ranges minus count == 0 ranges nested
 * inside them). Additionally, every line overlapped by a never-called
 * function's own span (ranges[0] with count == 0) is uncovered — this is what
 * keeps `export function unused` in an otherwise-executed file from counting
 * as covered via its `export ` prefix bytes.
 */
export function coveredLinesForPayload(text, functions) {
  const spans = splitLineSpans(text);
  const coverable = coverableLines(text);
  const positive = [];
  const zero = [];
  const zeroFnSpans = [];
  for (const fn of functions) {
    const ranges = fn.ranges || [];
    if (ranges.length === 0) continue;
    if (ranges[0].count === 0) zeroFnSpans.push([ranges[0].start, ranges[0].end]);
    for (const { start, end, count } of ranges) {
      (count > 0 ? positive : zero).push([start, end]);
    }
  }
  const coveredBytes = subtractIntervals(positive, zero);
  const covered = new Set();
  let iv = 0;
  for (let i = 0; i < spans.length; i++) {
    if (!coverable[i]) continue;
    const [ls, le] = spans[i];
    if (zeroFnSpans.some(([zs, ze]) => zs < le && ze > ls)) continue;
    const line = text.slice(ls, le);
    const m = line.match(/\S/);
    if (!m) continue;
    const cs = ls + m.index;
    const ce = ls + line.search(/\s*$/);
    while (iv < coveredBytes.length && coveredBytes[iv][1] <= cs) iv++;
    if (iv < coveredBytes.length && coveredBytes[iv][0] < ce) covered.add(i);
  }
  return covered;
}

/**
 * Line coverage for one source file from a single payload's V8 functions.
 * Returns { covered, coverable, pct, uncoveredLines } where uncoveredLines
 * lists up to the first 25 uncovered 1-based line numbers (for the report).
 */
export function lineCoverage(text, functions) {
  const coverable = coverableLines(text);
  const coverableCount = coverable.filter(Boolean).length;
  const covered = coveredLinesForPayload(text, functions);
  const uncoveredLines = [];
  for (let i = 0; i < coverable.length && uncoveredLines.length < 25; i++) {
    if (coverable[i] && !covered.has(i)) uncoveredLines.push(i + 1);
  }
  const pct = coverableCount === 0 ? 100 : (100 * covered.size) / coverableCount;
  return { covered: covered.size, coverable: coverableCount, pct, uncoveredLines };
}

function excludedBySuffix(relPosix, suffixes) {
  return suffixes.some(s => relPosix.endsWith(s));
}

/**
 * List production source files for a module: *.js/*.mjs/*.cjs under dir,
 * minus test/check files and minus the module's configured extra excludes.
 * Returns paths relative to the repo root, posix-style.
 */
export function listModuleFiles(root, dir, extraExclude = []) {
  const suffixes = [...ALWAYS_EXCLUDE_SUFFIXES, ...extraExclude];
  const out = [];
  const walk = absDir => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        const rel = relative(root, full).split(sep).join("/");
        const relToModule = relative(dir, rel).split(sep).join("/");
        if (!excludedBySuffix(relToModule, suffixes)) out.push(rel);
      }
    }
  };
  walk(join(root, dir));
  return out.sort();
}

/**
 * Evaluate every configured module against per-payload coverage.
 * A line counts as covered when ANY payload (test process) covers it —
 * coverage is monotonic in the test set. Files with no coverage data count
 * as 0 covered lines (decay-catching).
 */
export function evaluateModules(root, config, grouped) {
  const rootPrefix = pathToFileURL(root + sep).href;
  const results = {};
  for (const [name, mod] of Object.entries(config.modules)) {
    const files = listModuleFiles(root, mod.dir, mod.exclude || []);
    let covered = 0;
    let coverable = 0;
    const fileRows = [];
    const zeroCoverageFiles = [];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      const coverableArr = coverableLines(text);
      const coverableCount = coverableArr.filter(Boolean).length;
      const payloads = grouped.get(rootPrefix + rel);
      const union = new Set();
      if (payloads) {
        for (const functions of payloads) {
          for (const i of coveredLinesForPayload(text, functions)) union.add(i);
        }
      } else {
        zeroCoverageFiles.push(rel);
      }
      const pct = coverableCount === 0 ? 100 : (100 * union.size) / coverableCount;
      covered += union.size;
      coverable += coverableCount;
      const uncoveredLines = [];
      for (let i = 0; i < coverableArr.length && uncoveredLines.length < 25; i++) {
        if (coverableArr[i] && !union.has(i)) uncoveredLines.push(i + 1);
      }
      fileRows.push({ file: rel, covered: union.size, coverable: coverableCount, pct, uncoveredLines });
    }
    fileRows.sort((a, b) => a.pct - b.pct);
    results[name] = {
      dir: mod.dir,
      threshold: mod.threshold,
      files: files.length,
      covered,
      coverable,
      pct: coverable === 0 ? 100 : (100 * covered) / coverable,
      zeroCoverageFiles,
      lowestFiles: fileRows.slice(0, 10).map(r => ({ file: r.file, pct: r.pct })),
    };
  }
  return results;
}

/** Compare module percentages against thresholds. */
export function checkThresholds(config, results) {
  const failures = [];
  for (const [name, mod] of Object.entries(config.modules)) {
    const r = results[name];
    // Compare at 0.1 precision (thresholds are specified to 0.1): flooring
    // absorbs floating-point epsilon so 95.64% vs a 95.6 threshold passes.
    const pctFloor = Math.floor(r.pct * 10) / 10;
    if (pctFloor < mod.threshold) {
      failures.push({
        module: name,
        dir: mod.dir,
        threshold: mod.threshold,
        actual: r.pct,
        files: r.files,
        zeroCoverageFiles: r.zeroCoverageFiles.length,
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

const fmtPct = n => `${n.toFixed(1)}%`;

export function formatReport(results, check) {
  const lines = ["", "Per-module coverage thresholds:"];
  for (const [name, r] of Object.entries(results)) {
    const verdict = r.pct < r.threshold ? "FAIL" : "ok";
    lines.push(
      `  [${verdict}] ${name}/ (${r.files} files): ${fmtPct(r.pct)} covered vs ${fmtPct(r.threshold)} threshold` +
        (r.zeroCoverageFiles ? ` — ${r.zeroCoverageFiles} files with zero coverage data` : "")
    );
  }
  if (!check.ok) {
    lines.push("", "Threshold breaches (lowest-coverage files first):");
    for (const f of check.failures) {
      const r = results[f.module];
      lines.push(`  ✖ ${f.module}/: ${fmtPct(f.actual)} < ${fmtPct(f.threshold)}`);
      for (const lf of r.lowestFiles.slice(0, 8)) {
        lines.push(`      ${fmtPct(lf.pct).padStart(6)}  ${lf.file}`);
      }
    }
    lines.push("", "Coverage decayed below the ratchet: add tests for the uncovered lines, or");
    lines.push("(only with reviewer agreement) lower the threshold to the new measured level.");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = {
    config: DEFAULT_CONFIG_PATH,
    coverageDir: null,
    collectOnly: false,
    baseline: false,
    evaluate: false,
    dirs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") opts.config = resolve(argv[++i] || "");
    else if (a === "--coverage-dir") opts.coverageDir = resolve(argv[++i] || "");
    else if (a === "--collect-only") opts.collectOnly = true;
    else if (a === "--baseline") opts.baseline = true;
    else if (a === "--evaluate") opts.evaluate = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/coverage-thresholds.mjs [--config <path>] [--coverage-dir <dir>] [--collect-only] [--baseline] [--evaluate <dir> [<dir> ...]]");
      process.exit(0);
    } else if (!a.startsWith("-")) {
      opts.dirs.push(resolve(a));
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.config) {
    console.error("--config requires a path");
    process.exit(2);
  }
  if (opts.dirs.length && !opts.evaluate) {
    console.error("coverage directories are only accepted with --evaluate");
    process.exit(2);
  }
  if (opts.evaluate && opts.collectOnly) {
    console.error("--evaluate and --collect-only cannot be combined");
    process.exit(2);
  }
  return opts;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = loadConfig(opts.config);
  } catch (err) {
    console.error(`coverage gate: ${err.message}`);
    process.exit(2);
  }

  let payloads;
  if (opts.evaluate) {
    // T-1 evaluate mode: merge per-shard payloads, apply the thresholds.
    // Identical evaluation below — only the payload source differs from
    // the collect path (shard runs instead of one unsharded re-run).
    const dirs = opts.dirs.length ? opts.dirs : opts.coverageDir ? [opts.coverageDir] : [];
    if (!dirs.length) {
      console.error("coverage gate: --evaluate requires at least one coverage directory");
      process.exit(2);
    }
    const manifestCheck = checkCoverageManifests(readCoverageManifests(dirs));
    if (!manifestCheck.ok) {
      for (const err of manifestCheck.errors) console.error(`coverage gate: ${err}`);
      process.exit(2);
    }
    const files = [];
    for (const dir of dirs) {
      const found = listCoveragePayloadFiles(dir);
      if (!found.length) {
        console.error(`coverage gate: no coverage payloads in ${dir} (missing shard?)`);
        process.exit(2);
      }
      files.push(...found);
    }
    payloads = readCoveragePayloadFiles(files);
  } else {
    let coverageDir = opts.coverageDir;
    if (!coverageDir) {
      const { status, coverageDir: collected } = collectCoverage({ root: ROOT });
      coverageDir = collected;
      if (status !== 0) {
        console.error(`coverage gate: test suite failed (exit ${status}); not evaluating thresholds`);
        process.exit(1);
      }
      if (opts.collectOnly) {
        console.log(`coverage collected in ${coverageDir}`);
        process.exit(0);
      }
    }
    payloads = readCoveragePayloads(coverageDir);
  }
  const grouped = new Map();
  let payloadCount = 0;
  for (const payload of payloads) {
    payloadCount++;
    const one = groupFunctionsByUrl([payload], ROOT);
    for (const [url, list] of one) {
      let target = grouped.get(url);
      if (!target) {
        target = [];
        grouped.set(url, target);
      }
      target.push(...list);
    }
  }
  if (payloadCount === 0) {
    console.error("coverage gate: no coverage data found in the given coverage directories");
    process.exit(2);
  }
  const results = evaluateModules(ROOT, config, grouped);

  if (opts.baseline) {
    const out = {};
    for (const [name, r] of Object.entries(results)) out[name] = Math.floor(r.pct * 10) / 10;
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const check = checkThresholds(config, results);
  console.log(formatReport(results, check));
  process.exit(check.ok ? 0 : 1);
}
