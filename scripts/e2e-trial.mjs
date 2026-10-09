#!/usr/bin/env node
/**
 * e2e-trial.mjs — WAVE-500 coord-cost E2E trial driver (worker 17/17).
 *
 * Compares CONTROL (traditional dispatch: 5 sequential spawns, full shared
 * context re-embedded in each brief, free-text reports) against TREATMENT
 * (batch dispatch per docs/BATCH-DISPATCH-SPEC.md: 1 manifest, shared
 * context sent once + content-addressed ref, structured v1 receipts per
 * docs/RECEIPT-SCHEMA.md) on 5 IDENTICAL synthetic tasks.
 *
 * Workers are deterministic node child processes (scripts/e2e-worker.mjs):
 * a subagent cannot spawn real agents, so the measured quantities are
 * coordinator-side bytes and coordinator-side read/parse/fan-in timings,
 * plus the turn STRUCTURE (5 sequential turns vs 1 batch turn) with an
 * explicitly-labeled ASSUMED per-turn handshake latency. See the threats
 * section of docs/E2E-TRIAL.md before citing any wall-clock number.
 *
 * Usage:
 *   node scripts/e2e-trial.mjs --run-dir <dir> [--turn-handshake-ms N]
 *       [--work-ms N] [--json] [--self-test]
 *
 * Writes results.json + results.md into <run-dir>. node stdlib only.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { stdout, stderr, exit } from "node:process";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const WORKER = join(ROOT, "scripts", "e2e-worker.mjs");
const BATCH_DISPATCH = join(ROOT, "scripts", "batch-dispatch.mjs");
const NORMALIZE = join(ROOT, "scripts", "normalize-report.mjs");
const VALIDATE = join(ROOT, "scripts", "validate-receipt.mjs");

const TASK_IDS = ["t1-receipt-audit", "t2-file-fingerprint", "t3-heading-harvest", "t4-size-profile", "t5-claim-id-extraction"];

const BRIEFS = {
  "t1-receipt-audit": `TASK-ID: t1-receipt-audit
Read fixtures/receipts.jsonl (one JSON receipt candidate per line). For each line, decide VALID iff: parses as JSON, v===1, workerId is a non-empty string, status is one of completed|errored|blocked, summary is a string of at most 280 chars, headSha matches /^[0-9a-f]{7,40}$/, filesChanged is an array. Count valid and invalid; for invalid lines record the line number and the first problem seen. Also note whether any line is not JSON at all. doneCondition: a completion report stating counts and listing invalid lines.`,
  "t2-file-fingerprint": `TASK-ID: t2-file-fingerprint
Read every regular file in fixtures/corpus/. Compute SHA256 (first 12 hex chars is enough) for each file. Report: file count, total bytes across the corpus, the longest filename (by characters), and the digest list. doneCondition: a completion report with file count, total bytes, longest filename, and per-file digests.`,
  "t3-heading-harvest": `TASK-ID: t3-heading-harvest
Read every .md file in fixtures/corpus/. Count lines matching ^# (H1) and ^## (H2). Collect the H1 titles (first 60 chars each). Report: files scanned, H1 count, H2 count, and the H1 title list. doneCondition: a completion report with those counts and the H1 list.`,
  "t4-size-profile": `TASK-ID: t4-size-profile
Read every regular file in fixtures/corpus/. Compute: file count, total bytes, total lines, and the longest line length in characters. Report all four numbers. doneCondition: a completion report stating the four numbers.`,
  "t5-claim-id-extraction": `TASK-ID: t5-claim-id-extraction
Read fixtures/comments.txt. Extract all substrings matching \\bwave500-[a-z0-9][a-z0-9-]*(?:-[a-z0-9]+)?\\b. Deduplicate and sort. Report the unique count and the sorted list (first 8). doneCondition: a completion report with the unique count and sorted list.`,
};

const WAVE_GOAL = `WAVE-500 — Coordination Overhead Capstone
Goal: prove that the coordination-cost tooling built by this lane (batch
dispatch, structured receipts, standing claims, context packing) measurably
reduces coordinator overhead versus traditional per-worker dispatch, with a
control group, and write the result up honestly.
Non-goals: production rollout, transport bindings, new spawn APIs.
The coordinator owns: the claim board, the merge slot, the batch manifest,
and the final receipt rollup. Workers own their task and their receipt.
Every worker posts a completion report before it is considered done.`;

const CONVENTIONS = `Conventions (all workers):
- Branch: wave500/coord-cost. Never push to main directly.
- File scope for this trial: scripts/e2e-worker.mjs, scripts/e2e-trial.mjs,
  docs/E2E-TRIAL.md. Do not touch other files.
- Reports: control arm writes free-text DONE blocks; treatment arm writes
  structured v1 receipts (docs/RECEIPT-SCHEMA.md). Keep summaries <= 280 chars.
- No secrets in briefs or receipts. Timeouts are reported, never silent.
- Deterministic: same fixtures, same briefs, same task durations both arms.`;

function buildSharedContext() {
  // Board snapshot: real claims-doc excerpt.
  let board = "";
  try { board = readFileSync(join(ROOT, "docs", "WORK-CLAIMS.md"), "utf8"); } catch { board = "(board snapshot unavailable)\n"; }
  board = board.split("\n").slice(0, 90).join("\n");
  // File map: real listing, truncated.
  let filemap = "";
  try {
    const docs = readdirSync(join(ROOT, "docs")).slice(0, 60);
    const scripts = readdirSync(join(ROOT, "scripts")).slice(0, 60);
    filemap = `docs/ (${readdirSync(join(ROOT, "docs")).length} files): ${docs.join(", ")}\nscripts/ (${readdirSync(join(ROOT, "scripts")).length} files): ${scripts.join(", ")}`;
  } catch { filemap = "(file map unavailable)\n"; }
  const ctx = [
    "# Shared coordination context — WAVE-500 coord-cost E2E trial\n",
    "## Wave goal\n" + WAVE_GOAL + "\n",
    "## Conventions\n" + CONVENTIONS + "\n",
    "## Board snapshot (docs/WORK-CLAIMS.md, head)\n" + board + "\n",
    "## File map\n" + filemap + "\n",
  ].join("\n");
  return ctx;
}

function buildFixtures(runDir) {
  const fx = join(runDir, "fixtures");
  mkdirSync(join(fx, "corpus"), { recursive: true });
  // Corpus: real-ish docs (from this repo's docs) + one generated file.
  const corpusFiles = {
    "README.md": "# E2E trial corpus\n\nSample docs for the synthetic tasks.\n\n## Notes\n\n- deterministic\n- small\n",
    "CLAIMS.md": "# Claims board sample\n\n- wave500-coord-cost-e2e-trial: CLAIM filed\n- wave500-coord-cost-receipt-schema: DONE\n\n## Open\n\n- wave500-coord-cost-batch-spec: review pending\n",
    "SPECS.md": "# Specs\n\n## Batch dispatch\n\nFactor shared context out.\n\n## Receipts\n\nStructured v1 receipts.\n\n### Sub-heading\n\nIgnored by harvest (H3).\n",
  };
  try {
    corpusFiles["WORK-CLAIMS-excerpt.md"] = readFileSync(join(ROOT, "docs", "WORK-CLAIMS.md"), "utf8").split("\n").slice(0, 40).join("\n");
  } catch { corpusFiles["WORK-CLAIMS-excerpt.md"] = "# fallback\n\nno source\n"; }
  corpusFiles["data.txt"] = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  for (const [name, text] of Object.entries(corpusFiles)) writeFileSync(join(fx, "corpus", name), text);
  // receipts.jsonl: 8 lines, 6 valid, 2 invalid (one bad JSON, one schema violation).
  const good = (i, status) => JSON.stringify({ v: 1, workerId: `fx-worker-${i}`, waveId: "wave-500", status, summary: `fixture receipt ${i} completed its task`, filesChanged: ["docs/X.md"], tests: { run: 1, passed: 1, failed: 0 }, claimsFiled: ["wave500-coord-cost-fx"], branch: "wave500/coord-cost", headSha: "a1b2c3d", openQuestions: [], msElapsed: 1000 });
  const lines = [
    good(1, "completed"), good(2, "completed"),
    JSON.stringify({ v: 1, workerId: "fx-bad-1", status: "completed", summary: "missing waveId", filesChanged: [], tests: { run: 0, passed: 0, failed: 0 }, claimsFiled: [], branch: "b", headSha: "abcdef1", openQuestions: [], msElapsed: 5 }),
    good(3, "errored"), good(4, "completed"), good(5, "blocked"),
    "{ not json at all",
    good(6, "completed"),
  ];
  writeFileSync(join(fx, "receipts.jsonl"), lines.join("\n") + "\n");
  // comments.txt: sample room comments with claim ids.
  writeFileSync(join(fx, "comments.txt"), [
    "[CLAIM] wave500-coord-cost-e2e-trial — one-shot worker 17/17",
    "[DONE] wave500-coord-cost-receipt-schema — validator shipped",
    "[PROGRESS] wave500-coord-cost-batch-spec under review",
    "reply: wave500-coord-cost-e2e-trial still running",
    "[DONE] wave500-coord-cost-overhead-model — model merged",
    "wave500-docs-index claims the docs index",
  ].join("\n") + "\n");
}

function sleep(ms) { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } }

/** Spawn one worker asynchronously (treatment fan-out runs them concurrently). */
function spawnWorkerAsync(args, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [WORKER, ...args], { encoding: "utf8" });
    let stdoutBuf = "", stderrBuf = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("worker timeout")); }, timeoutMs);
    child.stdout.on("data", (d) => { stdoutBuf += d; });
    child.stderr.on("data", (d) => { stderrBuf += d; });
    child.on("error", (e) => { clearTimeout(timer); rej(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res({ stdout: stdoutBuf, stderr: stderrBuf });
      else rej(new Error(`worker exited ${code}: ${stderrBuf.slice(0, 200)}`));
    });
  });
}

function spawnWorker(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [WORKER, ...args], { encoding: "utf8", timeout: timeoutMs });
}

function timeMs(fn) { const t0 = Date.now(); const r = fn(); return { r, ms: Date.now() - t0 }; }

function runControl(runDir, opts) {
  const dir = join(runDir, "control");
  mkdirSync(dir, { recursive: true });
  const briefSizes = [];
  const reportSizes = [];
  const parseResults = [];
  let parseMsTotal = 0, emitMsTotal = 0, spawnMsTotal = 0;
  const wallT0 = Date.now();
  const sharedBytes = opts.sharedBytes;
  for (const taskId of TASK_IDS) {
    const turnT0 = Date.now();
    // Coordinator turn: assemble full-context brief (shared re-embedded).
    const { ms: emitMs } = timeMs(() => {
      writeFileSync(join(dir, `${taskId}.brief.txt`), opts.sharedContext + "\n\n--- TASK BRIEF ---\n\n" + BRIEFS[taskId], "utf8");
    });
    emitMsTotal += emitMs;
    briefSizes.push(Buffer.byteLength(readFileSync(join(dir, `${taskId}.brief.txt`), "utf8")));
    // ASSUMED: per-spawn coordinator handshake latency (no real spawn API here).
    sleep(opts.turnHandshakeMs);
    const { r: res, ms: spawnMs } = timeMs(() => spawnWorker([
      "--mode", "control", "--brief", join(dir, `${taskId}.brief.txt`),
      "--fixtures", join(runDir, "fixtures"),
      "--id", `e2e-control-${taskId}`, "--work-ms", String(opts.workMs),
      "--headsha", opts.headSha, "--out", join(dir, `${taskId}.report.txt`),
    ]));
    spawnMsTotal += spawnMs;
    if (res.status !== 0) throw new Error(`control worker ${taskId} failed: ${res.stderr}`);
    reportSizes.push(Buffer.byteLength(readFileSync(join(dir, `${taskId}.report.txt`), "utf8")));
    // Coordinator parses the free-text report into a normalized receipt.
    const { r: norm, ms: parseMs } = timeMs(() =>
      JSON.parse(execFileSync(process.execPath, [NORMALIZE, join(dir, `${taskId}.report.txt`)], { encoding: "utf8" })));
    parseMsTotal += parseMs;
    parseResults.push({ taskId, needsHuman: norm.needsHuman, receiptBytes: norm.receiptBytes });
    void turnT0;
  }
  const wallMs = Date.now() - wallT0;
  return { arm: "control", wallMs, emitMsTotal, spawnMsTotal, parseMsTotal,
    briefBytes: briefSizes.reduce((a, b) => a + b, 0), briefSizes,
    reportBytes: reportSizes.reduce((a, b) => a + b, 0), reportSizes,
    parseResults, workerCount: TASK_IDS.length,
    sharedResentBytes: sharedBytes * TASK_IDS.length };
}

async function runTreatment(runDir, opts) {
  const dir = join(runDir, "treatment");
  mkdirSync(dir, { recursive: true });
  const wallT0 = Date.now();
  // Coordinator builds the batch manifest (validation via batch-dispatch.mjs).
  const manifest = {
    sharedContext: opts.sharedContext,
    workers: TASK_IDS.map((taskId) => ({
      id: `e2e-treatment-${taskId}`,
      brief: BRIEFS[taskId],
      doneCondition: `Completion receipt posted as structured v1 receipt for ${taskId}.`,
    })),
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const { r: envelopeJson, ms: emitMs } = timeMs(() =>
    execFileSync(process.execPath, [BATCH_DISPATCH, "--manifest", manifestPath, "--out", join(dir, "envelope.json")], { encoding: "utf8" }));
  const envelope = JSON.parse(readFileSync(join(dir, "envelope.json"), "utf8"));
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  // Per-worker delta briefs (delta only + contextRef pointer).
  const contextRef = envelope.contextRef;
  writeFileSync(join(dir, "shared.txt"), opts.sharedContext, "utf8");
  for (const taskId of TASK_IDS) {
    writeFileSync(join(dir, `${taskId}.brief.txt`),
      `contextRef: ${contextRef}\n` + BRIEFS[taskId], "utf8");
  }
  const deltaBriefBytes = TASK_IDS.reduce((a, t) =>
    a + Buffer.byteLength(readFileSync(join(dir, `${t}.brief.txt`), "utf8")), 0);
  // ASSUMED: one batch coordinator turn handshake.
  sleep(opts.turnHandshakeMs);
  // Fan out: 5 workers concurrently, sharing one context store (shared.txt).
  // This is the structural difference vs control: one batch turn, parallel work.
  const { r: spawnOutcomes, ms: spawnMs } = await (async () => {
    const t0 = Date.now();
    const outcomes = await Promise.all(TASK_IDS.map((taskId) =>
      spawnWorkerAsync([
        "--mode", "treatment", "--brief", join(dir, `${taskId}.brief.txt`),
        "--shared", join(dir, "shared.txt"),
        "--fixtures", join(runDir, "fixtures"),
        "--id", `e2e-treatment-${taskId}`, "--work-ms", String(opts.workMs),
        "--headsha", opts.headSha, "--out", join(dir, `${taskId}.receipt.json`),
      ]).then(
        () => ({ status: 0, taskId }),
        (e) => ({ status: 1, taskId, err: e.message })
      )));
    return { r: outcomes, ms: Date.now() - t0 };
  })();
  const failed = spawnOutcomes.filter((o) => o.status !== 0);
  if (failed.length) throw new Error(`treatment workers failed: ${failed.map((f) => f.taskId + ": " + f.err).join("; ")}`);
  const receiptSizes = [];
  const validations = [];
  let validateMsTotal = 0;
  const { ms: aggregateMs } = timeMs(() => {
    const batchReceipt = { batchId: envelope.batchId, contextRef, perWorker: [] };
    for (const taskId of TASK_IDS) {
      const p = join(dir, `${taskId}.receipt.json`);
      receiptSizes.push(Buffer.byteLength(readFileSync(p, "utf8")));
      const { r: out, ms: vms } = timeMs(() =>
        execFileSync(process.execPath, [VALIDATE, p], { encoding: "utf8" }));
      validateMsTotal += vms;
      const ok = /VALID/.test(out);
      validations.push({ taskId, valid: ok, detail: out.trim() });
      batchReceipt.perWorker.push({ workerId: `e2e-treatment-${taskId}`, status: ok ? "completed" : "error" });
    }
    writeFileSync(join(dir, "batch-receipt.json"), JSON.stringify(batchReceipt, null, 2), "utf8");
  });
  const wallMs = Date.now() - wallT0;
  void envelopeJson;
  return { arm: "treatment", wallMs, emitMsTotal: emitMs, spawnMsTotal: spawnMs,
    validateMsTotal, aggregateMs,
    briefBytes: envelopeBytes, deltaBriefBytes,
    reportBytes: receiptSizes.reduce((a, b) => a + b, 0), receiptSizes,
    validations, workerCount: TASK_IDS.length,
    sharedSentBytes: opts.sharedBytes, batchId: envelope.batchId };
}

function selfTest(runDir) {
  buildFixtures(runDir);
  const shared = buildSharedContext();
  const headSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || "0000000";
  const dir = join(runDir, "selftest");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shared.txt"), shared, "utf8");
  // Control worker smoke.
  const brief = "TASK-ID: t4-size-profile\n" + BRIEFS["t4-size-profile"];
  writeFileSync(join(dir, "brief.txt"), shared + "\n\n" + brief, "utf8");
  const r1 = spawnWorker(["--mode", "control", "--brief", join(dir, "brief.txt"), "--fixtures", join(runDir, "fixtures"), "--headsha", headSha, "--out", join(dir, "report.txt")]);
  if (r1.status !== 0) throw new Error(`control smoke failed: ${r1.stderr}`);
  const norm = JSON.parse(execFileSync(process.execPath, [NORMALIZE, join(dir, "report.txt")], { encoding: "utf8" }));
  // normalize-report maps done-class statuses to the v1 receipt vocabulary
  // (completed|errored|blocked); accept either spelling of "finished".
  if (!["completed", "done"].includes(norm.receipt.status)) throw new Error(`control smoke: unexpected status ${norm.receipt.status}`);
  // Treatment worker smoke + validation.
  const r2 = spawnWorker(["--mode", "treatment", "--brief", join(dir, "brief.txt"), "--shared", join(dir, "shared.txt"), "--fixtures", join(runDir, "fixtures"), "--headsha", headSha, "--out", join(dir, "receipt.json")]);
  if (r2.status !== 0) throw new Error(`treatment smoke failed: ${r2.stderr}`);
  const v = execFileSync(process.execPath, [VALIDATE, join(dir, "receipt.json")], { encoding: "utf8" });
  if (!/VALID/.test(v)) throw new Error(`treatment smoke: receipt invalid: ${v}`);
  // Manifest validation smoke.
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ sharedContext: shared, workers: [{ id: "smoke", brief: "x", doneCondition: "y" }] }), "utf8");
  execFileSync(process.execPath, [BATCH_DISPATCH, "--manifest", manifestPath, "--out", join(dir, "envelope.json")], { encoding: "utf8" });
  stdout.write("self-test OK\n");
}

async function main(argv) {
  const get = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const runDir = resolve(get("run-dir", join("/tmp", "e2e-trial")));
  const turnHandshakeMs = Number(get("turn-handshake-ms", "2000"));
  const workMs = Number(get("work-ms", "400"));
  const json = argv.includes("--json");
  if (argv.includes("--self-test")) { mkdirSync(runDir, { recursive: true }); selfTest(runDir); return 0; }
  mkdirSync(runDir, { recursive: true });
  buildFixtures(runDir);
  const sharedContext = buildSharedContext();
  const sharedBytes = Buffer.byteLength(sharedContext, "utf8");
  writeFileSync(join(runDir, "shared-context.txt"), sharedContext, "utf8");
  let headSha = "0000000";
  try { headSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || headSha; } catch { /* keep */ }

  const opts = { sharedContext, sharedBytes, turnHandshakeMs, workMs, headSha };
  const control = runControl(runDir, opts);
  const treatment = await runTreatment(runDir, opts);

  const results = {
    generatedAt: new Date().toISOString(),
    branch: "wave500/coord-cost",
    headSha,
    params: { workersPerArm: 5, turnHandshakeMs_ASSUMED: turnHandshakeMs, workMsPerWorker: workMs,
      sharedContextBytes: sharedBytes, tokenEstimate: "ceil(chars/4)" },
    control: {
      wallMs: control.wallMs, emitMsTotal: control.emitMsTotal, spawnMsTotal: control.spawnMsTotal,
      parseMsTotal: control.parseMsTotal,
      briefBytes: control.briefBytes, briefSizes: control.briefSizes,
      reportBytes: control.reportBytes, reportSizes: control.reportSizes,
      sharedResentBytes: control.sharedResentBytes,
      parseNeedsHumanTotal: control.parseResults.reduce((a, r) => a + r.needsHuman.length, 0),
      parseResults: control.parseResults,
    },
    treatment: {
      wallMs: treatment.wallMs, emitMsTotal: treatment.emitMsTotal, spawnMsTotal: treatment.spawnMsTotal,
      validateMsTotal: treatment.validateMsTotal, aggregateMs: treatment.aggregateMs,
      envelopeBytes: treatment.briefBytes, deltaBriefBytes: treatment.deltaBriefBytes,
      sharedSentBytes: treatment.sharedSentBytes, batchId: treatment.batchId,
      reportBytes: treatment.reportBytes, receiptSizes: treatment.receiptSizes,
      receiptsValid: treatment.validations.filter((v) => v.valid).length,
      validations: treatment.validations,
    },
    delta: {
      briefBytesSaved: control.briefBytes - treatment.briefBytes,
      briefBytesSavedPct: 1 - treatment.briefBytes / control.briefBytes,
      reportBytesSaved: control.reportBytes - treatment.reportBytes,
      reportBytesSavedPct: 1 - treatment.reportBytes / control.reportBytes,
      wallMsSaved: control.wallMs - treatment.wallMs,
      wallMsSavedPct: 1 - treatment.wallMs / control.wallMs,
      fanInMsControl: control.parseMsTotal,
      // aggregateMs already includes the per-receipt validate execs; report
      // it alone (adding validateMsTotal again would double-count).
      fanInMsTreatment: treatment.aggregateMs,
    },
  };
  writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2), "utf8");
  if (json) stdout.write(JSON.stringify(results, null, 2) + "\n");
  else stdout.write(`results written to ${runDir}/results.json\n`);
  return 0;
}

try { exit(await main(process.argv.slice(2))); }
catch (e) { stderr.write(`trial error: ${e.message}\n${e.stack || ""}\n`); exit(1); }
