// FIX-36 (WAVE-300 ranked-fixes burn-down): CI duplicate-key gate for JSON configs.
//
// JSON.parse silently keeps the LAST value of a duplicated key, so a clean
// merge that repeats an i18n key in two branches passes every existing test
// while silently dropping a string (COLLIDE-3 case 2c — the only silent
// textual hole). This gate tokenizes each authoritative JSON config with a
// duplicate-key-detecting scanner and fails loudly, naming every duplicated
// key. Wired into `npm run check` via scripts/check.mjs (the CI contract job).
//
// Usage:
//   node scripts/json-dupkey-check.mjs            # scan the curated repo list
//   node scripts/json-dupkey-check.mjs --list     # also print scanned files
//   node scripts/json-dupkey-check.mjs a.json b  # scan explicit paths
//
// Adding a config: append its repo-relative path to AUTHORITATIVE below.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Authoritative JSON configs (surveyed 2026-10-09): the strings catalog that
// feeds strings/en.js and the i18n harness, plus the JSON configs CI and the
// runtime treat as source of truth. Deliberately NOT a repo-wide glob: fuzz
// corpora and fixtures may contain hostile JSON on purpose.
const AUTHORITATIVE = [
  "strings/en.json",
  "strings/i18n-baseline.json",
  "strings/i18n-scope.json",
  "package.json",
  "server.json",
  "coverage-thresholds.json",
  "scripts/design-tokens-baseline.json",
  "scripts/routes-legacy-allowlist.json",
  "scripts/openapi-served-exclusions.json",
  "server/session-adapter/pinned-herdr.json",
  "machine/versions.json",
  "github-app/manifest.json",
  "plugins/project-room/plugin.json",
  "plugins/project-room/hooks/hooks.json",
  "plugins/project-room/.mcp.json",
  "plugins/project-room/skills/project-room-host-router/hosts.json",
  "plugins/project-room/.claude-plugin/plugin.json",
  "skills/project-room-host-router/hosts.json",
  ".claude-plugin/marketplace.json",
  "docs/listings.json",
  "docs/CANDIDATE-MANIFEST.json",
  "docs/answer-engine-prompts.json",
  "docs/legal/subprocessors.json",
  "docs/onboarding-probe/baseline.json",
  "docs/examples/next-actions.example.json",
  "tests/merge-queue-eject-budget.json",
  "tests/quarantine.json",
];

/**
 * Scan JSON text for keys repeated inside the SAME object. Returns one entry
 * per duplicated key: { path, key, line, count }. Sibling objects may reuse a
 * name freely — only same-scope repeats count.
 */
export function findDuplicateKeys(text) {
  const dupes = [];
  const seen = new Map(); // scopeId -> Map(key -> {line, count})
  let scopeId = 0;
  const scopes = []; // { id, kind: 'obj'|'arr', expectKey }
  const path = []; // object key names; arrays push a '[]' marker
  let pendingKey = null; // key name whose value is being scanned
  let i = 0;
  let line = 1;
  const n = text.length;

  const readString = () => {
    // i points at the opening quote; returns the decoded string.
    let out = "";
    i++; // skip opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[e] ?? e ?? "";
          i += 2;
        }
        continue;
      }
      if (c === '"') { i++; return out; }
      if (c === "\n") line++;
      out += c;
      i++;
    }
    throw new Error("unterminated string");
  };

  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) { if (text[i] === "\n") line++; i++; }
  };

  const top = () => scopes[scopes.length - 1];

  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      const keyLine = line;
      const s = readString();
      const t = top();
      if (t && t.kind === "obj" && t.expectKey) {
        skipWs();
        if (text[i] !== ":") throw new Error(`expected ':' after object key at line ${keyLine}`);
        const scopeSeen = seen.get(t.id);
        const prev = scopeSeen.get(s);
        if (prev) {
          prev.count++;
          if (!prev.dupe) {
            prev.dupe = { path: [...path, s].join("."), key: s, line: keyLine, count: 2 };
            dupes.push(prev.dupe);
          } else {
            prev.dupe.count = prev.count;
          }
        } else {
          scopeSeen.set(s, { line: keyLine, count: 1, dupe: null });
        }
        t.expectKey = false;
        i++; // consume ':'
        pendingKey = s;
      } else {
        pendingKey = null; // a string value; not a key
      }
      continue;
    }
    if (c === "{") {
      const enclosing = top();
      scopeId++;
      const pushed = !!enclosing;
      scopes.push({ id: scopeId, kind: "obj", expectKey: true, pushed });
      seen.set(scopeId, new Map());
      if (pushed) path.push(enclosing.kind === "arr" ? "[]" : (pendingKey ?? ""));
      pendingKey = null;
      i++;
      continue;
    }
    if (c === "[") {
      const enclosing = top();
      scopeId++;
      const pushed = !!enclosing;
      scopes.push({ id: scopeId, kind: "arr", pushed });
      if (pushed) path.push(pendingKey !== null ? `${pendingKey}[]` : "[]");
      pendingKey = null;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      const t = scopes.pop();
      if (!t || (c === "}" ? t.kind !== "obj" : t.kind !== "arr")) {
        throw new Error(`mismatched '${c}' at line ${line}`);
      }
      seen.delete(t.id);
      if (t.pushed) path.pop();
      pendingKey = null;
      i++;
      continue;
    }
    if (c === ",") {
      const t = top();
      if (t && t.kind === "obj") t.expectKey = true;
      pendingKey = null;
      i++;
      continue;
    }
    if (c === ":") { pendingKey = null; i++; continue; }
    // Numbers, true/false/null: no structural meaning, skip.
    i++;
  }
  if (scopes.length) throw new Error("unexpected end of input");
  return dupes;
}

function checkFile(absPath, relPath) {
  const text = readFileSync(absPath, "utf8");
  // Validity first: a syntax error is also a gate failure.
  try { JSON.parse(text); }
  catch (e) { return [`${relPath}: invalid JSON: ${e.message}`]; }
  return findDuplicateKeys(text).map(
    (d) => `${relPath}: duplicate key '${d.key}' at ${d.path} (line ${d.line}, appears ${d.count}x) — JSON.parse silently keeps the last value`
  );
}

const rawArgs = process.argv.slice(2);
const listFiles = rawArgs.includes("--list");
const args = rawArgs.filter((a) => !a.startsWith("--"));
const targets = args.length
  ? args.map((a) => ({ abs: a.startsWith("/") ? a : join(process.cwd(), a), rel: a }))
  : AUTHORITATIVE.map((rel) => ({ abs: join(root, rel), rel }));

let failures = [];
let scanned = 0;
const scannedRels = [];
for (const { abs, rel } of targets) {
  if (!existsSync(abs)) {
    if (!args.length) { console.warn(`json-dupkey-check: skipping missing ${rel}`); continue; }
    failures.push(`${rel}: file not found`);
    continue;
  }
  try {
    failures.push(...checkFile(abs, rel));
    scanned++;
    scannedRels.push(rel);
  } catch (e) {
    failures.push(`${rel}: ${e.message}`);
  }
}

if (failures.length) {
  console.error("json-dupkey-check: DUPLICATE JSON KEYS FOUND\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`json-dupkey-check: ${scanned} file(s) checked, no duplicate keys`);
if (listFiles) for (const rel of scannedRels) console.log(`  - ${rel}`);
