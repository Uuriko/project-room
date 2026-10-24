#!/usr/bin/env node
// QA regression-spine runner.
//
// Executes every manifest row's probe against a target tree and emits the
// classification table. Usage:
//   node tests/regression-spine/run.mjs [--root <tree>] [--out <dir>]
//                                       [--only <id,id,...>] [--timeout <sec>]
// The target tree defaults to the repo root (the pack's own location).
// Every row classifies as exactly one of:
//   STILL-REPRODUCES          (the defect is live at the target head)
//   FIXED                     (the repro now refuses / heals / is gone)
//   NOT-REPRODUCIBLE-AS-FILED (probe could not execute the filed repro in
//                              this environment; the reason is in the table)
// Findings whose fix PRs are queued-but-unlanded classify STILL-REPRODUCES:
// that is the pack working, not failing. Exit code is 0 unless the manifest
// itself is invalid.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const here = dirname(new URL(import.meta.url).pathname);
const root = resolve(opt("--root", join(here, "..", "..")));
const outDir = opt("--out", null);
const only = opt("--only", null)?.split(",").map((s) => s.trim()).filter(Boolean);
const defaultTimeoutSec = Number(opt("--timeout", "240"));

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const rows = manifest.rows.filter((r) => !only || only.includes(r.id));
if (!rows.length) { console.error("no rows selected"); process.exit(2); }

const packTmp = join(process.env.TMPDIR ?? tmpdir(), `r1-spine-${process.pid}`);
mkdirSync(packTmp, { recursive: true });

function runProbe(row) {
  return new Promise((resolvePromise) => {
    if (!row.probe || row.probe === "none") {
      return resolvePromise({ cls: "NOT-REPRODUCIBLE-AS-FILED", reason: row.notFiledReason ?? "no executable repro in the pack for this row", ms: 0 });
    }
    const probePath = join(here, "probes", row.probe);
    const timeoutMs = (row.timeoutSec ?? defaultTimeoutSec) * 1000;
    const child = spawn(process.execPath, [probePath, row.id], {
      cwd: root,
      env: { ...process.env, R1_ROOT: root, R1_TMP: packTmp, TMPDIR: packTmp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; if (out.length > 1_000_000) out = out.slice(-1_000_000); });
    child.stderr.on("data", (d) => { err += d; if (err.length > 200_000) err = err.slice(-200_000); });
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/R1-VERDICT (FIXED|STILL|NOTFILED) :: (.*)/);
      if (m) {
        const cls = m[1] === "STILL" ? "STILL-REPRODUCES" : m[1] === "FIXED" ? "FIXED" : "NOT-REPRODUCIBLE-AS-FILED";
        return resolvePromise({ cls, reason: m[2].trim(), ms: 0 });
      }
      const errLine = (err.trim().split("\n").filter(Boolean).pop() ?? out.trim().split("\n").filter(Boolean).pop() ?? "no output").slice(0, 300);
      resolvePromise({ cls: "NOT-REPRODUCIBLE-AS-FILED", reason: `probe produced no verdict (${errLine})`, ms: 0 });
    });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ cls: "NOT-REPRODUCIBLE-AS-FILED", reason: `probe spawn failed: ${e.message}`, ms: 0 }); });
  });
}

const results = [];
for (const row of rows) {
  const t0 = Date.now();
  const r = await runProbe(row);
  r.ms = Date.now() - t0;
  results.push({ ...row, classification: r.cls, reason: r.reason, runMs: r.ms });
  console.error(`[${results.length}/${rows.length}] ${row.id}: ${r.cls}`);
}

const counts = { "STILL-REPRODUCES": 0, "FIXED": 0, "NOT-REPRODUCIBLE-AS-FILED": 0 };
for (const r of results) counts[r.classification]++;

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const lines = [];
lines.push(`# Regression-spine classification — ${results.length} findings`);
lines.push("");
lines.push(`Target root: \`${root}\` · manifest baseline note: ${manifest.baselineNote}`);
lines.push("");
lines.push(`**STILL-REPRODUCES: ${counts["STILL-REPRODUCES"]} · FIXED: ${counts.FIXED} · NOT-REPRODUCIBLE-AS-FILED: ${counts["NOT-REPRODUCIBLE-AS-FILED"]}**`);
lines.push("");
lines.push("| ID | Lane | Sev | Classification | Expected fixed behaviour | Evidence (probe result) |");
lines.push("|---|---|---|---|---|---|");
for (const r of results) {
  lines.push(`| ${r.id} | ${r.lane} | ${r.severity} | ${r.classification} | ${esc(r.expectedFixed)} | ${esc(r.reason)} |`);
}
lines.push("");
const table = lines.join("\n");
console.log(table);

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "classification.md"), table + "\n");
  writeFileSync(join(outDir, "classification.json"), JSON.stringify({ root, counts, results }, null, 2));
  console.error(`wrote ${join(outDir, "classification.md")} and classification.json`);
}
