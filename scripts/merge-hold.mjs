#!/usr/bin/env node
// scripts/merge-hold.mjs — machine-readable main-merge holds on #266.
//
// Release holds are prose today ("please hold non-urgent main merges until
// 22:00 UTC"), so lanes miss them: on 2026-09-26 #1081 and #1103 both merged
// during announced holds and restarted a ~13 minute release CI cycle each.
// This script gives a hold a fenced block that tools can read, and a check a
// lane runs right before `gh pr merge`. Holds are advisory coordination data,
// not authenticated authority: by/exempt-pr never grant permission or bypass
// CI or branch protection. scripts/room has no merge verb; callers must run
// this fresh check themselves and stop on a blocking hold or read failure.
//
// Hold block (post on #266):
//
//   ```room-hold
//   scope:  main-merges
//   until:  2026-09-26T22:20:00Z
//   by:     codex
//   exempt-pr: 1104
//   reason: release #1104 exact-head CI
//   ```
//
// `exempt-pr` (optional) lists PRs the hold does not block, usually the
// release PR itself: comma- or space-separated numbers, `#` optional.
//
// Lift it early with a block of the same shape and `until: now`, or post a
// newer hold. The newest hold block on the board wins; a hold whose `until`
// has passed is inactive. `urgent` PRs can still merge if the holder says so
// in the thread; this script only answers "is a hold active right now".
//
// Usage:
//   node scripts/merge-hold.mjs check [--pr N] [--comments file.json] [--now ISO]
//     exit 0 = no active hold (or --pr N is exempt), exit 3 = hold blocks this merge
//   node scripts/merge-hold.mjs block --until ISO --by lane --reason "..."
//     prints a hold block to paste
//
// Read-only against GitHub: fetches every current page of #266 comments with
// unauthenticated REST GETs (GITHUB_TOKEN used when set).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FENCE = /```room-hold\s*\n([\s\S]*?)```/g;
const FIELD = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/;

export function parseHolds(comments) {
  if (!Array.isArray(comments)) throw new TypeError("comments must be an array");
  const holds = [];
  for (const comment of comments) {
    if (typeof comment?.body !== "string") continue;
    for (const match of comment.body.matchAll(FENCE)) {
      const fields = {};
      for (const line of match[1].split("\n")) {
        const field = FIELD.exec(line);
        if (field) fields[field[1]] = field[2];
      }
      const until = fields.until === "now" ? comment.created_at : fields.until;
      const untilMs = Date.parse(until ?? "");
      holds.push({
        commentId: comment.id ?? null,
        postedAt: comment.created_at ?? null,
        scope: fields.scope ?? "main-merges",
        until: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null,
        by: fields.by ?? null,
        reason: fields.reason ?? null,
        exemptPrs: (fields["exempt-pr"] ?? "").split(/[\s,]+/).map(v => Number(v.replace(/^#/, ""))).filter(Number.isInteger).filter(n => n > 0),
        valid: Number.isFinite(untilMs),
      });
    }
  }
  return holds;
}

// The newest valid main-merges hold decides. Active when its until is in the future.
export function activeHold(comments, { now = Date.now() } = {}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const holds = parseHolds(comments)
    .filter(hold => hold.valid && hold.scope === "main-merges")
    .sort((a, b) => Date.parse(a.postedAt ?? 0) - Date.parse(b.postedAt ?? 0));
  const latest = holds.at(-1);
  if (!latest || Date.parse(latest.until) <= nowMs) return null;
  return latest;
}

export function holdBlock({ until, by, reason, exemptPrs = [] }) {
  if (!Number.isFinite(Date.parse(until))) throw new Error("--until must be an ISO time");
  if (!by || !reason) throw new Error("--by and --reason are required");
  const lines = ["```room-hold", "scope:  main-merges", `until:  ${new Date(until).toISOString()}`, `by:     ${by}`];
  if (exemptPrs.length) lines.push(`exempt-pr: ${exemptPrs.join(", ")}`);
  return [...lines, `reason: ${reason}`, "```"].join("\n");
}

// Does the active hold block merging this PR? null PR = any merge.
export function holdBlocks(hold, pr = null) {
  if (!hold) return false;
  return !(Number.isInteger(pr) && hold.exemptPrs.includes(pr));
}

async function fetchRecentComments(token) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "project-room-merge-hold" };
  if (token) headers.authorization = `Bearer ${token}`;
  const issueResponse = await fetch("https://api.github.com/repos/Uuriko/project-room/issues/266", { headers, signal: AbortSignal.timeout(10000) });
  if (!issueResponse.ok) throw new Error(`GitHub ${issueResponse.status} reading board metadata`);
  const issue = await issueResponse.json();
  if (!Number.isSafeInteger(issue.comments) || issue.comments < 0 || issue.comments > 10000) throw new Error("Board comment count unavailable or beyond bounded check");
  const last = Math.max(1, Math.ceil(issue.comments / 100));
  const comments = [];
  for (let page = 1; page <= last; page++) {
    const response = await fetch(`https://api.github.com/repos/Uuriko/project-room/issues/266/comments?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`GitHub ${response.status} reading #266`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Malformed GitHub comments response");
    comments.push(...rows);
  }
  if (comments.length < issue.comments) throw new Error("Incomplete board read; retry before merging");
  return comments;
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === "block") {
    const exempt = (option(args, "--exempt-pr") ?? "").split(",").map(Number).filter(Number.isInteger).filter(n => n > 0);
    process.stdout.write(holdBlock({ until: option(args, "--until"), by: option(args, "--by"), reason: option(args, "--reason"), exemptPrs: exempt }) + "\n");
    return;
  }
  if (verb !== "check") throw new Error("usage: merge-hold.mjs check|block");
  const file = option(args, "--comments");
  const comments = file ? JSON.parse(readFileSync(file, "utf8")) : await fetchRecentComments(process.env.GITHUB_TOKEN);
  const hold = activeHold(comments, { now: option(args, "--now") ?? Date.now() });
  const pr = option(args, "--pr") === undefined ? null : Number(String(option(args, "--pr")).replace(/^#/, ""));
  if (!hold) { process.stdout.write("no active main-merge hold\n"); return; }
  if (!holdBlocks(hold, pr)) { process.stdout.write(`#${pr} is exempt from the hold by ${hold.by ?? "unknown"} until ${hold.until}\n`); return; }
  process.stdout.write(`HOLD: main merges held by ${hold.by ?? "unknown"} until ${hold.until}. Reason: ${hold.reason ?? "none given"}. Comment ${hold.commentId}.\n`);
  process.exitCode = 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
