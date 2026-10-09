// i18n test harness (backlog Q012) — extraction + readiness checks as a CI
// lint-like gate. Harness-first: it MEASURES i18n readiness; it does not
// translate anything and it never edits UI code. Baseline ratchet: the
// baseline file records violation counts on the day it was generated; `--check`
// fails only when a rule's count grows beyond the baseline, so current main
// passes while regressions get caught.
//
// Scopes (user-facing string surfaces):
//   - UI strings: src/**/*.js and root *.html pages
//   - email templates: server/notify-email.mjs, server/email-envelope.mjs
//   - error messages: throw/new Error(<literal>) in server/**/*.mjs
//
// Rules:
//   - hardcoded-ui-string : prose-like literal found outside the strings catalog
//   - sentence-concatenation : building sentences with + or multi-interpolation
//     template literals (blocks later reordering for translation)
//   - positional-placeholder : {0} / %s / %d style positional placeholders
//     (named {name} placeholders are the readiness target)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// I18N_SCAN_ROOT points the scan at an extracted copy of another tree (the
// base-tree ratchet below runs this same harness there with --counts).
const root = process.env.I18N_SCAN_ROOT ? resolve(process.env.I18N_SCAN_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const BASELINE_PATH = join(root, "strings", "i18n-baseline.json");
const CATALOG_PATH = join(root, "strings", "en.json");

// Scan-scope manifest: the exact set of files the scan covers, committed at
// strings/i18n-scope.json. --check fails closed when a manifest-listed file
// drops out of the scan (silent unscanning), and when a modified manifest no
// longer matches the actual scan (tampered scope). Additions are free; the
// ratchet counts their strings.
export const SCOPE_PATH = join(root, "strings", "i18n-scope.json");

function isScannableRel(rel) {
  return !(/(^|\/)(tests?|__tests__|fixtures?)\//.test(rel) || /\.test\.[mc]?js$/.test(rel));
}

// I18N_BASE_REF overrides the base ref (CI auto-detects the merge-base with
// origin/main; tests pin a known ref). On a pull_request run the checkout is
// GitHub's merge commit, whose first parent is the base branch tip (the lint
// job fetches depth 2 for it), so the base is the main the PR lands on.
function baseRef() {
  if (process.env.I18N_BASE_REF) return process.env.I18N_BASE_REF;
  if (/^pull_request/.test(process.env.GITHUB_EVENT_NAME || "")) {
    const parent = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^1"], { cwd: root, encoding: "utf8" });
    if (parent.status === 0 && parent.stdout.trim()) return parent.stdout.trim();
  }
  const mb = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" });
  if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  return "origin/main";
}

function gitOk(args) {
  try {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

// True when the file is new or differs versus the base ref (working tree).
// Fail-closed: when git cannot tell, treat as modified.
function fileModifiedVsBase(rel) {
  const ref = baseRef();
  if (gitOk(["cat-file", "-e", `${ref}:${rel}`]) === null) return true;
  const out = gitOk(["diff", "--name-only", ref, "--", rel]);
  if (out === null) return true;
  return out.trim() !== "";
}

// Counts of the base tree, scanned by this harness's own rules: the files the
// scan covers are extracted from `ref` with git archive and re-scanned in a
// child process (I18N_SCAN_ROOT). Returns null when the base is unavailable
// (shallow clone, unknown ref); the ratchet then uses the committed baseline
// alone, exactly as before.
export function baseTreeCounts(ref) {
  const paths = [...UI_GLOBS, "server", "strings"].filter((p) => gitOk(["cat-file", "-e", `${ref}:${p}`]) !== null);
  if (paths.length === 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "i18n-base-"));
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", ref, "--", ...paths], { cwd: root, maxBuffer: 1 << 30 });
    if (archive.status !== 0) return null;
    const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout, maxBuffer: 1 << 30 });
    if (untar.status !== 0) return null;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--counts"], {
      encoding: "utf8", env: { ...process.env, I18N_SCAN_ROOT: dir },
    });
    if (child.status !== 0) return null;
    return JSON.parse(child.stdout);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Growth past the ratchet is allowed only when declared: the PR carries the
// i18n-growth label or a line "i18n-growth: <reason>" in its body (read from
// the Actions event payload), or I18N_ALLOW_GROWTH=1 locally. A label or body
// edit needs a lint re-run (gh run rerun --failed) or a new push.
export function growthAllowance(env = process.env) {
  if (env.I18N_ALLOW_GROWTH === "1") return "I18N_ALLOW_GROWTH=1";
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request;
    if (!pr) return null;
    if ((pr.labels || []).some((l) => l?.name === "i18n-growth")) return "PR label i18n-growth";
    const line = /^\s*i18n-growth:\s*(\S.*)$/im.exec(pr.body || "");
    if (line) return `PR body "i18n-growth: ${line[1].trim().slice(0, 120)}"`;
  } catch {
    return null;
  }
  return null;
}

export function checkScopeConsistency(manifest, scanned) {
  const manifestSet = new Set(manifest);
  const scannedSet = new Set(scanned);
  return {
    dropped: manifest.filter((f) => !scannedSet.has(f)),
    extra: scanned.filter((f) => !manifestSet.has(f)),
  };
}

// Independent scope pin. The manifest is self-generated (via --baseline), so
// comparing it only against the base ref's manifest silently skips on the
// bootstrap PR and can be defeated by paired regeneration (narrow the globs,
// regenerate). The pin instead enumerates the ACTUAL tree with `git ls-files`
// and hardcoded surface rules that do not derive from the mutable scan
// config: every tracked file in the scan surface must be in the manifest.
// This cannot silently skip -- git ls-files either returns the tree or the
// check fails closed.
function expectedTrackedFiles() {
  const out = gitOk(["ls-files", "-z"]);
  if (out === null) return null;
  return out
    .split("\0")
    .filter(Boolean)
    .filter(
      (f) =>
        (f.startsWith("src/") && (f.endsWith(".js") || f.endsWith(".mjs"))) ||
        (f.endsWith(".html") && !f.includes("/")) ||
        f === "server/notify-email.mjs" ||
        f === "server/email-envelope.mjs"
    )
    .filter(isScannableRel)
    .sort();
}

export function findUnpinnedFiles(expected, manifest) {
  const manifestSet = new Set(manifest);
  return expected.filter((f) => !manifestSet.has(f));
}

// Files the harness READS but never modifies; everything else lives in
// scripts/, tests/, strings/, docs/ (new files this lane owns).
const UI_GLOBS = ["src", "index.html", "join.html", "about.html", "offers.html", "operator.html", "offline.html", "404.html"];
const EMAIL_FILES = ["server/notify-email.mjs", "server/email-envelope.mjs"];
const RULES = ["hardcoded-ui-string", "sentence-concatenation", "positional-placeholder"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (["node_modules", ".git", "tests", "evals", "docs", "chaos", "perf"].includes(entry)) continue;
      walk(p, out);
    } else if (/\.(m?js|html)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src) {
  // Remove // and /* */ comments so commented-out copy is not extracted.
  let out = "";
  let i = 0;
  const n = src.length;
  let q = null; // current string quote
  while (i < n) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === "\\" && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

// Extract string literals with their positions. Template literals carry
// interpolation metadata for the concatenation rule.
export function extractLiterals(source) {
  const clean = stripComments(source);
  const lineStarts = [0];
  for (let k = 0; k < clean.length; k++) if (clean[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid; }
    return lo + 1;
  };
  const literals = [];
  let i = 0;
  const n = clean.length;
  while (i < n) {
    const c = clean[i];
    if (c !== '"' && c !== "'" && c !== "`") { i++; continue; }
    const quote = c;
    const start = i;
    let value = "";
    let interpolations = 0;
    let depth = 0;
    i++;
    while (i < n) {
      const ch = clean[i];
      if (ch === "\\" && i + 1 < n) { value += ch + clean[i + 1]; i += 2; continue; }
      if (quote === "`" && ch === "$" && clean[i + 1] === "{") {
        interpolations++;
        depth++;
        i += 2;
        let inner = "";
        while (i < n && depth > 0) {
          if (clean[i] === "{") depth++;
          else if (clean[i] === "}") depth--;
          if (depth > 0) inner += clean[i];
          i++;
        }
        value += "${" + inner + "}";
        continue;
      }
      if (ch === quote) { i++; break; }
      if (quote !== "`" && ch === "\n") break; // unterminated; bail
      value += ch;
      i++;
    }
    literals.push({ quote, value, interpolations, line: lineOf(start) });
  }
  return literals;
}

const PROSE_MIN_WORDS = 3;

export function looksLikeProse(raw) {
  // Strip HTML tags first: '<li class="x">No decisions recorded yet.</li>'
  // still carries a user-facing sentence inside.
  const text = raw.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").trim();
  if (text.length < 12) return false;
  if (/^(https?:\/\/|wss?:\/\/|mailto:|data:)/i.test(text)) return false;
  if (/^[\w\-./]+\.(m?js|html|css|json|svg|png|map)$/i.test(text)) return false;
  if (/^[a-z][\w$-]*(?:[.#][\w$-]+)+$/.test(text)) return false; // selectors/keys
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return false; // SCREAMING codes
  if (/^[\w$.-]+\/[\w$./-]+$/.test(text) && !/\s/.test(text)) return false; // paths
  const words = text.split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w));
  return words.length >= PROSE_MIN_WORDS;
}

export function checkLiteral(lit) {
  const hits = [];
  const { value, quote, interpolations } = lit;
  if (looksLikeProse(value)) hits.push("hardcoded-ui-string");
  if (/{(\d+)}/.test(value) || /%[sdif]/.test(value) || /%\d+\$s/.test(value)) {
    hits.push("positional-placeholder");
  }
  if (quote === "`" && interpolations >= 2) hits.push("sentence-concatenation");
  return hits;
}

const CONCAT_BIN_RE = /(["'`])\s*\+\s*[A-Za-z_$\s(]|[A-Za-z_$0-9)\]\s]\s*\+\s*(["'`])/;

export function checkSource(source, relPath) {
  const violations = [];
  const literals = extractLiterals(source);
  for (const lit of literals) {
    for (const rule of checkLiteral(lit)) {
      violations.push({ rule, file: relPath, line: lit.line, sample: lit.value.slice(0, 80) });
    }
  }
  if (CONCAT_BIN_RE.test(source)) {
    const line = source.slice(0, source.search(CONCAT_BIN_RE)).split("\n").length;
    violations.push({ rule: "sentence-concatenation", file: relPath, line, sample: "binary + string building" });
  }
  return violations;
}

function isErrorMessageScope(rel) {
  return rel.startsWith("server/") && rel.endsWith(".mjs");
}

// Server error messages: only string literals passed to Error()/throw count;
// the rest of server code (SQL, config keys) is not user-facing copy.
function checkServerErrors(source, relPath) {
  const violations = [];
  const re = /(?:throw\s+new\s+Error|new\s+Error)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const value = m[2];
    if (!looksLikeProse(value)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    violations.push({ rule: "hardcoded-ui-string", file: relPath, line, sample: value.slice(0, 80) });
    if (/{(\d+)}/.test(value) || /%[sdif]/.test(value)) {
      violations.push({ rule: "positional-placeholder", file: relPath, line, sample: value.slice(0, 80) });
    }
  }
  return violations;
}

export function scannableRels() {
  return collectFiles()
    .map((p) => relative(root, p).replace(/\\/g, "/"))
    .filter(isScannableRel)
    .sort();
}

export function collectFiles() {
  const files = [];
  for (const g of UI_GLOBS) {
    const p = join(root, g);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  for (const f of EMAIL_FILES) {
    const p = join(root, f);
    if (existsSync(p)) files.push(p);
  }
  return [...new Set(files)];
}

export function runExtraction() {
  const violations = [];
  for (const abs of collectFiles()) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (!isScannableRel(rel)) continue;
    const source = readFileSync(abs, "utf8");
    if (isErrorMessageScope(rel) && !EMAIL_FILES.includes(rel)) {
      violations.push(...checkServerErrors(source, rel));
    } else {
      violations.push(...checkSource(source, rel));
    }
  }
  return violations;
}

export function summarize(violations) {
  const counts = Object.fromEntries(RULES.map((r) => [r, 0]));
  const byFile = {};
  for (const v of violations) {
    counts[v.rule] = (counts[v.rule] ?? 0) + 1;
    byFile[v.file] = (byFile[v.file] ?? 0) + 1;
  }
  return { total: violations.length, counts, files: Object.keys(byFile).length };
}

function loadJson(path, label) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

const args = process.argv.slice(2);
const mode = args.find((a) => ["--extract", "--check", "--baseline", "--report", "--counts"].includes(a)) ?? "--check";

if (mode === "--counts") {
  console.log(JSON.stringify(summarize(runExtraction()).counts));
} else if (mode === "--extract") {
  console.log(JSON.stringify(runExtraction(), null, 2));
} else if (mode === "--report") {
  const violations = runExtraction();
  const s = summarize(violations);
  console.log(`# i18n readiness report\n`);
  console.log(`- files scanned: ${scannableRels().length}`);
  console.log(`- violations: ${s.total} across ${s.files} files`);
  for (const r of RULES) console.log(`- ${r}: ${s.counts[r]}`);
} else if (mode === "--baseline") {
  const violations = runExtraction();
  const s = summarize(violations);
  const baseline = {
    generatedAt: new Date().toISOString(),
    note: "Ratchet baseline: counts on the tree it was generated from. --check fails when any rule count grows beyond this.",
    counts: s.counts,
    total: s.total,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  const scanned = scannableRels();
  writeFileSync(SCOPE_PATH, JSON.stringify(scanned, null, 2) + "\n");
  console.log(`baseline written to ${relative(root, BASELINE_PATH)}: ${JSON.stringify(s.counts)}`);
  console.log(`scope manifest written to ${relative(root, SCOPE_PATH)}: ${scanned.length} files`);
} else if (mode === "--check") {
  const baseline = loadJson(BASELINE_PATH);
  if (!baseline) {
    console.error("i18n-harness: no baseline (strings/i18n-baseline.json). Run `node scripts/i18n-harness.mjs --baseline`.");
    process.exit(2);
  }
  const manifest = loadJson(SCOPE_PATH);
  if (!manifest) {
    console.error("i18n-harness: no scope manifest (strings/i18n-scope.json). Run `node scripts/i18n-harness.mjs --baseline`.");
    process.exit(2);
  }
  let failed = false;
  const violations = runExtraction();
  const s = summarize(violations);
  const scanned = scannableRels();

  // 1. Scope lock: manifest-listed files must still be scanned (no silent
  //    unscanning). A modified manifest must exactly match the current scan.
  const { dropped, extra } = checkScopeConsistency(manifest, scanned);
  if (dropped.length > 0) {
    console.error(`i18n-harness FAIL: scan scope regressed, ${dropped.length} manifest file(s) no longer scanned (showing 5): ${dropped.slice(0, 5).join(", ")}. Regenerate with --baseline if files were legitimately removed.`);
    failed = true;
  }
  if (fileModifiedVsBase("strings/i18n-scope.json") && (dropped.length > 0 || extra.length > 0)) {
    console.error(`i18n-harness FAIL: scope manifest modified but does not match the current scan (${extra.length} unscanned additions, ${dropped.length} drops). Regenerate with --baseline; hand-edited manifests fail.`);
    failed = true;
  }
  // Independent scope pin: every tracked file in the scan surface must be in
  // the manifest. Defeats paired regeneration (narrow globs + --baseline):
  // the shrunken manifest fails because the tree still lists the files.
  // Never silently skips -- git ls-files either returns the tree or this
  // fails closed.
  const expected = expectedTrackedFiles();
  if (expected === null) {
    console.error("i18n-harness FAIL: cannot enumerate tracked files (git ls-files failed)");
    failed = true;
  } else {
    const unpinned = findUnpinnedFiles(expected, manifest);
    if (unpinned.length > 0) {
      console.error(`i18n-harness FAIL: ${unpinned.length} tracked file(s) in the scan surface are not in strings/i18n-scope.json (showing 5): ${unpinned.slice(0, 5).join(", ")}. Run \`node scripts/i18n-harness.mjs --baseline\`.`);
      failed = true;
    }
  }

  // 2. Baseline integrity: a new or modified baseline must exactly match a
  //    fresh scan of the current tree. This closes the bootstrap gap: there
  //    is no earlier baseline to compare against, so an inflated (or stale)
  //    committed baseline fails instead of becoming the new truth. An
  //    untouched baseline gets the ratchet: fresh counts must not exceed the
  //    larger of the committed count and the base tree's own count. The base
  //    tree term means a PR never has to commit strings/i18n-baseline.json
  //    just because main moved (that file was a merge-conflict magnet);
  //    real growth over the base needs an explicit growthAllowance().
  if (fileModifiedVsBase("strings/i18n-baseline.json")) {
    for (const r of RULES) {
      const now = s.counts[r] ?? 0;
      const committed = baseline.counts?.[r] ?? 0;
      if (now !== committed) {
        console.error(`i18n-harness FAIL: baseline counts do not match fresh scan on ${r}: committed ${committed}, fresh ${now}. Regenerate with --baseline on this tree; inflated baselines fail.`);
        failed = true;
      }
    }
  } else {
    const ref = baseRef();
    const baseCounts = baseTreeCounts(ref);
    if (!baseCounts) console.log(`i18n-harness: base tree ${ref} not available; ratchet uses the committed baseline only`);
    const allowance = growthAllowance();
    for (const r of RULES) {
      const now = s.counts[r] ?? 0;
      const committed = baseline.counts?.[r] ?? 0;
      const base = Math.max(committed, baseCounts?.[r] ?? 0);
      if (now > base) {
        if (allowance) {
          console.log(`i18n-harness: ${r} grew ${base} -> ${now}, allowed by ${allowance}`);
        } else {
          console.error(`i18n-harness FAIL: ${r} grew ${base} -> ${now} (baseline ratchet; base ${ref}). Move the copy into strings/en.json, or declare it: PR label i18n-growth or a PR body line "i18n-growth: <reason>" (then re-run lint), I18N_ALLOW_GROWTH=1 locally. Do not commit a regenerated baseline for this.`);
          failed = true;
        }
      }
    }
  }
  if (failed) process.exit(1);
  console.log(`i18n-harness OK: ${s.total} violations within baseline ${JSON.stringify(baseline.counts)}`);
}

export { CATALOG_PATH, BASELINE_PATH, RULES };
