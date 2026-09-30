// Untested-server-module lint (plan task T1).
// Lists server/*.mjs modules with zero references from tests/ and fails if a
// NEW module joins the untested set, or if the grandfather list still names a
// module that is now tested (the list only shrinks). Run: node scripts/untested-modules-lint.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GRANDFATHERED = [
  // Captured 2026-09-25 (15 modules). Remove entries as tests land; never add
  // NEW modules here.
  "agent-key-registry.mjs",
  "bounty-escrow-routes.mjs",
  "channel-adapters/telegram-rotation.mjs",
  "gmail-content.mjs",
  "inbox-collab-routes.mjs",
  "inbox-collab-store.mjs",
  "ip-blocklist.mjs",
  "mcp-arg-errors.mjs",
  "members-directory.mjs",
  "quarantine-thread-splits.mjs",
  "sla-breach-journal.mjs",
  "vendor/gmail-html-sanitizer.mjs",
  // 2026-09-30 (M-57): the old substring check falsely counted these as
  // tested (e.g. needle "activity" matching "activity-feed"). They predate
  // the gate and are covered via HTTP-boundary tests; recording them here
  // corrects the baseline so the now-precise check does not flag legacy
  // modules as new gaps. Still never add NEW modules.
  "activity.mjs",
  "agent-invites.mjs",
  "attention.mjs",
  "conversation-sync.mjs",
  "human-push.mjs",
  "inbox-attachment-bytes.mjs",
  "opportunities.mjs",
  "project-offers.mjs",
  "request-runs.mjs",
  "return-brief.mjs",
  "share-links.mjs",
  "work-help.mjs"
];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A module counts as referenced when a test file contains a real import
// specifier resolving to it (static import/export, bare or dynamic import(),
// new URL() source reads) or a path-anchored reference — the exact token
// `server/<rel>` (optionally `../`-prefixed), not a substring. M-57: the old
// `haystack.includes(name sans .mjs)` counted "activity" as tested because a
// test mentioned "activity-feed", and "prefix" because of "prefix-extended".
export function findUntested(serverDir, testDir) {
  const modules = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) modules.push(relative(serverDir, full).split(sep).join("/"));
    }
  };
  walk(serverDir);

  const sources = readdirSync(testDir)
    .filter(name => name.endsWith(".test.js"))
    .map(name => readFileSync(join(testDir, name), "utf8"));

  // 1. Real import specifiers, resolved against the tests/ dir.
  const specifiers = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]);
    for (const m of src.matchAll(/(?<![\w$])import\s*\(\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]);
    for (const m of src.matchAll(/(?<![\w$])import\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]);
    for (const m of src.matchAll(/new URL\(\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]);
  }
  const imported = new Set();
  for (const spec of specifiers) {
    if (!spec.startsWith(".")) continue;
    const rel = relative(serverDir, resolve(testDir, spec)).split(sep).join("/");
    if (!rel.startsWith("..") && !rel.startsWith("/")) imported.add(rel);
  }

  // 2. Path-anchored references: the exact `server/<rel>` token.
  const haystack = sources.join("\n");
  const anchored = rel =>
    new RegExp(`(?<![\\w./-])(?:\\.\\./)?server/${esc(rel)}(?!\\.\\w|[\\w/-])`).test(haystack);

  const untested = modules.filter(name => !imported.has(name) && !anchored(name));
  return { modules, untested };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { modules, untested } = findUntested(join(root, "server"), join(root, "tests"));
  const fresh = untested.filter(name => !GRANDFATHERED.includes(name));
  const stale = GRANDFATHERED.filter(name => !untested.includes(name));

  if (stale.length > 0) {
    console.error("Grandfather list must shrink - these modules now have test references:");
    for (const name of stale) console.error(`  ${name}`);
  }
  if (fresh.length > 0) {
    console.error("New server modules without any test reference (add tests, do not extend the grandfather list):");
    for (const name of fresh) console.error(`  ${name}`);
  }
  if (fresh.length > 0 || stale.length > 0) process.exit(1);
  console.log(`ok - ${modules.length} server modules, ${untested.length} grandfathered-untested, no new untested modules`);
}
