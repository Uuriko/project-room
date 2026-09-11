// Compact release-evidence manifest built only from actual results.
// Skipped tests are never labeled passed, a dirty candidate tree is never
// labeled clean, and live state is never labeled live without probe evidence.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function parseTapSummary(text) {
  const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const raw of text.split("\n")) {
    const m = /^[#ℹ]\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(raw.trim());
    if (m) counts[m[1]] = Number(m[2]);
  }
  return counts;
}

export function suiteLabel(counts) {
  if (counts.fail > 0 || counts.cancelled > 0) return "failed";
  if (counts.skipped > 0 || counts.todo > 0) return "passed-with-skips";
  if (counts.tests > 0 && counts.pass === counts.tests) return "passed";
  return "incomplete";
}

export function candidateState(porcelain) {
  return porcelain.trim() === "" ? "clean" : "dirty";
}

export function liveState(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return "unverified";
  const ok = probes.every(p => p && p.status === 200 && (!p.expectedSha256 || p.expectedSha256 === p.actualSha256));
  return ok ? "live" : "mismatch";
}

export function buildManifest({ commit, tapText, porcelain, probes }) {
  const counts = parseTapSummary(tapText);
  return {
    commit,
    candidate: candidateState(porcelain),
    suite: { ...counts, label: suiteLabel(counts) },
    live: liveState(probes),
  };
}

function main(argv) {
  const tapPath = argv[argv.indexOf("--tap") + 1] || null;
  const probesPath = argv.includes("--probes") ? argv[argv.indexOf("--probes") + 1] : null;
  if (!tapPath || argv.includes("--help")) {
    console.error("usage: node scripts/release-evidence.mjs --tap <tap-output-file> [--probes <probes.json>]");
    process.exit(2);
  }
  const tapText = readFileSync(tapPath, "utf8");
  const probes = probesPath ? JSON.parse(readFileSync(probesPath, "utf8")) : undefined;
  const git = args => execFileSync("git", args, { encoding: "utf8" });
  const commit = git(["rev-parse", "HEAD"]).trim();
  const porcelain = git(["status", "--porcelain"]);
  const manifest = buildManifest({ commit, tapText, porcelain, probes });
  console.log(JSON.stringify(manifest, null, 2));
  if (manifest.suite.label !== "passed" || manifest.candidate !== "clean") process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main(process.argv.slice(2));
