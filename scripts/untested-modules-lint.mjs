// Untested-server-module lint (plan task T1).
// Lists server/*.mjs modules with zero references from tests/ and fails if a
// NEW module joins the untested set, or if the grandfather list still names a
// module that is now tested (the list only shrinks). Run: node scripts/untested-modules-lint.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GRANDFATHERED = [
  // Captured 2026-09-25 (15 modules). Remove entries as tests land; never add.
  "agent-key-registry.mjs",
  "bounty-escrow-routes.mjs",
  "channel-adapters/telegram-rotation.mjs",
  "gmail-content.mjs",
  "inbox-collab-routes.mjs",
  "inbox-collab-store.mjs",
  "ip-blocklist.mjs",
  "mcp-arg-errors.mjs",
  "mcp-discovery.mjs",
  "mcp-full-profile.mjs",
  "mcp-hosted-tools.mjs",
  "members-directory.mjs",
  "quarantine-thread-splits.mjs",
  "sla-breach-journal.mjs",
  "vendor/gmail-html-sanitizer.mjs"
];

const serverDir = join(root, "server");
const testDir = join(root, "tests");
const modules = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".mjs")) modules.push(relative(serverDir, full));
  }
};
walk(serverDir);

const haystack = readdirSync(testDir)
  .filter(name => name.endsWith(".test.js"))
  .map(name => readFileSync(join(testDir, name), "utf8"))
  .join("\n");

const untested = modules.filter(name => !haystack.includes(name.replace(/\.mjs$/, "")));
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
