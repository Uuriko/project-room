// PR diff-size gate.
//
// Diffs over MAX_DIFF_LINES (default 300) must carry an explicit
// "Large diff justification:" section in the PR body, or the check fails.
// Why: smaller diffs mean fewer rebase conflicts (PR #1530 needed five rebase
// cycles partly because of diff size) and faster reviews. Split the PR when
// you can; justify it when you cannot.
//
// Pure contract: checkDiffSize({ numstat, prBody, threshold? }) -> { ok, counted, message }.
// CLI: BASE_SHA/HEAD_SHA (env or --base/--head), PR_BODY or PR_BODY_B64
// (env) or --body/--body-b64/--body-file args. DIFF_SIZE_THRESHOLD overrides
// the single constant without a code change.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Single configurable constant. Override per-run with DIFF_SIZE_THRESHOLD.
export const MAX_DIFF_LINES = 300;

// Justification text must carry at least this many non-whitespace characters
// after the heading; a bare "n/a" does not count.
export const MIN_JUSTIFICATION_CHARS = 40;

// Lockfiles and generated bundles churn without review surface and do not
// cause the same rebase conflicts as source edits.
const EXCLUDED_EXACT = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

function isGenerated(path) {
  return (
    path.startsWith("dist/") ||
    path.startsWith("build/") ||
    path.startsWith(".next/") ||
    path.endsWith(".min.js") ||
    path.endsWith(".min.css") ||
    path.endsWith(".map")
  );
}

export function isExcluded(path) {
  return EXCLUDED_EXACT.has(path.split("/").pop()) || isGenerated(path);
}

export function resolveThreshold() {
  const raw = process.env.DIFF_SIZE_THRESHOLD;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return MAX_DIFF_LINES;
}

// Git C-quotes a numstat path when it is not plain ASCII. Octal escapes are
// UTF-8 bytes. A still-quoted generated file does not match dist/ or .min.js,
// so the size gate counts lines that should be excluded.
function unquoteGitPath(token) {
  if (token.length < 2 || token[0] !== '"' || token.at(-1) !== '"') return token;
  const body = token.slice(1, -1);
  const bytes = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") {
      const code = body.charCodeAt(i);
      if (code > 0xff) return token;
      bytes.push(code);
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next == null) return token;
    if (next === "n") { bytes.push(0x0a); i += 2; continue; }
    if (next === "t") { bytes.push(0x09); i += 2; continue; }
    if (next === "r") { bytes.push(0x0d); i += 2; continue; }
    if (next === "\\" || next === '"') { bytes.push(next.charCodeAt(0)); i += 2; continue; }
    if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (oct.length < 3 && j < body.length && body[j] >= "0" && body[j] <= "7") {
        oct += body[j];
        j += 1;
      }
      const value = Number.parseInt(oct, 8);
      if (!Number.isInteger(value) || value > 0xff) return token;
      bytes.push(value);
      i = j;
      continue;
    }
    return token;
  }
  return Buffer.from(bytes).toString("utf8");
}

// Rename numstat is `old => new`, with each side quoted on its own. Count the
// destination: a generated file renamed into source still counts.
function numstatDestination(field) {
  const sides = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < field.length; i += 1) {
    const ch = field[i];
    if (quoted && ch === "\\") {
      current += ch + (field[i + 1] ?? "");
      if (field[i + 1] !== undefined) i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && field.startsWith(" => ", i)) {
      sides.push(current);
      current = "";
      i += 3;
      continue;
    }
    current += ch;
  }
  sides.push(current);
  return unquoteGitPath(sides.at(-1).trim());
}

function countedLines(numstat) {
  let total = 0;
  for (const line of String(numstat).split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, removed] = parts;
    const path = numstatDestination(parts.slice(2).join("\t"));
    if (isExcluded(path)) continue;
    const a = Number.parseInt(added, 10);
    const b = Number.parseInt(removed, 10);
    if (Number.isFinite(a)) total += a;
    if (Number.isFinite(b)) total += b;
  }
  return total;
}

function findJustification(prBody) {
  const lines = String(prBody || "").split("\n");
  const headingRe = /^\s*#{0,6}\s*large\s+diff\s+justification\b\s*:?\s*$/i;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  // Justification runs to the next markdown heading or the end of the body.
  const content = [];
  for (let i = start; i < lines.length; i++) {
    if (/^\s*#{1,6}\s+\S/.test(lines[i])) break;
    content.push(lines[i]);
  }
  const nonWs = content.join("\n").replace(/\s+/g, "").length;
  return nonWs >= MIN_JUSTIFICATION_CHARS ? content.join("\n").trim() : null;
}

export function checkDiffSize({ numstat, prBody, threshold } = {}) {
  const limit = threshold ?? resolveThreshold();
  const counted = countedLines(numstat);
  if (counted <= limit) {
    return {
      ok: true,
      counted,
      message: `ok: ${counted} changed lines (threshold ${limit}) — no justification needed.`,
    };
  }
  const justification = findJustification(prBody);
  if (justification) {
    return {
      ok: true,
      counted,
      message: `ok: ${counted} changed lines exceed the ${limit}-line threshold, but the PR body carries a justification section.`,
    };
  }
  return {
    ok: false,
    counted,
    message: [
      `PR diff size check failed: ${counted} changed lines exceed the ${limit}-line threshold.`,
      "",
      "Why: smaller diffs mean fewer rebase conflicts (PR #1530 needed five rebase",
      "cycles partly because of diff size) and faster reviews.",
      "Room norm (muse-room): keep PRs small; diffs over 300 lines carry a justification.",
      "",
      "To pass, either:",
      "  1. Split this PR into smaller PRs (preferred), or",
      "  2. Add a '## Large diff justification:' section to the PR body explaining",
      "     why this diff cannot be split (about 40 characters of real content or more).",
    ].join("\n"),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") out.base = argv[++i];
    else if (arg === "--head") out.head = argv[++i];
    else if (arg === "--body") out.body = argv[++i];
    else if (arg === "--body-b64") out.body = Buffer.from(argv[++i], "base64").toString("utf8");
    else if (arg === "--body-file") out.body = readFileSync(argv[++i], "utf8");
  }
  return out;
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base ?? process.env.BASE_SHA;
  const head = args.head ?? process.env.HEAD_SHA;
  if (!base || !head) {
    console.error("usage: node pr-diff-size-check.mjs --base <sha> --head <sha> [--body <text>|--body-b64 <b64>|--body-file <path>]");
    console.error("       or set BASE_SHA, HEAD_SHA, PR_BODY / PR_BODY_B64 env vars.");
    process.exit(2);
  }
  const prBody = args.body ?? (process.env.PR_BODY_B64
    ? Buffer.from(process.env.PR_BODY_B64, "base64").toString("utf8")
    : (process.env.PR_BODY ?? ""));
  let numstat;
  try {
    numstat = execFileSync("git", ["diff", "--numstat", `${base}...${head}`, "--", "."], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`failed to compute diff ${base}...${head}: ${e.message}`);
    process.exit(2);
  }
  const result = checkDiffSize({ numstat, prBody });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
