// Claim-scope check for the cheap-first mechanical review pass.
//
// A pull request declares the files its claim covers in the PR body with an
// HTML comment:
//
//   <!-- claim-files: server/a.mjs, tests/a.test.js -->
//
// (comma- or newline-separated; several comments are merged; a trailing `/`
// on an entry covers that whole directory, e.g. `scripts/`).
//
// This script compares the PR's changed files against the declared list and
// reports one verdict:
//   clean      every changed file was declared
//   drift      at least one changed file was not declared (scope drift)
//   undeclared the PR body declares no files; the reviewer checks scope by hand
//
// Drift is a reviewer signal, not a merge blocker: claims legitimately grow
// (lockfiles, generated files). The mechanical CI workflow reports the
// verdict as a machine-readable check summary; the strong-model judgment
// pass decides whether the drift is acceptable.
//
// Usage:
//   node scripts/review-scope-check.mjs --files-file <paths, one per line> --body-file <pr-body>
//   node scripts/review-scope-check.mjs --base <sha> --head <sha> --body-file <pr-body>
//   node scripts/review-scope-check.mjs --declared a.mjs,b.mjs --files-file <...>
//   CI_CHANGED_FILES (newline-separated) overrides git when set outside CI.
// Exit: 0 on success (verdict in the JSON report); 2 on drift with --strict;
// 1 on usage errors.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizePath(p) {
  let s = String(p ?? "").trim();
  try { s = s.normalize("NFC"); } catch { /* unpaired surrogates stay as given */ }
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

// A declared entry covers a changed file when it matches exactly, or when
// the entry ends in `/` and the file lives under that directory. Paths are
// compared after NFC composition, so an NFD spelling is the same file.
// Case stays distinct. A bare directory name without the trailing slash is
// exact-only on purpose: it keeps `scripts` from silently covering `scripts2/x.mjs`.
export function covers(declared, changed) {
  if (declared.endsWith("/")) return changed.startsWith(declared);
  return changed === declared;
}

export function parseDeclaredFiles(prBody) {
  const body = String(prBody ?? "");
  const found = [];
  const re = /<!--\s*claim-files:\s*([\s\S]*?)\s*-->/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const part of m[1].split(/[,\n]/)) {
      const p = normalizePath(part);
      if (p && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

export function matchScope(changedFiles, declaredFiles) {
  const changed = (changedFiles ?? []).map(normalizePath).filter(Boolean);
  const declared = (declaredFiles ?? []).map(normalizePath).filter(Boolean);
  if (declared.length === 0) return { verdict: "undeclared", changed, declared, inScope: [], drift: [] };
  const inScope = [];
  const drift = [];
  for (const file of changed) {
    (declared.some(d => covers(d, file)) ? inScope : drift).push(file);
  }
  return { verdict: drift.length > 0 ? "drift" : "clean", changed, declared, inScope, drift };
}

// Git C-quotes a --name-only path when it is not plain ASCII. Octal escapes
// are UTF-8 bytes. A still-quoted token does not match the declared path.
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

// git diff --name-only quotes a path that is not plain ASCII. The quoted
// token is not the path the claim declared.
export function pathsFromNameOnly(text) {
  return String(text ?? "").split("\n").map(line => unquoteGitPath(line.trim())).filter(Boolean);
}

function changedFilesFromGit(base, head) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { cwd: root }).toString("utf8");
  return pathsFromNameOnly(out);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let changed;
  if (args["files-file"]) {
    changed = readFileSync(resolve(root, args["files-file"]), "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  } else if (process.env.CI_CHANGED_FILES != null && !process.env.GITHUB_ACTIONS) {
    changed = process.env.CI_CHANGED_FILES.split("\n").map(s => s.trim()).filter(Boolean);
  } else if (args.base && args.head) {
    changed = changedFilesFromGit(args.base, args.head);
  } else {
    console.error("usage: review-scope-check.mjs (--files-file <f> | --base <sha> --head <sha>) [--body-file <f>] [--declared a,b] [--strict]");
    process.exit(1);
  }
  let declared = [];
  if (args["body-file"]) declared = parseDeclaredFiles(readFileSync(resolve(root, args["body-file"]), "utf8"));
  if (args.declared) declared = declared.concat(String(args.declared).split(",").map(normalizePath).filter(Boolean));
  declared = [...new Set(declared)];
  const report = {
    tool: "review-scope-check",
    ...matchScope(changed, declared),
    changedCount: changed.length,
    declaredCount: declared.length,
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.strict && report.verdict === "drift") process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
