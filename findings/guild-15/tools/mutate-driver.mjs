#!/usr/bin/env node
// WAVE-1000 guild-15 mutation work unit driver.
// usage: node mutate-driver.mjs <UNIT-ID> <mutants.json>
// mutants.json: { src: "server/x.mjs", tests: ["tests/x.test.js"], mutants: [{id, kind, old, new, note}] }
// One mutant at a time: apply (old must occur exactly once), run tests with
// TMPDIR inside the worktree, record KILLED/SURVIVED, restore the file.
// Writes findings/guild-15/mutants-<UNIT-ID>.md. Exits 0 even when mutants
// survive (survival is data, analyzed later). Never leaves the tree dirty.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const W = "/home/hatch/workspace/pr-wave1000-guild-15";
const OUT = `${W}/findings/guild-15`;
const [unit, mutantsPath] = process.argv.slice(2);
if (!unit || !mutantsPath) { console.error("usage: mutate-driver.mjs <UNIT-ID> <mutants.json>"); process.exit(2); }

const spec = JSON.parse(readFileSync(mutantsPath, "utf8"));
const srcAbs = `${W}/${spec.src}`;
const orig = readFileSync(srcAbs, "utf8");
const restore = () => writeFileSync(srcAbs, orig);

const rows = [];
let baselineOk = true, baselineOut = "";
try {
  execFileSync("node", ["--test", ...spec.tests], {
    cwd: W, env: { ...process.env, TMPDIR: `${W}/.tmp` },
    timeout: 240000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
} catch (e) {
  baselineOk = false;
  baselineOut = String(e.stdout ?? "") + String(e.stderr ?? "");
  baselineOut = baselineOut.slice(-2000);
}

for (const m of spec.mutants) {
  const content = readFileSync(srcAbs, "utf8");
  const occurrences = content.split(m.old).length - 1;
  if (occurrences !== 1) {
    rows.push({ id: m.id, kind: m.kind, status: "SKIPPED", note: m.note, detail: `anchor occurs ${occurrences}x, need exactly 1` });
    continue;
  }
  writeFileSync(srcAbs, content.replace(m.old, m.new));
  let status, detail;
  if (!baselineOk) {
    status = "BASELINE-RED"; detail = "baseline failed; mutant not evaluated";
  } else {
    try {
      execFileSync("node", ["--test", ...spec.tests], {
        cwd: W, env: { ...process.env, TMPDIR: `${W}/.tmp` },
        timeout: 240000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
      });
      status = "SURVIVED"; detail = "tests passed with mutant applied";
    } catch (e) {
      status = "KILLED";
      const out = String(e.stdout ?? "") + String(e.stderr ?? "");
      const failLines = out.split("\n").filter(l => /not ok|failing|✖|AssertionError|Error:/.test(l)).slice(0, 6);
      detail = failLines.join(" | ").slice(0, 400) || `exit ${e.status}`;
    }
  }
  restore();
  rows.push({ id: m.id, kind: m.kind, status, note: m.note, detail });
}
restore();

// Verify the tree is clean for this file.
let dirty = false;
try { execFileSync("git", ["diff", "--quiet", "--", spec.src], { cwd: W }); }
catch { dirty = true; }

const killed = rows.filter(r => r.status === "KILLED").length;
const survived = rows.filter(r => r.status === "SURVIVED").length;
const md = [`# Mutation unit ${unit} — ${spec.src}`, ``,
  `tests: ${spec.tests.join(", ")}`, `baseline: ${baselineOk ? "GREEN" : "RED"}`,
  `result: ${killed} killed / ${survived} survived / ${rows.length - killed - survived} other`, ``,
  `| id | kind | status | note | detail |`,
  `|----|------|--------|------|--------|`,
  ...rows.map(r => `| ${r.id} | ${r.kind} | ${r.status} | ${r.note} | ${(r.detail ?? "").replace(/\|/g, "/").slice(0, 160)} |`),
  ``, dirty ? `TREE-DIRTY after unit — investigate` : `tree restored clean`,
].join("\n");
writeFileSync(`${OUT}/mutants-${unit}.md`, md);
console.log(`unit ${unit}: ${killed} killed, ${survived} survived, ${rows.length - killed - survived} other${dirty ? " TREE-DIRTY" : ""}${baselineOk ? "" : " BASELINE-RED"}`);
