#!/usr/bin/env node
// scripts/pr-overlap.mjs — cross-PR overlap check for open pull requests.
//
// Open PRs are reviewed one at a time, so nothing notices when two of them
// change the same code. On 2026-09-26 five PRs (#1088-#1092) each added
// `export function enforceAutonomyTierForAction` to server/autonomy-tiers.mjs.
// Git merges #1088 with any of the others cleanly and leaves a duplicate
// declaration, so the module fails to load.
//
// This script reports, across open PRs:
//   duplicateDeclarations  the same top-level function/class/const/let added
//                          to the same file by two or more PRs
//   overlappingHunks       PRs whose changed line ranges overlap in one file
//   sharedFiles            files changed by two or more PRs
//
// Read-only. The only network calls are GitHub REST GETs. Pure analysis lives
// in analyzeOverlap() so tests run offline against fixtures.
//
// Usage:
//   node scripts/pr-overlap.mjs [--repo Uuriko/project-room] [--prs 1,2,3]
//                               [--input fixture.json] [--format json|md]
//                               [--ignore glob,glob]
//   GITHUB_TOKEN is used when set (higher rate limit); not required.
//
// Fixture shape (--input): [{ number, title, author, files: [{ filename, patch }] }]

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_IGNORE = ["package-lock.json", "CHANGELOG.md", "ROOM-STATE.md", "BACKLOG.md"];

// Top-level declarations an added line can introduce. Indented lines are not
// top level and are skipped.
const DECLARATION = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch) {
  const hunks = [];
  const declarations = [];
  if (typeof patch !== "string" || patch.length === 0) return { hunks, declarations };
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = HUNK.exec(line);
    if (header) {
      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      // Base-side range: where in the file both PRs started from.
      hunks.push({ start: oldStart, end: oldStart + Math.max(oldCount, 1) - 1 });
      newLine = Number(header[3]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const match = DECLARATION.exec(line.slice(1));
      if (match) declarations.push({ name: match[1] || match[2] || match[3], line: newLine });
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return { hunks, declarations };
}

const globToRegExp = glob => new RegExp(`^${glob.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

export function analyzeOverlap(pulls, { ignore = DEFAULT_IGNORE } = {}) {
  if (!Array.isArray(pulls)) throw new TypeError("pulls must be an array");
  const ignored = ignore.map(globToRegExp);
  const skip = filename => ignored.some(pattern => pattern.test(filename));
  const byFile = new Map();
  for (const pr of pulls) {
    if (!Number.isInteger(pr?.number) || !Array.isArray(pr.files)) throw new TypeError("each pull needs a number and files");
    for (const file of pr.files) {
      if (typeof file?.filename !== "string" || skip(file.filename)) continue;
      const parsed = parsePatch(file.patch);
      if (!byFile.has(file.filename)) byFile.set(file.filename, []);
      byFile.get(file.filename).push({ pr: pr.number, ...parsed });
    }
  }

  const sharedFiles = [];
  const overlappingHunks = [];
  const duplicateDeclarations = [];
  for (const [filename, entries] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.length < 2) continue;
    sharedFiles.push({ file: filename, prs: entries.map(e => e.pr).sort((a, b) => a - b) });

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i], b = entries[j];
        const ranges = [];
        for (const ha of a.hunks) for (const hb of b.hunks) {
          if (ha.start <= hb.end && hb.start <= ha.end) ranges.push({ start: Math.max(ha.start, hb.start), end: Math.min(ha.end, hb.end) });
        }
        if (ranges.length) overlappingHunks.push({ file: filename, prs: [a.pr, b.pr].sort((x, y) => x - y), baseLines: ranges });
      }
    }

    const names = new Map();
    for (const entry of entries) for (const decl of entry.declarations) {
      if (!names.has(decl.name)) names.set(decl.name, new Set());
      names.get(decl.name).add(entry.pr);
    }
    for (const [name, prs] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
      if (prs.size > 1) duplicateDeclarations.push({ file: filename, name, prs: [...prs].sort((a, b) => a - b) });
    }
  }
  overlappingHunks.sort((a, b) => a.file.localeCompare(b.file) || a.prs[0] - b.prs[0] || a.prs[1] - b.prs[1]);
  return Object.freeze({ pulls: pulls.length, duplicateDeclarations, overlappingHunks, sharedFiles });
}

export function toMarkdown(report, { titles = new Map() } = {}) {
  const pr = n => titles.has(n) ? `#${n} (${titles.get(n)})` : `#${n}`;
  const lines = [`PR overlap check: ${report.pulls} open PRs.`, ""];
  if (report.duplicateDeclarations.length) {
    lines.push("**Same declaration added more than once.** Merging these together can leave a duplicate that fails to load:");
    for (const d of report.duplicateDeclarations) lines.push(`- \`${d.name}\` in \`${d.file}\`: ${d.prs.map(pr).join(", ")}`);
    lines.push("");
  }
  if (report.overlappingHunks.length) {
    lines.push("**Changes to the same lines:**");
    for (const o of report.overlappingHunks) lines.push(`- \`${o.file}\` lines ${o.baseLines.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(", ")}: ${o.prs.map(n => `#${n}`).join(" and ")}`);
    lines.push("");
  }
  if (report.sharedFiles.length) {
    lines.push("**Files changed by more than one PR:**");
    for (const s of report.sharedFiles) lines.push(`- \`${s.file}\`: ${s.prs.map(n => `#${n}`).join(", ")}`);
    lines.push("");
  }
  if (lines.length === 2) lines.push("No overlap found.");
  return lines.join("\n").trimEnd() + "\n";
}

async function github(path, token) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "project-room-pr-overlap" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

async function fetchPulls(repo, numbers, token) {
  const list = numbers ?? (await github(`/repos/${repo}/pulls?state=open&per_page=100`, token)).map(p => p.number);
  const pulls = [];
  for (const number of list) {
    const pr = await github(`/repos/${repo}/pulls/${number}`, token);
    const files = [];
    for (let page = 1; page <= 30; page += 1) {
      const batch = await github(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
      files.push(...batch.map(f => ({ filename: f.filename, patch: f.patch ?? "" })));
      if (batch.length < 100) break;
    }
    pulls.push({ number, title: pr.title, author: pr.user?.login ?? null, files });
  }
  return pulls;
}

function parseArgs(argv) {
  const options = { repo: "Uuriko/project-room", prs: null, input: null, format: "md", ignore: DEFAULT_IGNORE };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === "--repo") { options.repo = value; i += 1; }
    else if (flag === "--prs") { options.prs = value.split(",").map(Number).filter(Number.isInteger); i += 1; }
    else if (flag === "--input") { options.input = value; i += 1; }
    else if (flag === "--format") { options.format = value; i += 1; }
    else if (flag === "--ignore") { options.ignore = value.split(",").filter(Boolean); i += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!["md", "json"].includes(options.format)) throw new Error("--format must be md or json");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pulls = options.input
    ? JSON.parse(readFileSync(options.input, "utf8"))
    : await fetchPulls(options.repo, options.prs, process.env.GITHUB_TOKEN);
  const report = analyzeOverlap(pulls, { ignore: options.ignore });
  if (options.format === "json") process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(toMarkdown(report, { titles: new Map(pulls.map(p => [p.number, p.title])) }));
  process.exitCode = report.duplicateDeclarations.length ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
