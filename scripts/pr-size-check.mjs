// PR size discipline check.
//
// CI gate that flags pull requests whose diff exceeds a configurable line
// budget unless the PR body carries an explicit justification section.
// Default mode is advisory ("warn"): the check stays green and posts a
// comment. "require" mode fails the check.
//
// Pure logic (countLines, findJustification, evaluate) is exported for
// tests/pr-size-check.test.js. The CLI wires it to git + the GitHub API.
//
// Config resolution (later wins): defaults -> .github/pr-size.json ->
// CLI flags / env. Env: PR_SIZE_LIMIT, PR_SIZE_MODE (warn|require).
//
// Claim: orch-small-prs

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_LIMIT = 300;
export const DEFAULT_MODE = "warn";
export const COMMENT_MARKER = "<!-- pr-size-discipline -->";

// Headings that count as an explicit size justification, case-insensitive.
// The section must also carry a minimum of real text (see MIN_JUSTIFY_CHARS)
// so an empty placeholder heading does not pass.
export const JUSTIFICATION_HEADINGS = [
  "why this is large",
  "size justification",
  "justification",
  "pr size",
  "large pr justification",
];
export const MIN_JUSTIFY_CHARS = 30;

/**
 * Count added/deleted lines from unified-diff text.
 * Binary files ("Binary files a and b differ") count as one changed line
 * each so they are not invisible to the budget.
 */
export function countLines(diffText) {
  let added = 0;
  let deleted = 0;
  let binaryFiles = 0;
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      binaryFiles += 1;
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      // file headers, not changes
    } else if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      deleted += 1;
    }
  }
  const total = added + deleted + binaryFiles;
  return { added, deleted, binary: binaryFiles, total };
}

/**
 * Count from `git diff --numstat` text ("<added>\t<deleted>\t<path>").
 * Binary files show as "-\t-\t<path>" and count as one changed line each.
 */
export function countNumstat(numstatText) {
  let added = 0;
  let deleted = 0;
  let binary = 0;
  for (const raw of String(numstatText ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [a, d] = line.split("\t");
    if (a === "-" || d === "-") {
      binary += 1;
    } else {
      added += Number(a) || 0;
      deleted += Number(d) || 0;
    }
  }
  return { added, deleted, binary, total: added + deleted + binary };
}

function headingMatches(line) {
  const m = /^#{1,3}\s+(.+?)\s*$/.exec(line.trim());
  if (!m) return false;
  const text = m[1].toLowerCase();
  return JUSTIFICATION_HEADINGS.some((h) => text === h || text.startsWith(h + ":") || text.startsWith(h + " -"));
}

/**
 * True when the PR body has a justification heading with substantive text.
 * Text counts until the next markdown heading or end of body.
 */
export function findJustification(prBody) {
  const lines = String(prBody ?? "").split("\n");
  let capturing = false;
  let chars = 0;
  for (const line of lines) {
    if (headingMatches(line)) {
      if (capturing && chars >= MIN_JUSTIFY_CHARS) return true;
      capturing = true;
      chars = 0;
      continue;
    }
    if (capturing && /^#{1,3}\s+/.test(line.trim())) {
      if (chars >= MIN_JUSTIFY_CHARS) return true;
      capturing = false;
      chars = 0;
      continue;
    }
    if (capturing) chars += line.replace(/\s+/g, "").length;
  }
  return capturing && chars >= MIN_JUSTIFY_CHARS;
}

export function loadConfig(repoRoot) {
  const cfg = { limit: DEFAULT_LIMIT, mode: DEFAULT_MODE };
  const path = resolve(repoRoot ?? process.cwd(), ".github/pr-size.json");
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Number.isFinite(Number(raw.limit)) && Number(raw.limit) > 0) cfg.limit = Number(raw.limit);
      if (raw.mode === "warn" || raw.mode === "require") cfg.mode = raw.mode;
    } catch {
      // Malformed config: fall back to defaults rather than failing the gate.
    }
  }
  if (process.env.PR_SIZE_LIMIT && Number(process.env.PR_SIZE_LIMIT) > 0) {
    cfg.limit = Number(process.env.PR_SIZE_LIMIT);
  }
  if (process.env.PR_SIZE_MODE === "warn" || process.env.PR_SIZE_MODE === "require") {
    cfg.mode = process.env.PR_SIZE_MODE;
  }
  return cfg;
}

/**
 * Evaluate a PR. Returns { added, deleted, binary, total, limit, mode,
 * over, justified, verdict } where verdict is "pass" | "warn" | "fail".
 */
export function evaluate({ counts, prBody, limit = DEFAULT_LIMIT, mode = DEFAULT_MODE }) {
  const { added, deleted, binary, total } = counts;
  const over = total > limit;
  const justified = over ? findJustification(prBody) : true;
  let verdict = "pass";
  if (over && !justified) verdict = mode === "require" ? "fail" : "warn";
  return { added, deleted, binary, total, limit, mode, over, justified, verdict };
}

export function formatReport(r) {
  const head = `PR size: ${r.total} lines (limit ${r.limit}) — ${r.verdict.toUpperCase()}`;
  if (r.verdict === "pass" && !r.over) return head;
  if (r.verdict === "pass") return `${head}: over budget but justified.`;
  const hint =
    `This PR changes ${r.total} lines (limit ${r.limit}). Smaller diffs rebase ` +
    `cleaner and review faster. Add a "## Why this is large" section to the PR ` +
    `body explaining why it cannot be split, or break it into smaller PRs.`;
  return `${COMMENT_MARKER}\n${head}\n\n${hint}`;
}

function gitNumstat(base, head, cwd) {
  const out = execFileSync("git", ["diff", "--numstat", `${base}...${head}`, "--"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

async function upsertComment({ repo, prNumber, token, body }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "pr-size-discipline",
  };
  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`list comments: ${listRes.status}`);
  const comments = await listRes.json();
  const existing = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
  const payload = JSON.stringify({ body });
  if (existing) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`,
      { method: "PATCH", headers, body: payload },
    );
    if (!res.ok) throw new Error(`update comment: ${res.status}`);
    return "updated";
  }
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
    { method: "POST", headers, body: payload },
  );
  if (!res.ok) throw new Error(`create comment: ${res.status}`);
  return "created";
}

async function upsertOkComment({ repo, prNumber, token }) {
  // Remove the stale warning when the PR is back under budget/justified.
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "pr-size-discipline",
  };
  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  if (!listRes.ok) return "skip";
  const comments = await listRes.json();
  const existing = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
  if (!existing) return "none";
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/comments/${existing.id}`, {
    method: "DELETE",
    headers,
  });
  return res.ok ? "removed" : "skip";
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  if (args.limit) cfg.limit = Number(args.limit);
  if (args.mode === "warn" || args.mode === "require") cfg.mode = args.mode;

  let counts;
  if (args["numstat-file"]) {
    counts = countNumstat(readFileSync(args["numstat-file"], "utf8"));
  } else if (args["diff-file"]) {
    counts = countLines(readFileSync(args["diff-file"], "utf8"));
  } else {
    const base = args.base || process.env.BASE_SHA;
    const head = args.head || process.env.HEAD_SHA;
    if (!base || !head) {
      console.error("need --base/--head (or BASE_SHA/HEAD_SHA) or --numstat-file/--diff-file");
      process.exit(2);
    }
    counts = countNumstat(gitNumstat(base, head, cwd));
  }

  let prBody = "";
  if (args["pr-body-file"]) prBody = readFileSync(args["pr-body-file"], "utf8");
  else if (args["pr-body-text"]) prBody = args["pr-body-text"];
  else if (process.env.PR_BODY) prBody = process.env.PR_BODY;

  const result = evaluate({ counts, prBody, limit: cfg.limit, mode: cfg.mode });
  const format = args.format || "text";
  console.log(format === "json" ? JSON.stringify(result, null, 2) : formatReport(result));

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(outFile, `verdict=${result.verdict}\ntotal=${result.total}\nlimit=${result.limit}\n`);
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = args["pr-number"] || process.env.PR_NUMBER;
  if (args.comment !== false && token && repo && prNumber) {
    try {
      if (result.verdict === "warn") {
        const action = await upsertComment({ repo, prNumber, token, body: formatReport(result) });
        console.log(`comment ${action}`);
      } else {
        const action = await upsertOkComment({ repo, prNumber, token });
        console.log(`stale comment: ${action}`);
      }
    } catch (err) {
      // Fork PRs get a read-only token: warn loudly, stay green in warn mode.
      console.error(`comment skipped: ${err.message}`);
    }
  }

  if (result.verdict === "fail") {
    console.error(`PR size check failed: ${result.total} lines over limit ${result.limit} without justification.`);
    process.exit(1);
  }
}

const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedAsCli) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
