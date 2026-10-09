#!/usr/bin/env node
/**
 * e2e-worker.mjs — WAVE-500 coord-cost E2E trial worker (17/17, synthetic).
 *
 * Emulates one wave worker: reads its brief (+ optional shared context),
 * performs its assigned synthetic task deterministically over the fixture
 * corpus, and emits either a free-text completion report (control arm) or a
 * structured v1 receipt (treatment arm, per docs/RECEIPT-SCHEMA.md).
 *
 * Usage:
 *   node scripts/e2e-worker.mjs --mode control|treatment --brief <path>
 *       [--shared <path>] [--out <path>] [--id <workerId>]
 *       [--work-ms <ms>] [--fixtures <dir>]
 *
 * node stdlib only. Exit 0 on completion; exit 2 on usage/brief errors.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { stdin, stdout, stderr, exit } from "node:process";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes(`--${name}`); }

const TASKS = {
  "t1-receipt-audit": {
    title: "Audit fixture receipts for v1 schema validity",
    run(fx) {
      const lines = readFileSync(join(fx, "receipts.jsonl"), "utf8").trim().split("\n");
      let valid = 0, invalid = 0;
      const problems = [];
      for (const [i, ln] of lines.entries()) {
        try {
          const r = JSON.parse(ln);
          const ok = r.v === 1 && typeof r.workerId === "string" &&
            ["completed", "errored", "blocked"].includes(r.status) &&
            typeof r.summary === "string" && r.summary.length <= 280 &&
            /^[0-9a-f]{7,40}$/.test(r.headSha || "") && Array.isArray(r.filesChanged);
          if (ok) valid++; else { invalid++; problems.push(`line${i + 1}: missing/invalid required fields`); }
        } catch { invalid++; problems.push(`line${i + 1}: not JSON`); }
      }
      return { facts: { checked: lines.length, valid, invalid },
        summary: `Audited ${lines.length} fixture receipts: ${valid} valid, ${invalid} invalid.`,
        openQuestions: invalid ? [`${invalid} fixture receipts fail the v1 schema check (see receipts.jsonl)`] : [] };
    },
  },
  "t2-file-fingerprint": {
    title: "Fingerprint fixture corpus (SHA256) and size profile",
    run(fx) {
      const files = readdirSync(join(fx, "corpus")).sort();
      let total = 0, longest = "";
      const digests = [];
      for (const f of files) {
        const p = join(fx, "corpus", f);
        if (!statSync(p).isFile()) continue;
        const buf = readFileSync(p);
        total += buf.length;
        if (f.length > longest.length) longest = f;
        digests.push(createHash("sha256").update(buf).digest("hex").slice(0, 12));
      }
      return { facts: { files: files.length, totalBytes: total, longestName: longest },
        summary: `Fingerprinted ${files.length} corpus files (${total} bytes total); longest name "${longest}".`,
        openQuestions: [] };
    },
  },
  "t3-heading-harvest": {
    title: "Harvest markdown headings from sample docs",
    run(fx) {
      const files = readdirSync(join(fx, "corpus")).filter((f) => f.endsWith(".md")).sort();
      let h1 = 0, h2 = 0;
      const titles = [];
      for (const f of files) {
        for (const line of readFileSync(join(fx, "corpus", f), "utf8").split("\n")) {
          const m = line.match(/^(#{1,2})\s+(.+)$/);
          if (m) { if (m[1] === "#") { h1++; titles.push(m[2].slice(0, 60)); } else h2++; }
        }
      }
      return { facts: { files: files.length, h1, h2 },
        summary: `Harvested ${h1} H1 and ${h2} H2 headings across ${files.length} docs.`,
        openQuestions: [] };
    },
  },
  "t4-size-profile": {
    title: "Compute size profile of fixture corpus",
    run(fx) {
      const files = readdirSync(join(fx, "corpus")).sort();
      let total = 0, lines = 0, longestLine = 0;
      for (const f of files) {
        const p = join(fx, "corpus", f);
        if (!statSync(p).isFile()) continue;
        const text = readFileSync(p, "utf8");
        total += text.length;
        const ls = text.split("\n");
        lines += ls.length;
        for (const l of ls) if (l.length > longestLine) longestLine = l.length;
      }
      return { facts: { files: files.length, totalBytes: total, lines, longestLine },
        summary: `Corpus: ${files.length} files, ${total} bytes, ${lines} lines, longest line ${longestLine} chars.`,
        openQuestions: [] };
    },
  },
  "t5-claim-id-extraction": {
    title: "Extract wave500 claim ids from sample room comments",
    run(fx) {
      const text = readFileSync(join(fx, "comments.txt"), "utf8");
      const ids = new Set();
      for (const m of text.matchAll(/\bwave500-[a-z0-9][a-z0-9-]*(?:-[a-z0-9]+)?\b/g)) ids.add(m[0]);
      const list = [...ids].sort();
      return { facts: { found: list.length, ids: list.slice(0, 8) },
        summary: `Extracted ${list.length} unique wave500 claim ids from sample comments.`,
        openQuestions: [] };
    },
  },
};

function freeTextReport({ id, taskId, title, sharedBytes, result, msElapsed, headSha }) {
  const f = result.facts;
  const factsLine = Object.entries(f).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length + " items" : v}`).join(", ");
  const tests = "tests: run=1, passed=1, failed=0";
  const lines = [
    `[DONE] ${taskId} — ${title}`,
    "",
    `workerId: ${id}`,
    "waveId: wave-500",
    "status: done",
    "",
    `Finished ${title.toLowerCase()}. ${result.summary}`,
    "",
    `Task facts: ${factsLine}.`,
    `${tests}. Elapsed: ${(msElapsed / 1000).toFixed(1)}s.`,
    "",
    "Files:",
    "  - docs/E2E-TRIAL.md (trial fixture references only)",
    "",
    `Branch: wave500/coord-cost. Commit: ${headSha}.`,
    "",
    "Claim id: wave500-coord-cost-e2e-trial",
    "",
    result.openQuestions.length
      ? `Open questions:\n${result.openQuestions.map((q) => `  - ${q}`).join("\n")}`
      : "Open questions: none — all sub-steps completed as specified in the brief.",
    "",
    `Context used: full shared context (${sharedBytes} bytes) re-read with this brief, per the traditional dispatch pattern.`,
  ];
  return lines.join("\n") + "\n";
}

function structuredReceipt({ id, taskId, result, msElapsed, headSha, modeTag }) {
  const receipt = {
    v: 1,
    workerId: id,
    waveId: "wave-500",
    status: "completed",
    summary: `${result.summary} (arm=${modeTag}, task=${taskId})`.slice(0, 280),
    filesChanged: ["docs/E2E-TRIAL.md"],
    tests: { run: 1, passed: 1, failed: 0 },
    claimsFiled: ["wave500-coord-cost-e2e-trial"],
    branch: "wave500/coord-cost",
    headSha,
    openQuestions: result.openQuestions.slice(0, 3),
    msElapsed,
    ts: new Date().toISOString(),
  };
  return JSON.stringify(receipt);
}

function main(argv) {
  if (has("-h") || has("--help")) {
    stdout.write("usage: e2e-worker.mjs --mode control|treatment --brief <path> [--shared <path>] [--out <path>] [--id <workerId>] [--work-ms <ms>] [--fixtures <dir>]\n");
    return 0;
  }
  const mode = arg("mode");
  const briefPath = arg("brief");
  if (!["control", "treatment"].includes(mode) || !briefPath) {
    stderr.write("usage: e2e-worker.mjs --mode control|treatment --brief <path> [...]\n");
    return 2;
  }
  let brief;
  try { brief = readFileSync(briefPath, "utf8"); }
  catch (e) { stderr.write(`cannot read brief: ${e.message}\n`); return 2; }
  const m = brief.match(/^TASK-ID:\s*(\S+)/m);
  const taskId = m ? m[1] : "t1-receipt-audit";
  const task = TASKS[taskId];
  if (!task) { stderr.write(`unknown task ${taskId}\n`); return 2; }

  // The worker reads the brief. Control reads the full (shared+brief) payload;
  // treatment reads the delta brief + resolves shared context via contextRef.
  const sharedPath = arg("shared");
  const sharedText = sharedPath ? readFileSync(sharedPath, "utf8") : "";
  const briefReadBytes = mode === "control"
    ? Buffer.byteLength(brief, "utf8")
    : Buffer.byteLength(brief, "utf8") + Buffer.byteLength(sharedText, "utf8");

  const fixtures = arg("fixtures", "/tmp/e2e-trial/fixtures");
  const workMs = Number(arg("work-ms", "400"));
  const id = arg("id", `e2e-${mode}-${taskId}`);
  const headSha = (arg("headsha") || "0000000").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 40) || "0000000";

  const t0 = Date.now();
  const result = task.run(fixtures);
  // Deterministic emulated task duration (identical across arms): busy spin
  // so the worker wall-clock is real and measurable.
  const spinUntil = t0 + workMs;
  let acc = 0;
  while (Date.now() < spinUntil) acc += Math.sqrt(acc + 1);
  if (acc === -1) stderr.write("unreachable\n");
  const msElapsed = Date.now() - t0;

  const out = mode === "control"
    ? freeTextReport({ id, taskId, title: task.title, sharedBytes: briefReadBytes, result, msElapsed, headSha })
    : structuredReceipt({ id, taskId, result, msElapsed, headSha, modeTag: mode });

  const outPath = arg("out");
  if (outPath) writeFileSync(outPath, out, "utf8");
  else stdout.write(out + (mode === "control" ? "" : "\n"));
  return 0;
}

try { exit(main(process.argv.slice(2))); }
catch (e) { stderr.write(`worker error: ${e.message}\n`); exit(1); }
