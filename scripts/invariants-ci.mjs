// Invariant harness CI gate.
//
// Runs `node --test tests/invariants/**/*.test.mjs`, emits one JSONL results
// file per the INVARIANTS telemetry contract (A14: docs/INVARIANTS-TELEMETRY.md
// — run_start / invariant_result / run_end lines), renders a markdown table
// for the PR comment, and exits 1 when any invariant fails or errors.
//
// Contract resolution order (same as docs/INVARIANTS-TELEMETRY.md):
//   results file: $INVARIANTS_RESULTS_FILE, else results/invariants.jsonl
//   repo SHA:     $INVARIANTS_SHA > `git rev-parse HEAD` > "unknown"
//
// Zero dependencies beyond node stdlib. TAP parsing is deliberately strict:
// anything we cannot attribute to a named test fails the run closed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const RESULTS_FILE =
  process.env.INVARIANTS_RESULTS_FILE || resolve(REPO_ROOT, "results/invariants.jsonl");
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
  // Per-file aggregates ("ok 1 - /path/file.test.mjs") and the synthetic
  // "test at <path>:line:col" failure attribution lines.
  return /\.test\.(mjs|js)(:\d+:\d+)?\s*$/.test(n) || /^test at \S+\.test\.(mjs|js)/.test(n);
}

const TAP_LINE = /^(\s*)(ok|not ok)\s+(\d+)\s+-\s+(.*?)\s*$/;

// Parse TAP from `node --test --test-reporter=tap` into invariant_result records.
// Records every named test (top-level harness self-tests and nested invariant
// scenarios alike); per-file aggregate lines are skipped. Returns
// { records: [...], bailOut: string|null }.
export function parseTap(tapText) {
  const lines = String(tapText).split("\n");
  const records = [];
  let bailOut = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*Bail out!/.test(line)) {
      bailOut = line.trim().slice(0, 200);
      i++;
      continue;
    }
    const m = TAP_LINE.exec(line);
    if (!m || isFileLevelTest(m[4])) { i++; continue; }
    const verdict = m[2];
    const name = m[4];
    const rec = {
      name: invariantName(name),
      status: verdict === "ok" ? "pass" : "fail",
      duration_ms: 0,
      started_at: "",
      finished_at: "",
      message: "",
    };
    if (/#\s*SKIP\b/i.test(name)) rec.status = "skip";
    // Consume the YAML-ish detail block that follows an indented test line.
    let j = i + 1;
    let inBlock = false;
    let errorCapture = false;
    while (j < lines.length) {
      const dl = lines[j];
      if (/^\s*---\s*$/.test(dl)) { inBlock = true; j++; continue; }
      if (!inBlock) break;
      if (/^\s*\.\.\.\s*$/.test(dl)) break;
      if (!/^\s{2,}\S/.test(dl) && !/^\s*$/.test(dl)) break;
      const dm = /duration_ms:\s*([0-9.]+)/.exec(dl);
      if (dm) rec.duration_ms = Math.max(0, Math.round(Number(dm[1])));
      const ft = /failureType:\s*'([^']+)'/.exec(dl);
      if (ft) rec.message = ft[1].slice(0, 160);
      if (/^\s*error:\s*\|-\s*$/.test(dl)) { errorCapture = true; j++; continue; }
      if (errorCapture) {
        const t = dl.trim();
        if (t) {
          rec.message = (rec.message ? rec.message + " — " : "") + t.slice(0, 160);
          errorCapture = false;
        }
        j++;
        continue;
      }
      j++;
    }
    records.push(rec);
    i++;
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

  const started = Date.now();
  const proc = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "tests/invariants/**/*.test.mjs"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const tap = (proc.stdout || "") + (proc.stderr || "");
  const wallMs = Date.now() - started;

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

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) runGate();
