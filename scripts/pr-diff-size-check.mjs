// PR diff-size gate.
//
// Diffs over MAX_DIFF_LINES (default 300) must carry an explicit
// "Large diff justification:" section in the PR body, or the check fails.
// Why: smaller diffs mean fewer rebase conflicts (PR #1530 needed five rebase
// cycles partly because of diff size) and faster reviews. Split the PR when
// you can; justify it when you cannot.
//
// Excluded paths (lockfiles, generated output) do not count toward the 300,
// but their volume is not free either: excluded volume over
// MAX_EXCLUDED_LINES also requires a justification, so a PR cannot carry an
// arbitrarily large diff entirely inside excluded paths with the gate green
// and nothing said. A justification must be substantive, not just long:
// filler such as 45 "x" characters meets a character count but says nothing,
// so the section must also carry a minimum number of real, distinct words.
//
// Pure contract: checkDiffSize({ numstat, prBody, threshold? }) -> { ok, counted, message }.
// The verdict is a deterministic function of (numstat, prBody, threshold):
// the same inputs always produce the same verdict. Two runs at the same head
// SHA can still disagree when an *input* moved — the base ref (a stacked PR
// retargeted when its parent merges) or the PR body (a justification section
// added by an edit). Every message therefore carries an input fingerprint
// (body sha256 + justification status) so a flipped verdict is attributable
// from the check output alone instead of reading as nondeterminism.
// CLI: BASE_SHA/HEAD_SHA (env or --base/--head), PR_BODY or PR_BODY_B64
// (env) or --body/--body-b64/--body-file args. DIFF_SIZE_THRESHOLD overrides
// the single constant without a code change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Single configurable constant. Override per-run with DIFF_SIZE_THRESHOLD.
export const MAX_DIFF_LINES = 300;

// Excluded-path volume (lockfiles, generated output) is capped separately:
// past this many excluded lines a justification is required even when the
// counted diff is small. The cap is a justification trigger, not a hard
// limit — a justified lockfile regeneration of any size still passes.
export const MAX_EXCLUDED_LINES = 1000;

// Justification text must carry at least this many non-whitespace characters
// after the heading; a bare "n/a" does not count.
export const MIN_JUSTIFICATION_CHARS = 40;

// ...and it must be substantive: at least this many word tokens, of which
// at least this many are distinct, so repeated filler cannot pass.
export const MIN_JUSTIFICATION_WORDS = 6;
export const MIN_JUSTIFICATION_DISTINCT_WORDS = 5;

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
// so the size gate counts lines that should be excluded. Fail-safe: a token
// that does not decode cleanly comes back unchanged, so it is tested as-is
// and counts — decoding can only ever correct a path git actually quoted.
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

// Split a numstat path field on the rename arrow ` => ` where it appears
// outside C-quotes; quoted sides keep their quotes for unquoteGitPath.
function splitRenameArrow(field) {
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
  return sides;
}

// Brace rename form: `prefix{old => new}suffix` shares the prefix and suffix,
// so the destination is prefix + new + suffix. Returns null when the two
// halves are not brace fragments.
function braceDestination(left, right) {
  const open = left.lastIndexOf("{");
  const close = right.indexOf("}");
  if (open === -1 || close === -1) return null;
  return left.slice(0, open) + right.slice(0, close) + right.slice(close + 1);
}

// The path the gate must test is the destination: a generated file renamed
// into source still counts, and a source file renamed into dist/ does not.
// Rename numstat is `old => new`, with each side quoted on its own, or the
// brace form above (one token, C-quoted whole when it is not plain ASCII).
function numstatDestination(field) {
  const sides = splitRenameArrow(field);
  if (sides.length > 1) {
    const left = unquoteGitPath(sides[0]);
    const right = unquoteGitPath(sides.at(-1).trim());
    return braceDestination(left, right) ?? right;
  }
  const path = unquoteGitPath(sides[0].trim());
  // Whole-token-quoted brace form: the arrow sat inside the quotes, so the
  // split above never saw it; it is visible now the token is decoded.
  const arrow = path.indexOf(" => ");
  if (arrow !== -1) {
    return braceDestination(path.slice(0, arrow), path.slice(arrow + 4)) ?? path;
  }
  return path;
}

function diffTotals(numstat) {
  let counted = 0;
  let excluded = 0;
  for (const line of String(numstat).split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, removed] = parts;
    const path = numstatDestination(parts.slice(2).join("\t"));
    const a = Number.parseInt(added, 10);
    const b = Number.parseInt(removed, 10);
    const lines = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
    if (isExcluded(path)) excluded += lines;
    else counted += lines;
  }
  return { counted, excluded };
}

// Short fingerprint of the exact body the verdict was computed from, so two
// runs' outputs can be compared without echoing body text into the log.
export function bodyFingerprint(prBody) {
  return createHash("sha256").update(String(prBody || ""), "utf8").digest("hex").slice(0, 12);
}

function findJustification(prBody) {
  const lines = String(prBody || "").split("\n");
  // The heading line may carry justification text after the colon
  // ("## Large diff justification: <reason>") — the failure message shows the
  // heading with a trailing colon, so authors naturally write it that way;
  // that text counts as the section's first content line.
  const headingRe = /^\s*#{0,6}\s*large\s+diff\s+justification\b\s*:?\s*(.*)$/i;
  let start = -1;
  let inline = "";
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (m) {
      start = i + 1;
      inline = m[1] || "";
      break;
    }
  }
  if (start === -1) return null;
  // Justification runs to the next markdown heading or the end of the body.
  const content = inline ? [inline] : [];
  for (let i = start; i < lines.length; i++) {
    if (/^\s*#{1,6}\s+\S/.test(lines[i])) break;
    content.push(lines[i]);
  }
  const text = content.join("\n");
  const nonWs = text.replace(/\s+/g, "").length;
  if (nonWs < MIN_JUSTIFICATION_CHARS) return null;
  // Substantive, not just long: enough real words, enough of them distinct,
  // so a repeated filler character or word cannot satisfy the gate.
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  if (words.length < MIN_JUSTIFICATION_WORDS) return null;
  if (new Set(words.map(word => word.toLowerCase())).size < MIN_JUSTIFICATION_DISTINCT_WORDS) return null;
  return text.trim();
}

function inputsLine(counted, excluded, prBody, justificationStatus) {
  return `inputs: counted ${counted} · excluded ${excluded} · body sha256 ${bodyFingerprint(prBody)} · justification ${justificationStatus}`;
}

export function checkDiffSize({ numstat, prBody, threshold } = {}) {
  const limit = threshold ?? resolveThreshold();
  const { counted, excluded } = diffTotals(numstat);
  const overCounted = counted > limit;
  const overExcluded = excluded > MAX_EXCLUDED_LINES;
  const needsJustification = overCounted || overExcluded;
  const justification = needsJustification ? findJustification(prBody) : null;
  const inputs = inputsLine(
    counted,
    excluded,
    prBody,
    !needsJustification ? "not needed" : justification ? "found" : "missing",
  );
  if (!needsJustification) {
    return {
      ok: true,
      counted,
      excluded,
      message: `ok: ${counted} changed lines (threshold ${limit}), ${excluded} excluded lines (cap ${MAX_EXCLUDED_LINES}) — no justification needed.\n${inputs}`,
    };
  }
  if (justification) {
    return {
      ok: true,
      counted,
      excluded,
      message: `ok: ${counted} changed lines (threshold ${limit}) and ${excluded} excluded lines (cap ${MAX_EXCLUDED_LINES}), but the PR body carries a justification section.\n${inputs}`,
    };
  }
  const reason = overCounted
    ? `PR diff size check failed: ${counted} changed lines exceed the ${limit}-line threshold.`
    : `PR diff size check failed: ${excluded} excluded lines exceed the ${MAX_EXCLUDED_LINES}-line excluded-volume cap.`;
  return {
    ok: false,
    counted,
    excluded,
    message: [
      reason,
      inputs,
      "",
      "Why: smaller diffs mean fewer rebase conflicts (PR #1530 needed five rebase",
      "cycles partly because of diff size) and faster reviews.",
      "Room norm (muse-room): keep PRs small; diffs over 300 lines carry a justification.",
      `Excluded paths (lockfiles, generated output) are capped at ${MAX_EXCLUDED_LINES} lines`,
      "before they too need a justification, so their volume cannot grow without limit.",
      "",
      "To pass, either:",
      "  1. Split this PR into smaller PRs (preferred), or",
      "  2. Add a '## Large diff justification:' section to the PR body explaining",
      "     why this diff cannot be split (about 40 characters of real content or more).",
      "     The reason may start on the heading line itself, after the colon.",
      "     Filler does not count: the section needs real, distinct words.",
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
  console.log(`diff-size inputs: base ${base.slice(0, 12)} head ${head.slice(0, 12)}`);
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
