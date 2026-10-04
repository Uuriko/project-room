// Design-token ratchet lint (D-fo-6 step 1).
// Fails CI when a NEW raw hex color literal, a NEW raw `font-size:`
// declaration, or a NEW raw size smuggled through the `font:` shorthand
// appears in the CSS tree. Everything that exists today is
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
// colon, paren, comma, whitespace, `=` (data-URI `fill=#ff0000`), or line
// start. This deliberately does NOT match ID selectors (e.g. `#action-dialog`)
// which have no value context — and the tree contains none that are hex-shaped
// anyway. SEC2: `=` added 2026-10-04 after a second-pass showed
// `fill=#ff0000` inside url("data:...") slipped the value-context class.
const HEX_RE = /(^|[:\s,(=])#[0-9a-fA-F]{3,8}\b/g;
// A raw `font-size:` declaration: the value is a literal (16px, .875rem)
// rather than a design token. `font-size: var(--text-sm)` is the sanctioned
// token path and is NOT a violation. Custom property definitions
// (`--font-size:`) are the token mechanism itself and are excluded, as is
// `font-size-adjust:`. SEC2: the `i` flag added 2026-10-04 — CSS property
// names are case-insensitive, so `FONT-SIZE: 16px` evaded the ratchet.
const FONT_SIZE_RE = /(^|[\s{;])font-size\s*:\s*([^;}{]+)/i;
// A raw size smuggled through the `font:` shorthand
// (e.g. `font: 16px/1.5 sans-serif` sets a font-size with no `font-size:`
// declaration). SEC2: added 2026-10-04 after a second-pass showed the
// shorthand bypassed the ratchet entirely.
const FONT_SHORTHAND_RE = /(^|[\s{;])font\s*:\s*([^;}{]+)/i;
// Any dimension token (length or percentage) — the signature of a raw size.
const DIMENSION_RE = /\d*\.?\d+(px|rem|em|ex|ch|lh|vw|vh|vmin|vmax|vb|vi|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|cqmin|cqmax|pt|pc|in|cm|mm|q|%)/i;
// Absolute-size keywords also set a raw size (the `font-size:` path already
// flags any non-var() value, keywords included). Hyphen-aware boundaries so
// `small-caps` (a font-variant, not a size) does not match.
const ABSOLUTE_SIZE_RE =
  /(?<![\w-])(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?![\w-])/i;

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

// A raw size set through the `font:` shorthand. `font: inherit` and the
// system-font keywords (caption, icon, menu, ...) carry no size and are not
// violations; `var(--...)` is the token path.
export function rawFontShorthandValue(line) {
  const m = FONT_SHORTHAND_RE.exec(line);
  if (!m) return null;
  const value = m[2].trim();
  if (/^var\(/i.test(value)) return null;
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value)) return null;
  if (/^(caption|icon|menu|message-box|small-caption|status-bar)$/i.test(value)) return null;
  const sized = DIMENSION_RE.exec(value) ?? ABSOLUTE_SIZE_RE.exec(value);
  return sized ? sized[0] : null;
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
        const n = hexHits(rawLine).length + (rawFontSizeValue(rawLine) !== null ? 1 : 0)
          + (rawFontShorthandValue(rawLine) !== null ? 1 : 0);
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
