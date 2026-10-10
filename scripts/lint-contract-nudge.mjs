// scripts/lint-contract-nudge.mjs — FIX-44 (wave300): an ADVISORY nudge against
// defensive `??` / `?.` on internal claim-contract fields.
//
// Philosophy (see CONTRIBUTING.md "Contract-field lint nudge"): a defensive
// `item.files ?? []` at a call site silently masks contract drift — when the
// producer changes the shape of a claim record, every consumer with a fallback
// keeps "working" on wrong data instead of failing loudly (COLLIDE-4 exp 3).
// The nudge asks for explicit shape validation ONCE at the module boundary
// (e.g. `if (!Array.isArray(item.files)) throw ...`), then trusting the shape
// downstream — drift fails fast and loudly at the boundary instead of being
// papered over at every use site.
//
// This is a NUDGE, not a rule: it exits 0 always, so `npm run lint` and CI
// never fail because of it. Pass --strict for a failing mode (humans only).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

// Internal claim-contract fields recent wave-300 work added/kept. Bare
// identifiers are NOT matched (no type info) — only property accesses like
// `item.files` / `item?.fileBlocks`, where the contract relationship is clear.
const CONTRACT_FIELDS = [
  "files", "fileBlocks", "attestations", "reviews", "state",
  "owner", "epoch", "checkpoint", "last_progress", "blockedAttempts",
];
const FIELD_ALT = CONTRACT_FIELDS.join("|");
const OPT_CHAIN_RE = new RegExp(`\\?\\.\\s*(${FIELD_ALT})\\b`);
const PROP_ACCESS_RE = new RegExp(`(?:\\.|\\?\\.)\\s*(${FIELD_ALT})\\b`);

// Strip trailing `//` comments, quote-aware, so commented-out code and URLs
// don't warn. String contents are left intact (advisory; rare noise is fine).
function stripComment(line) {
  let out = "";
  let q = null; // ', ", or `
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      out += c;
      if (c === "\\") { out += line[i + 1] ?? ""; i++; }
      else if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === "`") {
      q = c; out += c;
    } else if (c === "/" && line[i + 1] === "/") {
      break;
    } else {
      out += c;
    }
  }
  return out;
}

function scanFile(path) {
  const warnings = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i]);
    const chain = OPT_CHAIN_RE.exec(code);
    if (chain) {
      warnings.push({ line: i + 1, kind: "?.", field: chain[1], text: lines[i].trim() });
      continue; // one nudge per line is enough
    }
    if (code.includes("??")) {
      const prop = PROP_ACCESS_RE.exec(code);
      if (prop) warnings.push({ line: i + 1, kind: "??", field: prop[1], text: lines[i].trim() });
    }
  }
  return warnings;
}

function collectFiles(targets) {
  const files = [];
  for (const t of targets) {
    const abs = resolve(root, t);
    let st;
    try { st = statSync(abs); } catch { console.error(`lint-contract-nudge: not found: ${t}`); continue; }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (name.endsWith(".mjs")) files.push(join(abs, name));
      }
    } else if (abs.endsWith(".mjs")) {
      files.push(abs);
    }
  }
  return files;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`usage: node scripts/lint-contract-nudge.mjs [path...] [--strict]

Advisory nudge: warns about defensive ?? / ?. on internal claim-contract
fields (${CONTRACT_FIELDS.join(", ")}) in server/*.mjs, suggesting explicit
shape validation at module boundaries instead. Always exits 0 (nudge, not a
gate); --strict exits 1 when warnings are found. See CONTRIBUTING.md.`);
  process.exit(0);
}
const strict = args.includes("--strict");
const targets = args.filter(a => !a.startsWith("-"));
const files = collectFiles(targets.length ? targets : ["server"]);

let total = 0;
for (const f of files) {
  for (const w of scanFile(f)) {
    total++;
    const rel = relative(root, f);
    console.log(
      `WARNING ${rel}:${w.line}: defensive \`${w.kind}\` on internal contract field '${w.field}' — ` +
      `prefer explicit shape validation at the module boundary instead of a fallback.`
    );
  }
}
console.log(
  `lint-contract-nudge: ${total} advisory warning(s) — nudge only, never a failure ` +
  `(run with --strict to fail on warnings).`
);
process.exit(strict && total > 0 ? 1 : 0);
