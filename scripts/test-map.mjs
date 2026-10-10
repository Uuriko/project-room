// Test naming and ownership map (backlog TST-15).
// Maps every tests/*.test.{js,mjs} file to the source modules it references
// and to one lane. A reference is an import specifier or a quoted path that
// resolves to a file under server/, cloudflare/, src/ or scripts/.
// The primary module is the referenced module whose name shares the most
// leading words with the test name. The lane comes from the primary module
// path (LANES below). The report also lists naming drift: tests whose name
// shares no word with any referenced module, and tests that reference no
// source module. Report only: exit 0 always, and no CI check. Naming drift is a hint, not a rename list.
//
// Usage:
//   node scripts/test-map.mjs                  # summary
//   node scripts/test-map.mjs --json           # machine-readable (room.test-map/1)
//   node scripts/test-map.mjs --write docs/TEST-MAP.md
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA = "room.test-map/1";
const SOURCE_DIRS = ["server", "cloudflare", "src", "scripts"];
const toPosix = p => p.split(sep).join("/");

// First matching rule wins. Order matters: specific before general.
export const LANES = Object.freeze([
  ["economy-shelved", /^server\/(bounty|escrow|settlement|credit|spend|budget)/],
  ["mcp", /^server\/(mcp|room-mcp|tool)/],
  ["work-claims", /^server\/(work-claim|claim|board|land|wants-work|code-drop|pr-)/],
  ["agents", /^server\/(agent|wake|host|reply-agent|fleet|squad|bond|peer)/],
  ["inbox", /^server\/(inbox|gmail|mail|vendor\/gmail)/],
  ["identity-access", /^server\/(account|auth|oauth|session|invitation|invite|guest|access|member|desktop-auth|magic)/],
  ["public", /^server\/(public|directory|opportunit|project-offer|report)/],
  ["api-routes", /^server\/(routes\/|http|dispatch|openapi|rate)/],
  ["store-data", /^server\/(store|journal|channel|retention|backup|integrity|projection|migration|sqlite)/],
  ["platform", /^cloudflare\//],
  ["ui", /^src\//],
  ["tooling", /^scripts\//],
  ["core", /^server\//],
]);

// Entry points that many tests load to drive the app end to end. They do not
// say which feature a test covers, so they never decide the primary module.
// A test that references only hubs gets its lane from its own name.
export const HUBS = Object.freeze(new Set(["server/http.mjs", "server/bootstrap.mjs", "scripts/acceptance-fixture.mjs", "src/app.js", "src/events.js"]));
const isHub = mod => HUBS.has(mod) || mod.startsWith("scripts/helpers/");

export function laneFor(modulePath) {
  for (const [lane, rule] of LANES) if (rule.test(modulePath)) return lane;
  return "unassigned";
}

const words = name => basename(name).replace(/\.(test|check)?\.?(m?js|ts)$/, "").replace(/\.(m?js)$/, "").split(/[-_.]/).filter(Boolean);

export function sharedLead(a, b) {
  const x = words(a), y = words(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

// Two names overlap when they share a leading word, or a word of 4+ letters
// where one is a prefix of the other ("account" and "accounts").
export function namesOverlap(a, b) {
  if (sharedLead(a, b) > 0) return true;
  const x = words(a).filter(w => w.length >= 4), y = words(b).filter(w => w.length >= 4);
  return x.some(u => y.some(v => u.startsWith(v) || v.startsWith(u)));
}

export function referencedModules(testFile, text, root = ROOT) {
  const found = new Set();
  const testDir = dirname(testFile);
  const candidates = [];
  for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)["'`]([^"'`]+)["'`]/g)) candidates.push(resolve(testDir, m[1]));
  for (const m of text.matchAll(/["'`]((?:\.\.\/)?(?:server|cloudflare|src|scripts)\/[\w./-]+\.(?:mjs|js|cjs))["'`]/g)) {
    candidates.push(m[1].startsWith("..") ? resolve(testDir, m[1]) : resolve(root, m[1]));
  }
  for (const abs of candidates) {
    const rel = toPosix(relative(root, abs));
    if (!SOURCE_DIRS.some(d => rel.startsWith(`${d}/`))) continue;
    if (existsSync(abs)) found.add(rel);
  }
  return [...found].sort();
}

export function buildMap(root = ROOT) {
  const testsDir = join(root, "tests");
  const files = readdirSync(testsDir).filter(f => /\.test\.(m?js)$/.test(f)).sort();
  const quarantine = existsSync(join(testsDir, "quarantine.json")) ? JSON.parse(readFileSync(join(testsDir, "quarantine.json"), "utf8")).quarantined ?? [] : [];
  const rows = files.map(file => {
    const path = join(testsDir, file);
    const modules = referencedModules(path, readFileSync(path, "utf8"), root);
    const specific = modules.filter(mod => !isHub(mod));
    let primary = null, best = -1;
    for (const mod of specific) {
      const score = sharedLead(file, mod) * 10 + (mod.startsWith("server/") ? 2 : mod.startsWith("cloudflare/") ? 1 : 0);
      if (score > best) { best = score; primary = mod; }
    }
    const via = specific.length ? "module" : modules.length ? "hub" : "none";
    const lane = primary ? laneFor(primary) : via === "hub" ? laneFor(`server/${words(file).join("-")}`) : "unassigned";
    const nameMatch = specific.length ? specific.some(mod => namesOverlap(file, mod)) : null;
    const owners = [...new Set(quarantine.filter(q => String(q.test ?? "").startsWith(`tests/${file}`)).map(q => q.owner))];
    return { test: `tests/${file}`, primary, via, lane, modules, nameMatch, quarantineOwners: owners };
  });
  const lanes = {};
  for (const r of rows) lanes[r.lane] = (lanes[r.lane] ?? 0) + 1;
  return {
    schema: SCHEMA,
    tests: rows.length,
    lanes: Object.fromEntries(Object.entries(lanes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    hubOnly: rows.filter(r => r.via === "hub").length,
    noSourceReference: rows.filter(r => r.modules.length === 0).map(r => r.test),
    namingDrift: rows.filter(r => r.nameMatch === false).map(r => r.test),
    rows,
  };
}

export function renderMarkdown(map) {
  const out = [];
  out.push("# Test map (generated)", "");
  out.push("> Generated by `node scripts/test-map.mjs --write docs/TEST-MAP.md`. Do not edit by hand.", "");
  out.push(`This map links each of the ${map.tests} test files in \`tests/\` to the source modules it references and to one lane.`);
  out.push("The lane comes from the primary module path. The primary module is the referenced module whose name shares the most leading words with the test name.");
  out.push(`Hub modules (${[...HUBS].join(", ")}, scripts/helpers/) never decide the primary module. ${map.hubOnly} tests reference only hubs: they drive the app end to end, and their lane comes from the test name.`);
  out.push("Use it to find the tests for a module before you change it, and to find who to ask about a lane.", "");
  out.push("## Lanes", "", "| Lane | Tests |", "|---|---|");
  for (const [lane, n] of Object.entries(map.lanes)) out.push(`| ${lane} | ${n} |`);
  out.push("", `## Naming drift (${map.namingDrift.length})`, "", "The test name shares no word with any module it references. Rename the test or split it.", "");
  for (const t of map.namingDrift) out.push(`- \`${t}\``);
  out.push("", `## No source reference (${map.noSourceReference.length})`, "", "The test references no file under server/, cloudflare/, src/ or scripts/ by import or quoted path. It may test through HTTP or a fixture only.", "");
  for (const t of map.noSourceReference) out.push(`- \`${t}\``);
  out.push("", "## Map", "", "| Test | Lane | Primary module | Other modules |", "|---|---|---|---|");
  for (const r of map.rows) {
    const others = r.modules.filter(m => m !== r.primary);
    const shown = others.slice(0, 4).map(m => `\`${m}\``).join(", ") + (others.length > 4 ? ` +${others.length - 4}` : "");
    out.push(`| \`${r.test.replace(/^tests\//, "")}\` | ${r.lane} | ${r.primary ? `\`${r.primary}\`` : r.via === "hub" ? "(end to end)" : "none"} | ${shown} |`);
  }
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const map = buildMap();
  const w = args.indexOf("--write");
  if (w >= 0) { writeFileSync(resolve(args[w + 1] ?? "docs/TEST-MAP.md"), renderMarkdown(map)); }
  if (args.includes("--json")) console.log(JSON.stringify(map, null, 2));
  else console.log(`test-map: ${map.tests} tests, lanes ${Object.entries(map.lanes).map(([k, v]) => `${k}=${v}`).join(" ")}, hub-only ${map.hubOnly}, naming drift ${map.namingDrift.length}, no source reference ${map.noSourceReference.length}`);
}
