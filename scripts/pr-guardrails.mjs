#!/usr/bin/env node
// Pull-request guardrails for this repo. Decisions are pure; the workflow
// supplies GitHub's JSON and posts the result. Nothing here fails a check.
//
// Defaults:
//   open-PR cap: 5 (server/pr-throughput.mjs). A 6th open pull by the same
//   author is a throughput signal: label `throughput` and one comment that
//   says to finish, rebase, or land. The pull stays open.
//   claim first: a description should cite a Room claim or task id. Without
//   one, comment and run the file-set duplicate check.
//   stale close: 72 hours since the last commit, and checks are red or the
//   pull conflicts. One comment carries the head SHA. Labels `keep` and
//   `ready-to-land` are left alone.
//
// Duplicate files follow the rule in PR #4929 (fileSetSimilarity). That
// change is not on main, so the same Jaccard rule is copied here: shared
// paths / union >= 0.7, or either list is a subset of the other when both
// have at least two files. Ubiquitous paths are ignored, matching that PR.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPEN_PR_CAP, THROUGHPUT_LABEL } from "../server/pr-throughput.mjs";

export { DEFAULT_OPEN_PR_CAP, THROUGHPUT_LABEL };

export const STALE_QUIET_HOURS = 72;
export const STALE_QUIET_MS = STALE_QUIET_HOURS * 60 * 60 * 1000;
export const EXEMPT_LABELS = Object.freeze(["keep", "ready-to-land"]);
export const STALE_COMMENT_MARKER = "<!-- pr-stale-close -->";
export const THROUGHPUT_COMMENT_MARKER = "<!-- pr-throughput -->";
export const CLAIM_FIRST_MARKER = "<!-- pr-claim-first -->";

// Same ubiquitous paths as server/project-map.mjs on PR #4929. They show up
// on unrelated pulls and must not make those pulls look like duplicates.
export const UBIQUITOUS_FILES = Object.freeze([
  "scripts/CANDIDATE-MANIFEST.json",
  "docs/openapi.yaml",
  "scripts/runtime-package.mjs",
  "server/store.mjs",
  "server/http.mjs",
  "plugins/project-room/skills/project-room/references/errors-catalog.md",
  "skills/project-room/references/errors-catalog.md",
]);

const UBIQUITOUS = new Set(UBIQUITOUS_FILES);

export function normalizePath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!path || path.length > 300 || path.includes("\0") || path.split("/").some(part => part === ".." || part === "")) return null;
  return path;
}

// File-set Jaccard from PR #4929. duplicate is the flag the workflow comments.
export function fileSetSimilarity(left, right) {
  const clean = list => new Set((Array.isArray(list) ? list : []).map(normalizePath).filter(path => path && !UBIQUITOUS.has(path)));
  const a = clean(left);
  const b = clean(right);
  const shared = [...a].filter(path => b.has(path)).sort();
  const union = a.size + b.size - shared.length;
  const subset = a.size >= 2 && b.size >= 2 && (shared.length === a.size || shared.length === b.size);
  const duplicate = (union > 0 && shared.length * 10 >= union * 7) || subset;
  return { jaccard: union === 0 ? 0 : shared.length / union, subset, duplicate, shared };
}

const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const CITATION = [
  new RegExp(`/work-claims/(${ID})(?![A-Za-z0-9_-])`, "g"),
  new RegExp(`(?:^|\\s)(?:claim|task)\\s*:\\s*(${ID})(?![A-Za-z0-9_-])`, "gi"),
  new RegExp(`\\b(?:claimId|taskId)\\s*[:=]\\s*["']?(${ID})(?![A-Za-z0-9_-])`, "gi"),
  new RegExp(`<!--\\s*(?:claim|task)\\s*:\\s*(${ID})\\s*-->`, "gi"),
];

export function citeClaimOrTask(text) {
  const body = String(text ?? "");
  const ids = [];
  for (const pattern of CITATION) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(body)) !== null) {
      if (!ids.includes(match[1])) ids.push(match[1]);
    }
  }
  return { cited: ids.length > 0, ids };
}

export function authorCapDecision({ open, author = null, number = null, cap = DEFAULT_OPEN_PR_CAP } = {}) {
  const count = Number(open);
  const over = Number.isInteger(count) && count > cap;
  const comment = over
    ? [
      `${author ? `${author} has` : "This author has"} ${count} open pull requests. The cap is ${cap}, a throughput signal.`,
      "Finish, rebase, or land your own open pull requests. This pull stays open, and this check does not fail.",
      "",
      THROUGHPUT_COMMENT_MARKER,
      "",
    ].join("\n")
    : null;
  return {
    over,
    cap,
    open: Number.isInteger(count) ? count : 0,
    author,
    number,
    blocking: false,
    label: over ? THROUGHPUT_LABEL : null,
    removeLabel: over ? null : THROUGHPUT_LABEL,
    comment,
  };
}

export function findDuplicatePulls(subject, others) {
  const files = filesOf(subject);
  const number = subject?.number ?? null;
  const hits = [];
  for (const other of Array.isArray(others) ? others : []) {
    if (other == null) continue;
    if (number !== null && other.number === number) continue;
    const sim = fileSetSimilarity(files, filesOf(other));
    if (!sim.duplicate) continue;
    hits.push({
      number: other.number ?? null,
      title: typeof other.title === "string" ? other.title : "",
      jaccard: Math.round(sim.jaccard * 100) / 100,
      subset: sim.subset,
      shared: sim.shared.slice(0, 8),
    });
  }
  hits.sort((a, b) => b.jaccard - a.jaccard || (a.number ?? 0) - (b.number ?? 0));
  return hits;
}

function filesOf(pull) {
  const files = pull?.files ?? pull?.filePaths ?? [];
  return files.map(file => typeof file === "string" ? file : file?.path ?? file?.filename).filter(Boolean);
}

export function claimFirstReport({ body, subject, others }) {
  const citation = citeClaimOrTask(body);
  if (citation.cited) return { cited: true, ids: citation.ids, duplicates: [], comment: null, clear: true };
  const duplicates = findDuplicatePulls(subject ?? { files: [] }, others ?? []);
  const lines = [
    "This pull request does not cite a Room claim or task id. Add one of these to the description so the room can match the work:",
    "",
    "- a work-claims URL or path (`/work-claims/<id>`)",
    "- `claim: <id>`",
    "- `task: <id>`",
    "",
    "The pull stays open. This check does not block review.",
    "",
    "Duplicate check against other open pull requests (file-set Jaccard from #4929: at least 0.7, or one file list is a subset of the other and both have at least two files):",
    "",
  ];
  if (!duplicates.length) lines.push("No similar open pull request.");
  else for (const hit of duplicates) {
    const title = hit.title ? ` ${hit.title}` : "";
    const shared = hit.shared.length ? ` (${hit.shared.join(", ")})` : "";
    lines.push(`- #${hit.number}${title}: Jaccard ${hit.jaccard.toFixed(2)}${hit.subset ? ", subset" : ""}${shared}`);
  }
  lines.push("", CLAIM_FIRST_MARKER, "");
  return { cited: false, ids: [], duplicates, comment: lines.join("\n"), clear: false };
}

function labelNames(pull) {
  return (pull?.labels ?? []).map(label => typeof label === "string" ? label : label?.name).filter(name => typeof name === "string");
}

function lastCommitAt(pull) {
  const commits = Array.isArray(pull?.commits) ? pull.commits : [];
  let latest = null;
  for (const commit of commits) {
    const at = Date.parse(commit?.committedDate ?? commit?.committed_date ?? "");
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  if (latest !== null) return latest;
  const direct = Date.parse(pull?.lastCommitAt ?? "");
  return Number.isFinite(direct) ? direct : null;
}

export function checksAreRed(pull) {
  const rollup = pull?.statusCheckRollup ?? pull?.checks ?? [];
  if (!Array.isArray(rollup)) return false;
  return rollup.some(check => {
    const conclusion = String(check?.conclusion ?? check?.state ?? "").toUpperCase();
    return conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "TIMED_OUT" || conclusion === "FAILED";
  });
}

export function pullConflicts(pull) {
  if (pull?.conflicts === true) return true;
  const mergeable = pull?.mergeable;
  return mergeable === "CONFLICTING" || mergeable === false;
}

export function staleDecision(pull, now, { quietMs = STALE_QUIET_MS } = {}) {
  const labels = labelNames(pull);
  if (labels.some(label => EXEMPT_LABELS.includes(label))) return { close: false, reason: "exempt" };
  const at = lastCommitAt(pull);
  if (at === null) return { close: false, reason: "no_commit" };
  if (now - at < quietMs) return { close: false, reason: "recent" };
  const red = checksAreRed(pull);
  const conflicts = pullConflicts(pull);
  if (!red && !conflicts) return { close: false, reason: "healthy" };
  const reason = red && conflicts ? "red_and_conflicts" : red ? "red" : "conflicts";
  return { close: true, reason };
}

export function whyClosed(reason) {
  if (reason === "conflicts") return "conflicts with the base and no commits for 72 hours";
  if (reason === "red_and_conflicts") return "checks are red, conflicts with the base, and no commits for 72 hours";
  return "checks are red and no commits for 72 hours";
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

export function restoreCommand(number, sha, branch) {
  const fetch = `git fetch origin pull/${number}/head`;
  if (typeof branch === "string" && BRANCH.test(branch)) return `${fetch} && git push origin ${sha}:refs/heads/${branch}`;
  return `${fetch}\n# branch: ${String(branch ?? "")}\ngit push origin ${sha}:refs/heads/<branch>`;
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

export function archiveRow(pull, reason) {
  const sha = typeof pull.sha === "string" ? pull.sha : pull.headRefOid;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("archive row needs a 40-character head SHA");
  if (!Number.isInteger(pull.number)) throw new Error("archive row needs a pull number");
  const branch = typeof pull.branch === "string" ? pull.branch : pull.headRefName ?? "";
  const title = cell(pull.title).slice(0, 180);
  return `| #${pull.number} | ${title} | \`${cell(branch)}\` | \`${sha}\` | ${cell(whyClosed(reason))} |`;
}

export function staleComment(pull, decision) {
  const sha = pull.sha ?? pull.headRefOid;
  const branch = pull.branch ?? pull.headRefName ?? "";
  const reason = decision.reason === "conflicts"
    ? "It conflicts with the base."
    : decision.reason === "red_and_conflicts"
      ? "Checks are red, and it conflicts with the base."
      : "Checks are red.";
  return [
    `Closed after ${STALE_QUIET_HOURS} hours with no new commits. ${reason}`,
    "",
    `Head SHA: \`${sha}\``,
    `Branch: \`${branch}\``,
    "",
    "Restore:",
    "",
    "```",
    restoreCommand(pull.number, sha, branch),
    "```",
    "",
    "The same row is appended to docs/ARCHIVED-WORK.md.",
    "",
    STALE_COMMENT_MARKER,
    "",
  ].join("\n");
}

function normalizedPull(raw) {
  return {
    number: raw.number,
    title: raw.title ?? "",
    author: raw.author?.login ?? (typeof raw.author === "string" ? raw.author : null),
    branch: raw.headRefName ?? raw.branch ?? "",
    sha: raw.headRefOid ?? raw.sha ?? "",
    labels: labelNames(raw),
    commits: raw.commits,
    lastCommitAt: raw.lastCommitAt,
    statusCheckRollup: raw.statusCheckRollup,
    checks: raw.checks,
    mergeable: raw.mergeable,
    conflicts: raw.conflicts,
    files: filesOf(raw),
  };
}

export function planStaleClose(pulls, now) {
  const close = [];
  for (const raw of Array.isArray(pulls) ? pulls : []) {
    const pull = normalizedPull(raw);
    const decision = staleDecision(pull, now);
    if (!decision.close) continue;
    close.push({
      number: pull.number,
      title: pull.title,
      branch: pull.branch,
      sha: pull.sha,
      reason: decision.reason,
      comment: staleComment(pull, decision),
      row: archiveRow(pull, decision.reason),
    });
  }
  close.sort((a, b) => a.number - b.number);
  return { now, quietHours: STALE_QUIET_HOURS, close };
}

const ARCHIVED_ROW = /^\| #(\d+) \|/;

export function archivedNumbers(markdown) {
  const numbers = new Set();
  for (const line of String(markdown ?? "").split("\n")) {
    const match = ARCHIVED_ROW.exec(line);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

function archivedLines(markdown) {
  return String(markdown ?? "").split("\n").filter(line => ARCHIVED_ROW.test(line));
}

// Insert rows into the closed-PR table, before the next heading. A number
// already in `base` is skipped. Lines from `previous` that are not on main
// are kept, so a later run can rebuild the archive branch from main.
export function mergeArchivedWork(mainMarkdown, previousMarkdown, rows) {
  const base = String(mainMarkdown ?? "");
  const have = archivedNumbers(base);
  const extra = [];
  for (const line of archivedLines(previousMarkdown)) {
    const number = Number(ARCHIVED_ROW.exec(line)[1]);
    if (have.has(number)) continue;
    have.add(number);
    extra.push(line);
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const line = typeof row === "string" ? row : row?.row;
    if (typeof line !== "string" || !ARCHIVED_ROW.test(line)) continue;
    const number = Number(ARCHIVED_ROW.exec(line)[1]);
    if (have.has(number)) continue;
    have.add(number);
    extra.push(line);
  }
  if (!extra.length) return base.endsWith("\n") || base.length === 0 ? base : `${base}\n`;
  const block = extra.join("\n");
  const header = "| PR | Title / idea | Branch | Head SHA | Why closed |";
  const headerAt = base.indexOf(header);
  const headingAt = base.indexOf("\n## ");
  let next;
  if (headerAt !== -1 && headingAt > headerAt) next = `${base.slice(0, headingAt)}\n${block}${base.slice(headingAt)}`;
  else if (headerAt !== -1) next = `${base.replace(/\s*$/, "")}\n${block}\n`;
  else next = `${base.replace(/\s*$/, "")}\n\n${header}\n|---|---|---|---|---|\n${block}\n`;
  return next.endsWith("\n") ? next : `${next}\n`;
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "cap") {
    const open = Number(readFlag(argv, "--open"));
    const capFlag = readFlag(argv, "--cap");
    print(authorCapDecision({
      open,
      author: readFlag(argv, "--author"),
      number: Number(readFlag(argv, "--number")),
      ...(capFlag ? { cap: Number(capFlag) } : {}),
    }));
    return;
  }
  if (command === "cite") {
    const file = readFlag(argv, "--body-file");
    print(citeClaimOrTask(file ? readFileSync(file, "utf8") : ""));
    return;
  }
  if (command === "claim-first") {
    const bodyFile = readFlag(argv, "--body-file");
    const input = JSON.parse(readFileSync(readFlag(argv, "--input"), "utf8"));
    const number = Number(readFlag(argv, "--number"));
    const pulls = (Array.isArray(input) ? input : input.pulls ?? []).map(normalizedPull);
    const subject = pulls.find(pull => pull.number === number) ?? { number, files: [] };
    print(claimFirstReport({ body: bodyFile ? readFileSync(bodyFile, "utf8") : "", subject, others: pulls }));
    return;
  }
  if (command === "stale-plan") {
    const pulls = JSON.parse(readFileSync(readFlag(argv, "--input"), "utf8"));
    const nowFlag = readFlag(argv, "--now");
    const now = nowFlag ? Date.parse(nowFlag) : Date.now();
    if (!Number.isFinite(now)) throw new Error("--now must be an ISO timestamp");
    const plan = planStaleClose(Array.isArray(pulls) ? pulls : [], now);
    const dir = readFlag(argv, "--comments-dir");
    if (dir) {
      mkdirSync(dir, { recursive: true });
      for (const row of plan.close) writeFileSync(join(dir, `${row.number}.md`), row.comment);
    }
    print(plan);
    return;
  }
  if (command === "archive-merge") {
    const mainText = readFileSync(readFlag(argv, "--main"), "utf8");
    const previousFlag = readFlag(argv, "--previous");
    const previous = previousFlag ? readFileSync(previousFlag, "utf8") : "";
    const rows = JSON.parse(readFileSync(readFlag(argv, "--rows"), "utf8"));
    const merged = mergeArchivedWork(mainText, previous, rows);
    const out = readFlag(argv, "--out");
    if (out) writeFileSync(out, merged);
    else process.stdout.write(merged);
    return;
  }
  throw new Error("usage: pr-guardrails.mjs cap|cite|claim-first|stale-plan|archive-merge");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); }
  catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
