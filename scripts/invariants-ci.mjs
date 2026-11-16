// Invariant harness CI gate.
//
// Runs `node --test tests/invariants/**/*.test.mjs`, emits one JSONL results
// file per the INVARIANTS telemetry contract (A14: docs/INVARIANTS-TELEMETRY.md
// — run_start / invariant_result / run_end lines), renders a markdown table
// for the PR comment, and exits 1 when any invariant fails or errors.
//
// Contract resolution order (same as docs/INVARIANTS-TELEMETRY.md):
//   results file: $INVARIANTS_RESULTS_FILE, else results/invariants.jsonl
//   raw TAP file: $INVARIANTS_TAP_FILE, else the results path with .tap
//   repo SHA:     $INVARIANTS_SHA > `git rev-parse HEAD` > "unknown"
//
// Failure evidence is part of the contract: every failure form Node emits
// (assertion block scalars, plain-Error single-line scalars, file-level load
// deaths) must land in the results file WITH its error text, and the raw TAP
// stream is written next to the results file so any specimen can be re-read
// without the parser's losses (#4262).
//
// Zero dependencies beyond node stdlib. TAP parsing is deliberately strict:
// anything we cannot attribute to a named test fails the run closed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

// fileURLToPath (not new URL(...).pathname, which stays percent-encoded) so
// paths containing spaces or other URL-escaped characters decode correctly.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_FILE =
  process.env.INVARIANTS_RESULTS_FILE || resolve(REPO_ROOT, "results/invariants.jsonl");
const TAP_FILE =
  process.env.INVARIANTS_TAP_FILE || RESULTS_FILE.replace(/\.jsonl$/, "") + ".tap";
const MARKER = "<!-- invariants-ci -->";

// ---------------------------------------------------------------------------
// Pure helpers (imported by tests/invariants-ci-parser.test.js).
// ---------------------------------------------------------------------------

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unnamed";
}

export function invariantName(raw) {
  const m = /^invariant\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*:/.exec(String(raw).trim());
  return m ? m[1] : slugify(raw);
}

export function isFileLevelTest(name) {
  const n = String(name).trim();
  // Per-file aggregates ("/path/file.test.mjs") and the synthetic
  // "test at <path>:line:col" failure attribution lines.
  return /\.test\.(mjs|js)(:\d+:\d+)?\s*$/.test(n) || /^test at \S+\.test\.(mjs|js)/.test(n);
}

const TAP_LINE = /^(\s*)(ok|not ok)\s+(\d+)\s+-\s+(.*?)\s*$/;

// YAML scalars in TAP detail blocks arrive single-quoted ('...', with '' as
// an escaped quote), double-quoted, or bare. Return the plain value.
function unquoteYamlScalar(raw) {
  const s = String(raw).trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

// From the TAP `#` diagnostic lines preceding a file-level failure, extract
// the load error's headline: the `# Error: ...` line when present (that is
// where a module-load death prints its real message), else the first
// substantive diagnostic line. `# Subtest:` headers and the trailing summary
// counts are structural, not diagnostics.
function diagnosticHeadline(diagnostics) {
  const substantive = diagnostics.filter(
    l => !/^#\s*(Subtest:|tests\s+\d|suites\s+\d|pass\s+\d|fail\s+\d|cancelled\s+\d|skipped\s+\d|todo\s+\d|duration_ms\s)/.test(l),
  );
  const errLine = substantive.find(l => /^#\s*\S*Error[:\s]/.test(l));
  return (errLine || substantive[0] || "").replace(/^#\s*/, "").trim().slice(0, 200);
}

function diagnosticStackFrame(diagnostics) {
  const frame = diagnostics.find(l => /^#\s+at\s+/.test(l));
  return frame ? frame.replace(/^#\s*/, "").trim().slice(0, 200) : "";
}

// Parse TAP from `node --test --test-reporter=tap` into invariant_result records.
// Records every named test (top-level harness self-tests and nested invariant
// scenarios alike). Per-file aggregate lines are skipped when they pass; a
// FAILED file-level line becomes a named `file:<basename>` error record
// carrying its YAML fields and the preceding `#` diagnostics — but only
// when the file reported no named tests of its own: a file whose tests
// merely failed also aggregates `not ok`, and those failures already have
// their own records. A load death is the zero-named-records case (#4262).
// Returns { records: [...], bailOut: string|null }.
export function parseTap(tapText) {
  const lines = String(tapText).split("\n");
  const records = [];
  let bailOut = null;
  let diagnostics = [];
  // The file whose `# Subtest: <file>` block is currently open, and how
  // many named records it has produced. Node always announces a file with
  // that header before its aggregate line; without a header there is no
  // attribution and the aggregate keeps the legacy skip behaviour.
  let fileContext = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*Bail out!/.test(line)) {
      bailOut = line.trim().slice(0, 200);
      i++;
      continue;
    }
    if (/^#/.test(line)) {
      diagnostics.push(line);
      const sub = /^#\s*Subtest:\s*(.+?)\s*$/.exec(line);
      if (sub && isFileLevelTest(sub[1])) fileContext = { name: sub[1], named: 0 };
      i++;
      continue;
    }
    const m = TAP_LINE.exec(line);
    if (!m) { i++; continue; }
    const verdict = m[2];
    const name = m[4];
    const fileLevel = isFileLevelTest(name);
    // Consume the YAML-ish detail block that follows the test line.
    const detail = {
      duration_ms: 0, failureType: "", errorLines: [], errorCode: "",
      stackFirst: "", exitCode: null, signal: "",
    };
    let j = i + 1;
    let inBlock = false;
    let keyIndent = null;
    let blockKey = null; // "error" | "stack" while inside a |- scalar
    while (j < lines.length) {
      const dl = lines[j];
      if (/^\s*---\s*$/.test(dl)) { inBlock = true; j++; continue; }
      if (!inBlock) break;
      if (/^\s*\.\.\.\s*$/.test(dl)) break;
      if (TAP_LINE.test(dl) || /^#/.test(dl)) break;
      if (dl.trim() === "") {
        // Blank lines occur inside block scalars (assertion messages);
        // keep them as separators while capturing, ignore them otherwise.
        if (blockKey === "error") detail.errorLines.push("");
        j++;
        continue;
      }
      const indent = /^(\s*)/.exec(dl)[1].length;
      if (keyIndent === null) keyIndent = indent;
      if (indent > keyIndent) {
        // Block-scalar content (indented past its key).
        if (blockKey === "error") detail.errorLines.push(dl.trim());
        else if (blockKey === "stack" && !detail.stackFirst) detail.stackFirst = dl.trim().slice(0, 200);
        j++;
        continue;
      }
      if (indent < keyIndent) break;
      const km = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(dl.trim());
      if (!km) break;
      blockKey = null;
      const key = km[1], rest = km[2].trim();
      if (key === "duration_ms") {
        const dm = /([0-9.]+)/.exec(rest);
        if (dm) detail.duration_ms = Math.max(0, Math.round(Number(dm[1])));
      } else if (key === "failureType") {
        detail.failureType = unquoteYamlScalar(rest);
      } else if (key === "error") {
        if (/^\|[-+]?\s*$/.test(rest)) blockKey = "error";
        else if (rest) detail.errorLines.push(unquoteYamlScalar(rest));
      } else if (key === "code") {
        detail.errorCode = unquoteYamlScalar(rest);
      } else if (key === "stack") {
        if (/^\|[-+]?\s*$/.test(rest)) blockKey = "stack";
        else if (rest) detail.stackFirst = unquoteYamlScalar(rest).slice(0, 200);
      } else if (key === "exitCode") {
        const n = Number(rest);
        if (Number.isFinite(n)) detail.exitCode = n;
      } else if (key === "signal") {
        if (rest && rest !== "~") detail.signal = unquoteYamlScalar(rest);
      }
      j++;
    }
    i = j > i + 1 && inBlock ? j : i + 1;

    if (fileLevel) {
      const isAggregate = !/^test at /.test(name.trim());
      const loadDeath =
        isAggregate && verdict === "not ok" &&
        fileContext && fileContext.name === name && fileContext.named === 0;
      if (!loadDeath) { diagnostics = []; fileContext = null; continue; }
    }
    const errorText = detail.errorLines.map(s => s.trim()).filter(Boolean).join(" / ").slice(0, 300);
    if (fileLevel) {
      // The file died before reporting any test (module-load failure). Its
      // YAML error is the generic 'test failed'; the real message is in the
      // `#` diagnostics printed before the file's result line.
      const headline = diagnosticHeadline(diagnostics);
      const parts = [
        detail.failureType || "testCodeFailure",
        detail.exitCode !== null ? `exit ${detail.exitCode}` : "",
        detail.signal ? `signal ${detail.signal}` : "",
        headline || (errorText && errorText !== "test failed" ? errorText : ""),
      ].filter(Boolean);
      const rec = {
        name: `file:${basename(name.replace(/:\d+:\d+\s*$/, ""))}`,
        status: "error",
        duration_ms: detail.duration_ms,
        started_at: "",
        finished_at: "",
        message: parts.join(" — ").slice(0, 400),
      };
      if (detail.errorCode) rec.error_code = detail.errorCode;
      if (detail.exitCode !== null) rec.exit_code = detail.exitCode;
      const frame = diagnosticStackFrame(diagnostics);
      if (frame) rec.stack = frame;
      records.push(rec);
      diagnostics = [];
      fileContext = null;
      continue;
    }
    const rec = {
      name: invariantName(name),
      status: verdict === "ok" ? "pass" : "fail",
      duration_ms: detail.duration_ms,
      started_at: "",
      finished_at: "",
      message: "",
    };
    if (/#\s*SKIP\b/i.test(name)) rec.status = "skip";
    if (rec.status === "fail") {
      rec.message = [detail.failureType, errorText].filter(Boolean).join(" — ").slice(0, 400);
      if (detail.errorCode) rec.error_code = detail.errorCode;
      if (detail.stackFirst) rec.stack = detail.stackFirst;
      if (detail.exitCode !== null) rec.exit_code = detail.exitCode;
    }
    records.push(rec);
    if (fileContext) fileContext.named++;
    diagnostics = [];
  }
  return { records, bailOut };
}

export function resolveSha() {
  if (process.env.INVARIANTS_SHA) return process.env.INVARIANTS_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function buildRunStart({ runId, sha, harness = "node-invariants", harnessVersion = "0" }) {
  return {
    type: "run_start",
    run_id: runId,
    repo_sha: sha,
    harness,
    harness_version: harnessVersion,
    started_at: new Date().toISOString(),
  };
}

export function buildRunEnd({ runId, sha, startedAt, records, bailOut }) {
  const counts = { pass: 0, fail: 0, skip: 0, error: 0 };
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const failCount = counts.fail + counts.error;
  const now = new Date();
  const finished = now.toISOString();
  return {
    type: "run_end",
    run_id: runId,
    repo_sha: sha,
    finished_at: finished,
    duration_ms: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
    counts,
    status: failCount > 0 || bailOut ? "fail" : "pass",
    ...(bailOut ? { message: bailOut } : {}),
  };
}

export function renderMarkdown({ runId, sha, startedAt, records, runEnd, runCount = 1 }) {
  const statusIcon = s => (s === "pass" ? "✅" : s === "skip" ? "⏭️" : "❌");
  const head =
    `${MARKER}\n` +
    `## Invariant harness — ${runEnd.status === "pass" ? "PASS" : "FAIL"}\n\n` +
    `run \`${runId}\` · sha \`${String(sha).slice(0, 12)}\` · ` +
    `${records.length} invariant${records.length === 1 ? "" : "s"} ` +
    `(${runEnd.counts.pass} pass / ${runEnd.counts.fail} fail / ${runEnd.counts.skip} skip / ${runEnd.counts.error} error) ` +
    `in ${(runEnd.duration_ms / 1000).toFixed(1)}s` +
    (runCount > 1 ? ` · run ${runCount} of ${runCount} in file (latest shown)` : "") +
    `\n\n` +
    `| invariant | status | duration | message |\n` +
    `|---|---|---|---|\n`;
  const rows = records
    .map(r => {
      const msg = String(r.message || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
      return `| \`${r.name}\` | ${statusIcon(r.status)} ${r.status} | ${r.duration_ms}ms | ${msg} |`;
    })
    .join("\n");
  return head + rows + "\n";
}

// Fail closed: if the test runner itself exited nonzero but every parsed
// record passed (e.g. a top-level harness self-test failed), add an error
// record so the gate reflects the real outcome.
export function applyRunnerExitGuard(records, procStatus, wallMs, startedAtIso) {
  if (procStatus !== 0 && !records.some(r => r.status === "fail" || r.status === "error")) {
    records.push({
      name: "harness-runner",
      status: "error",
      duration_ms: wallMs,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      message: `node --test exited ${procStatus}`,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Gate entrypoint.
// ---------------------------------------------------------------------------

function runGate() {
  const reportOut = process.argv.includes("--report-out")
    ? process.argv[process.argv.indexOf("--report-out") + 1]
    : null;

  const sha = resolveSha();
  const runId = `inv_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const startedAtIso = new Date().toISOString();

  mkdirSync(dirname(RESULTS_FILE), { recursive: true });
  // Synchronous appends: the file is readable mid-run (per the telemetry
  // contract) and no async flush can be cut off by process.exit below.
  const emit = obj => appendFileSync(RESULTS_FILE, JSON.stringify(obj) + "\n");

  emit(buildRunStart({ runId, sha, startedAt: startedAtIso }));

  // Warm-up (#4264): materialize the acceptance fixture's generated module
  // once, serially, before the suite spawns its file processes in parallel.
  // Combined with the fixture's atomic publish, no test process can import
  // a torn module on a cold checkout. Best-effort: a genuinely broken
  // fixture fails the suite itself, with evidence.
  const fixtureModule = resolve(REPO_ROOT, "scripts/acceptance-fixture.mjs");
  if (existsSync(fixtureModule)) {
    try {
      spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(fixtureModule).href)})`],
        { cwd: REPO_ROOT, stdio: "ignore", timeout: 30000 },
      );
    } catch { /* the suite run below is the witness */ }
  }

  const started = Date.now();
  const proc = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "tests/invariants/**/*.test.mjs"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const tap = (proc.stdout || "") + (proc.stderr || "");
  const wallMs = Date.now() - started;

  // Preserve the raw TAP stream next to the results file (#4262): the
  // parser is lossy by design, and a specimen must be re-readable without
  // it. A TAP write failure is reported but does not flip the gate.
  try {
    writeFileSync(TAP_FILE, tap);
  } catch (err) {
    console.error(`invariants: warning — could not write raw TAP to ${TAP_FILE}: ${err.message}`);
  }

  const { records, bailOut } = parseTap(tap);
  applyRunnerExitGuard(records, proc.status, wallMs, startedAtIso);
  const now = new Date().toISOString();
  for (const r of records) {
    r.started_at = r.started_at || startedAtIso;
    r.finished_at = r.finished_at || now;
    emit({ type: "invariant_result", run_id: runId, repo_sha: sha, ...r });
  }
  // A TAP stream we cannot parse at all is a gate failure, not a pass.
  const runEnd = records.length === 0
    ? buildRunEnd({ runId, sha, startedAt: startedAtIso, records: [{ status: "error", message: "no test records parsed from TAP", duration_ms: wallMs }], bailOut: bailOut || "unparsable TAP output" })
    : buildRunEnd({ runId, sha, startedAt: startedAtIso, records, bailOut });
  emit(runEnd);

  // Render the PR-comment table. Prefer A14's renderer (scripts/invariants-report.mjs)
  // when it exists; otherwise use the built-in table so the comment still lands.
  let markdown;
  try {
    const renderer = resolve(REPO_ROOT, "scripts/invariants-report.mjs");
    const check = spawnSync(process.execPath, ["--check", renderer], { stdio: "ignore" });
    if (check.status === 0) {
      const r = spawnSync(
        process.execPath,
        [renderer, RESULTS_FILE],
        { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, INVARIANTS_RESULTS_FILE: RESULTS_FILE } },
      );
      if (r.status === 0 && r.stdout.trim()) markdown = MARKER + "\n" + r.stdout;
    }
  } catch { /* fall through to built-in table */ }
  if (!markdown) {
    markdown = renderMarkdown({ runId, sha, startedAt: startedAtIso, records, runEnd });
  }
  if (reportOut) writeFileSync(reportOut, markdown);

  const fails = runEnd.counts.fail + runEnd.counts.error;
  console.log(
    `invariants: ${runEnd.status.toUpperCase()} — ` +
    `${runEnd.counts.pass} pass / ${fails} fail / ${runEnd.counts.skip} skip ` +
    `(${(runEnd.duration_ms / 1000).toFixed(1)}s) → ${RESULTS_FILE}`,
  );
  process.exit(runEnd.status === "pass" ? 0 : 1);
}

// Compare real filesystem paths on both sides: fileURLToPath decodes the
// percent-encoded module URL, so a checkout path containing spaces (or other
// escaped characters) still matches argv[1] and the gate actually runs.
export function isMainModule(argv1, moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    const invoked = resolve(argv1), loaded = fileURLToPath(moduleUrl);
    return invoked === loaded || realpathSync(invoked) === realpathSync(loaded);
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1])) runGate();
