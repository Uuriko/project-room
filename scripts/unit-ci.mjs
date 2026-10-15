#!/usr/bin/env node
// CI wrapper for one shard of `npm test` (CI-speed lane).
//
// Runs the shard's Node-discovered test files with `node --test` and writes a
// receipt under test-results/ for scripts/unit-shards-check.mjs. The receipt
// binds the shard to the exact plan (planHash), run, revision and attempt so
// the `unit` merge gate can fail closed on stale or partial evidence.
//
// Usage: node scripts/unit-ci.mjs --shard=1/3   (run from the repo root)
// Use worktree-local scratch by default; create explicit TMPDIR before children.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { unitPlan, parseShard } from "./unit-shards.mjs";
import { parseFailingTests } from "./failing-tests.mjs";

const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function xmlAttributes(text) {
  const out = {};
  for (const m of String(text).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function junitDisplayPath(file, cwd) {
  if (!file) return "";
  const normalized = file.split(sep).join("/");
  if (!isAbsolute(normalized)) return normalized;
  const rel = relative(cwd, file).split(sep).join("/");
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : normalized;
}

const FILE_LIKE = /\.(?:test\.)?[cm]?[jt]s$/;

/**
 * Per-file measured runtimes (ms) from a Node junit report.
 *
 * Node's junit reporter does not group by file in one fixed shape: loose
 * tests are `<testcase file="…" time="seconds">` elements directly under
 * `<testsuites>`, `describe` suites become `<testsuite>` elements whose
 * testcases still carry `file`, and some Node versions emit a testsuite
 * named by file path with a per-suite `time`. This parser therefore sums
 * testcase times per `file` (never testsuite times, which would double
 * count the testcases inside them), falls back to the enclosing testsuite
 * name when a testcase has no `file`, and uses a file-named testsuite's
 * own `time` only when no testcase contributed to that file. Keys are
 * repo-relative paths (relative to `cwd`); values are integer ms.
 * Malformed or missing input yields {} — the receipt is still written so
 * the merge gate can fail closed on the shard's own status.
 */
export function parseJunitFileDurations(xml, { cwd = process.cwd() } = {}) {
  const text = String(xml ?? "");
  const totals = new Map();
  const add = (file, seconds) => {
    const key = junitDisplayPath(file, cwd);
    const secs = Number(seconds);
    if (!key || !Number.isFinite(secs) || secs < 0) return;
    totals.set(key, (totals.get(key) ?? 0) + Math.round(secs * 1000));
  };
  // Token scan in document order so a testcase can inherit the file from
  // its enclosing testsuite, and so a file-named suite's time is only used
  // when none of its testcases contributed.
  const TAG_PATTERN = /<(testsuite|testcase)\b((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\/testsuite\s*>/g;
  const suiteStack = [];
  const suitesWithCases = new Set();
  let m;
  while ((m = TAG_PATTERN.exec(text))) {
    if (m[0].startsWith("</")) {
      const suite = suiteStack.pop();
      if (suite && FILE_LIKE.test(suite.name) && !suitesWithCases.has(junitDisplayPath(suite.name, cwd))) {
        add(suite.name, suite.time);
      }
      continue;
    }
    const attrs = xmlAttributes(m[2]);
    if (m[1] === "testsuite") {
      if (!m[3]) suiteStack.push({ name: attrs.name ?? "", time: attrs.time });
      else if (FILE_LIKE.test(attrs.name ?? "")) add(attrs.name, attrs.time);
    } else {
      const file = attrs.file || [...suiteStack].reverse().map((s) => s.name).find((name) => FILE_LIKE.test(name ?? ""));
      if (file) {
        add(file, attrs.time);
        suitesWithCases.add(junitDisplayPath(file, cwd));
      }
    }
  }
  return Object.fromEntries([...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function readJunitFileDurations(path, options = {}) {
  try {
    if (!path || !existsSync(path)) return {};
    return parseJunitFileDurations(readFileSync(path, "utf8"), options);
  } catch {
    return {};
  }
}

/**
 * Run test files with `node --test`, teeing the reporter stream to the console.
 * Returns { status, signal, failures, fileDurationsMs }: failing test names
 * parsed from the spec-reporter output (advisory — [] on success or when
 * nothing parsed), and per-file measured runtimes parsed from the junit
 * sidecar when `options.junitPath` is given ({} otherwise or when the
 * sidecar is missing/unparseable).
 *
 * The spec reporter stays on stdout exactly as before — an additional
 * junit reporter writes only to its sidecar file, so the stdout shape
 * scripts/failing-tests.mjs parses and the job log are unchanged.
 */
export function runTestFiles(files, options = {}) {
  // A child `node --test` spawned from inside a test-runner process refuses
  // to run ("recursively ... skipping running files") when it inherits
  // NODE_TEST_CONTEXT. Drop it so the child is always a fresh top-level
  // runner, whether invoked from CI or from a test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const junitPath = options.junitPath ?? null;
  const args = ["--test"];
  if (junitPath) {
    mkdirSync(dirname(resolve(junitPath)), { recursive: true });
    rmSync(junitPath, { force: true });
    args.push(
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=junit", `--test-reporter-destination=${junitPath}`
    );
  }
  args.push(...files);
  // Pipe (not inherit) so failing test names can be parsed out of the
  // reporter stream for the shard receipt; tee both streams to the console
  // so the job log keeps its exact old shape.
  const result = spawnSync(process.execPath, args, {
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout?.toString("utf8") ?? "";
  const stderr = result.stderr?.toString("utf8") ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const status = result.status ?? 1;
  // Failing names are advisory: a red shard must still produce its receipt so
  // the merge gate fails closed on the receipt, and the PR comment step names
  // the failures instead of pointing at the log.
  const failures = status === 0 ? [] : parseFailingTests(stdout);
  const fileDurationsMs = junitPath ? readJunitFileDurations(junitPath) : {};
  return { status, signal: result.signal, failures, fileDurationsMs };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || !argv[0].startsWith("--shard=")) {
    throw new Error("Usage: node scripts/unit-ci.mjs --shard=1/3");
  }
  const shard = parseShard(argv[0].slice("--shard=".length));
  // Fresh checkouts do not contain ignored .tmp/. Initialize before both
  // dependency preflight and test children, matching scripts/test-env.sh.
  const worktreeScratch = resolve(".tmp");
  mkdirSync(worktreeScratch, { recursive: true });
  process.env.TMPDIR = resolve(process.env.TMPDIR || worktreeScratch);
  mkdirSync(process.env.TMPDIR, { recursive: true });
  if (!process.env.XDG_RUNTIME_DIR) process.env.XDG_RUNTIME_DIR = process.env.TMPDIR;
  const preflight = spawnSync(process.execPath, ["scripts/check-deps.mjs"], { stdio: "inherit" });
  if (preflight.error) throw preflight.error;
  if (preflight.status !== 0) process.exit(preflight.status ?? 1);
  const plan = unitPlan();
  const files = plan.shards[shard.index - 1].files;
  if (!files.length) throw new Error("Refusing an empty unit shard");
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "local";
  const receiptPath = `test-results/unit-shard-${shard.index}-of-${shard.total}-attempt-${attempt}.json`;
  mkdirSync(dirname(receiptPath), { recursive: true });
  rmSync(receiptPath, { force: true });
  console.log(`unit-ci: shard ${shard.index}/${shard.total}, ${files.length} test files`);
  const junitPath = `test-results/unit-junit-${shard.index}-of-${shard.total}-attempt-${attempt}.xml`;
  const started = Date.now();
  const { status, signal, failures, fileDurationsMs } = runTestFiles(files, { junitPath });
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        ...shard,
        files,
        planHash: plan.planHash,
        status,
        signal,
        failures,
        // Per-file measured runtimes from this actual hosted run (junit
        // sidecar). Backward compatible: older receipts omit this field
        // and verifyUnitShards does not require it.
        fileDurationsMs,
        revision: process.env.GITHUB_SHA ?? "local",
        runId: process.env.GITHUB_RUN_ID ?? "local",
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
        elapsedMs: Date.now() - started,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`unit-ci: shard ${shard.index}/${shard.total} exit ${status} in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(status);
}

const invokedAsScript =
  process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (invokedAsScript) main();
