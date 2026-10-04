// Design-token ratchet lint (D-fo-6 step 1).
// Fails CI when a NEW raw hex color literal or a NEW raw `font-size:`
// declaration appears in the CSS tree. Everything that exists today is
// grandfathered in scripts/design-tokens-baseline.json; that file only
// shrinks over time — never add NEW entries to it.
//
// Run: node scripts/lint-design-tokens.mjs
// Regenerate the baseline after legitimately removing violations:
//   node scripts/lint-design-tokens.mjs --capture
// (--capture prints the added/removed entries so review can see exactly
// what changed; never run it to bless a new violation.)
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE_PATH = join(root, "scripts", "design-tokens-baseline.json");

// A raw hex color literal in a declaration-value position: preceded by a
// colon, paren, comma, whitespace, or line start. This deliberately does
// NOT match ID selectors (e.g. `#action-dialog`) which have no value
// context — and the tree contains none that are hex-shaped anyway.
const HEX_RE = /(^|[:\s,(])#[0-9a-fA-F]{3,8}\b/g;
// A raw `font-size:` declaration: the value is a literal (16px, .875rem)
// rather than a design token. `font-size: var(--text-sm)` is the sanctioned
// token path and is NOT a violation. Custom property definitions
// (`--font-size:`) are the token mechanism itself and are excluded, as is
// `font-size-adjust:`.
const FONT_SIZE_RE = /(^|[\s{;])font-size\s*:\s*([^;}{]+)/;

export function hexHits(line) {
  // Custom property definitions (`--brand: #123456`) are the sanctioned
  // token mechanism — strip them before scanning so only raw hexes in
  // actual declarations are flagged.
  const deTokenized = line.replace(
    /--[a-zA-Z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}\b/g,
    m => m.replace(/#[0-9a-fA-F]{3,8}\b/, "<token>")
  );
  const hits = [];
  HEX_RE.lastIndex = 0;
  let m;
  while ((m = HEX_RE.exec(deTokenized)) !== null) {
    const hash = m[0].slice(m[1].length);
    hits.push(hash);
  }
  return hits;
}

export function rawFontSizeValue(line) {
  const m = FONT_SIZE_RE.exec(line);
  if (!m) return null;
  const value = m[2].trim();
  if (/^var\(/.test(value)) return null;
  return value;
}

// One violation per offending construct, keyed by file + trimmed line so
// the baseline survives line-number shifts. Returns Map<key, count>.
export function scanTree(cssRoot = join(root, "src")) {
  const counts = new Map();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".css")) continue;
      const rel = relative(root, full).split(sep).join("/");
      const lines = readFileSync(full, "utf8").split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("/*") || line.startsWith("//")) continue;
        const n = hexHits(rawLine).length + (rawFontSizeValue(rawLine) !== null ? 1 : 0);
        if (n > 0) {
          const key = `${rel} ::: ${line}`;
          counts.set(key, (counts.get(key) ?? 0) + n);
        }
      }
    }
  };
  if (statSync(cssRoot, { throwIfNoEntry: false })) walk(cssRoot);
  return counts;
}

export function loadBaseline() {
  const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return new Map(Object.entries(data.entries));
}

// Returns { added: string[], removed: string[] } comparing current counts
// against the baseline. Empty added+removed means the tree is clean.
export function diffAgainstBaseline(current, baseline) {
  const added = [];
  const removed = [];
  for (const [key, count] of current) {
    if ((baseline.get(key) ?? 0) < count) added.push(`${key} (x${count})`);
  }
  for (const [key] of baseline) {
    if (!current.has(key)) removed.push(key);
  }
  return { added, removed };
}

function main() {
  const capture = process.argv.includes("--capture");
  const current = scanTree();
  if (capture) {
    let old = new Map();
    try {
      old = loadBaseline();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const { added, removed } = diffAgainstBaseline(current, old);
    const entries = Object.fromEntries([...current.entries()].sort());
    const payload = {
      _comment:
        "D-fo-6 step 1 ratchet baseline. NEVER add NEW entries here — new raw " +
        "hex colors or font-size declarations must use design tokens instead. " +
        "Remove entries only when the corresponding violation is fixed out of " +
        "the CSS tree.",
      entries,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n");
    console.log(`baseline captured: ${current.size} distinct violating lines`);
    if (added.length > 0) console.log(`newly captured (review!):\n  ${added.join("\n  ")}`);
    if (removed.length > 0) console.log(`pruned:\n  ${removed.join("\n  ")}`);
    return;
  }
  const baseline = loadBaseline();
  const { added, removed } = diffAgainstBaseline(current, baseline);
  let failed = false;
  if (added.length > 0) {
    failed = true;
    console.error(
      `design-token ratchet: ${added.length} NEW raw hex color / font-size violation(s). ` +
        `Use a design token (var(--...)) or a type-scale class instead:\n  ${added.join("\n  ")}`
    );
  }
  if (removed.length > 0) {
    failed = true;
    console.error(
      `design-token ratchet: ${removed.length} baseline entr(ies) no longer violated — ` +
        `prune them with: node scripts/lint-design-tokens.mjs --capture\n  ${removed.join("\n  ")}`
    );
  }
  if (!failed) console.log(`design-token ratchet: clean (${current.size} grandfathered lines, 0 new)`);
  process.exit(failed ? 1 : 0);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
