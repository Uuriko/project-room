// Trace-entry automation (W001): append one merge-time line to
// docs/ROOM-TRACES.jsonl when a pull request merges to main, so the raw-traces
// plane never needs a manual backfill again.
//
// Runner: .github/workflows/trace-entry.yml (pull_request_target, closed).
// The workflow checks out main, runs this script, validates with
// scripts/check-wiki.mjs (fail closed), commits the line to a
// trace-entry/pr-<N> bot branch, and opens/merges a trace PR — a direct push
// to main is blocked by the required status checks on merges, so publication
// goes through a normal PR. This script never runs untrusted PR code: it only
// reads the GitHub-provided event payload.
//
// Entry fields (must satisfy scripts/check-wiki.mjs: date, slice, agent, pr,
// sha, outcome, tests {pass,fail}, notes; dates non-decreasing, append-only):
//   date    — PR merge date (merged_at), never the run date. Clamped up to the
//             last existing entry's date so out-of-order merge runs cannot
//             break the append-only order check.
//   slice   — the linked work claim: the "Room-Work: <id>" line in the PR body
//             (docs/GITHUB-DOOR.md), else the head branch's last path segment,
//             else "pr-<number>".
//   agent   — PR author login (the lane that did the work), else merged_by.
//   pr      — PR number. sha — 7-char short merge_commit_sha, like the manual
//             entries. outcome — "merged".
//   tests   — {pass: 0, fail: 0}. Deliberately not re-measured: a full suite
//             run at merge time would measure the merge commit, not the tested
//             head SHA, and would serialize every merge behind the slowest
//             suite. Zero counts mean "auto-traced, counts not re-measured";
//             the trace's job is linkage (PR -> SHA -> claim), not recounting.
//   notes   — the PR title, one line.
//
// Idempotent: if a line for this PR number already exists, nothing is
// appended (safe for workflow re-runs and the push-retry loop).
//
// Standalone: `node scripts/trace-entry.mjs` (needs GITHUB_EVENT_PATH).
// Test seams are env vars only: GITHUB_EVENT_PATH (the runner sets it),
// TRACE_ENTRY_FILE (defaults to docs/ROOM-TRACES.jsonl).
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTraceFile = () => join(repoRoot, "docs", "ROOM-TRACES.jsonl");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Keep the first line only, collapse whitespace, cap length. */
function oneLine(text, cap = 200) {
  return String(text ?? "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, cap);
}

/** Room-Work: <room>/<item> or <item> -> item; branch last segment; else pr-<n>. */
export function extractSlice(pr) {
  const body = String(pr?.body ?? "");
  const m = /^[ \t]*Room-Work:[ \t]*([^\s#]+)/m.exec(body);
  if (m) {
    const item = m[1].split("/").pop();
    if (item && SLUG_RE.test(item)) return item;
  }
  const branch = String(pr?.head?.ref ?? "").split("/").filter(Boolean).pop();
  if (branch && SLUG_RE.test(branch)) return branch;
  return `pr-${pr?.number}`;
}

export function buildTraceEntry(pr, now = new Date()) {
  if (!pr || typeof pr.number !== "number") throw new Error("trace-entry: event has no pull_request.number");
  const sha = String(pr.merge_commit_sha ?? "");
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("trace-entry: event has no merge_commit_sha");
  const mergedAt = String(pr.merged_at ?? "");
  const date = DATE_RE.test(mergedAt.slice(0, 10)) ? mergedAt.slice(0, 10) : now.toISOString().slice(0, 10);
  if (!DATE_RE.test(date)) throw new Error(`trace-entry: bad date ${date}`);
  const notes = oneLine(pr.title);
  if (!notes) throw new Error("trace-entry: PR title is empty");
  return {
    date,
    slice: extractSlice(pr),
    agent: String(pr?.user?.login ?? pr?.merged_by?.login ?? "unknown"),
    pr: pr.number,
    sha: sha.slice(0, 7),
    outcome: "merged",
    tests: { pass: 0, fail: 0 },
    notes,
  };
}

/** Parse the non-comment JSON lines of a traces file. */
export function readTraceLines(text) {
  const entries = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    entries.push(JSON.parse(line));
  }
  return entries;
}

export function appendTraceEntry({ traceFile, entry }) {
  const text = readFileSync(traceFile, "utf8");
  const existing = readTraceLines(text);
  if (existing.some((e) => e && (e.pr === entry.pr || e.sha === entry.sha))) {
    return { appended: false, reason: "already-traced" };
  }
  let clamped = false;
  const last = existing.at(-1);
  if (last && typeof last.date === "string" && DATE_RE.test(last.date) && entry.date < last.date) {
    entry = { ...entry, date: last.date };
    clamped = true;
  }
  appendFileSync(traceFile, JSON.stringify(entry) + "\n", "utf8");
  return { appended: true, clamped, pr: entry.pr };
}

export function loadPullRequest(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return { skipped: "GITHUB_EVENT_PATH is not set" };
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = event?.pull_request;
  if (!pr) return { skipped: "event has no pull_request" };
  if (pr.merged !== true) return { skipped: `PR #${pr.number} was closed without merging` };
  return { pr };
}

/** Returns a process exit code; prints a JSON result line. */
export function main(env = process.env) {
  try {
    const loaded = loadPullRequest(env);
    if (loaded.skipped) {
      console.log(JSON.stringify({ ok: true, skipped: loaded.skipped }));
      return 0;
    }
    const traceFile = env.TRACE_ENTRY_FILE || defaultTraceFile();
    const entry = buildTraceEntry(loaded.pr);
    const result = appendTraceEntry({ traceFile, entry });
    console.log(JSON.stringify({ ok: true, traceFile, ...result }));
    return 0;
  } catch (error) {
    console.error(`trace-entry: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
