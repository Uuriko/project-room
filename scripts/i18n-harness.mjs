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
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
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
// origin/main; tests pin a known ref).
function baseRef() {
  if (process.env.I18N_BASE_REF) return process.env.I18N_BASE_REF;
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

export function checkScopeConsistency(manifest, scanned) {
  const manifestSet = new Set(manifest);
  const scannedSet = new Set(scanned);
  return {
    dropped: manifest.filter((f) => !scannedSet.has(f)),
    extra: scanned.filter((f) => !manifestSet.has(f)),
  };
}

// Paired-regeneration evasion: narrowing the scan globs AND regenerating the
// manifest/baseline with --baseline would otherwise pass --check on a shrunken
// scope. The independent pin: files removed from the manifest versus the base
// ref must genuinely no longer exist in the tree. Shrinking the manifest while
// the files are still there fails.
export function findEvasionDrops(baseManifest, manifest, exists) {
  const manifestSet = new Set(manifest);
  return baseManifest.filter((f) => !manifestSet.has(f) && exists(f));
}

function manifestAtRef(ref) {
  const out = gitOk(["show", `${ref}:strings/i18n-scope.json`]);
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
const mode = args.find((a) => ["--extract", "--check", "--baseline", "--report"].includes(a)) ?? "--check";

if (mode === "--extract") {
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
  // Independent scope pin: against the base ref's manifest, files dropped
  // from the manifest must be genuinely gone from the tree. This defeats the
  // paired evasion (narrow globs + regenerate manifest/baseline with --baseline).
  const baseManifest = manifestAtRef(baseRef());
  if (baseManifest) {
    const exists = (f) => existsSync(join(root, f));
    const evasion = findEvasionDrops(baseManifest, manifest, exists);
    if (evasion.length > 0) {
      console.error(`i18n-harness FAIL: scope manifest dropped ${evasion.length} file(s) that still exist in the tree (showing 5): ${evasion.slice(0, 5).join(", ")}. The manifest may only shrink by files deleted from the repo.`);
      failed = true;
    }
  }

  // 2. Baseline integrity: a new or modified baseline must exactly match a
  //    fresh scan of the current tree. This closes the bootstrap gap: there
  //    is no earlier baseline to compare against, so an inflated (or stale)
  //    committed baseline fails instead of becoming the new truth. An
  //    untouched baseline gets the classic ratchet: fresh counts must not
  //    exceed committed counts.
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
    for (const r of RULES) {
      const now = s.counts[r] ?? 0;
      const base = baseline.counts?.[r] ?? 0;
      if (now > base) {
        console.error(`i18n-harness FAIL: ${r} grew ${base} -> ${now} (baseline ratchet)`);
        failed = true;
      }
    }
  }
  if (failed) process.exit(1);
  console.log(`i18n-harness OK: ${s.total} violations within baseline ${JSON.stringify(baseline.counts)}`);
}

export { CATALOG_PATH, BASELINE_PATH, RULES };
