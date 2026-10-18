// Untested-server-module lint (plan task T1).
// Lists server/*.mjs modules with zero references from tests/ and fails if a
// NEW module joins the untested set, or if the grandfather/waiver lists still
// name a module that is now tested (the lists only shrink). Run: node scripts/untested-modules-lint.mjs
//
// F-33 (2026-10-18, charter C-10): a module counts as tested only when a test
// file DIRECTLY imports it — a real import specifier resolving to it (static
// import/export, bare or dynamic import(), new URL() source reads). The old
// path-anchored reference counting (the exact `server/<rel>` token appearing
// anywhere in a test file, e.g. a comment saying a module is covered via the
// HTTP boundary) no longer counts: a mention is not a test. Modules that are
// deliberately covered only at the HTTP boundary are recorded in WAIVED below
// with the reason and the covering tests named — a waiver is a decision on
// the record, not a mention in a costume.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const GRANDFATHERED = [
  // Captured 2026-09-25 (15 modules). Remove entries as tests land; never add
  // NEW modules here.
  "agent-key-registry.mjs",
  "gmail-content.mjs",
  "inbox-collab-routes.mjs",
  "ip-blocklist.mjs",
  "members-directory.mjs",
  "quarantine-thread-splits.mjs",
  "sla-breach-journal.mjs",
  "vendor/gmail-html-sanitizer.mjs",
  // 2026-09-30 (M-57): the old substring check falsely counted these as
  // tested (e.g. needle "activity" matching "activity-feed"). They predate
  // the gate and are covered via HTTP-boundary tests; recording them here
  // corrects the baseline so the now-precise check does not flag legacy
  // modules as new gaps. Still never add NEW modules.
  "request-runs.mjs"
];

// F-33 waivers (2026-10-18): modules the tightened lint finds untested that
// carry no direct test BY DECISION. Each row names the module and the real
// reason: what surface the module has, and which tests cover it at the HTTP
// boundary. A waiver whose module gains a direct test goes stale and fails
// this lint — remove the row when a direct test lands, exactly like the
// grandfather list. Never add a row without a reason that names the
// covering tests.
export const WAIVED = [
  { module: "agent-invites.mjs",
    reason: "Store-bound invite service (imports the RoomStore surface from store.mjs); every method runs SQL and appends room events, so there is no importable pure surface. Covered at the HTTP boundary by tests/agent-invites-mail-unconfigured.test.js (createRoomServer) and the invite-flow tests." },
  { module: "buyer-signoff.mjs",
    reason: "SQL rail state machine (open/submitted/under_review/changes_requested/accepted/cancelled) built on trial-task-store; its transitions are exercised end-to-end through the record-rails routes by tests/buyer-offer-http.test.js and tests/demigod-boundary.test.js." },
  { module: "demigod-contracts.mjs",
    reason: "SQL rail state machine on trial-task-store; the contract lifecycle (pending/active/completed/terminated) is exercised end-to-end through the record-rails routes by tests/buyer-offer-http.test.js and tests/demigod-boundary.test.js." },
  { module: "demigod-offers.mjs",
    reason: "SQL rail state machine on trial-task-store; the offer lifecycle and fee-policy application are exercised end-to-end through the record-rails routes by tests/buyer-offer-http.test.js and tests/demigod-boundary.test.js." },
  { module: "next-actions-routes.mjs",
    reason: "Route-handler factory: it returns a closure handler over a store-backed NextActions service (next-actions.mjs imports store.mjs) and exports no importable pure surface. Its routes are exercised at the HTTP boundary by tests/next-actions.test.js, tests/developer-contract.test.js and tests/invite-only-boundary.test.js." },
  { module: "operator-routes.mjs",
    reason: "Thin route factory wiring operator-auth (direct-tested in tests/untested-modules-direct.test.js), operator-purge, operator-status and operator-actions; the operator surface itself is exercised at the HTTP boundary by tests/operator-purge.test.js." },
  { module: "project-offers.mjs",
    reason: "Store/SQL-backed offers service class; its behaviour is covered by tests/project-offers.test.js and tests/project-offers-http.test.js, which drive it through RoomStore and the HTTP routes." },
  { module: "referrals.mjs",
    reason: "Store/SQL-backed referral service class (imports PILOT_LIMITS from store.mjs); mint/settle behaviour is covered by tests/referrals.test.js, tests/referral-invites.test.js and tests/referral-board.test.js." },
  { module: "work-wakes.mjs",
    reason: "Store/event-backed wake-queue service class; wake recording and delivery behaviour are covered at the boundary by tests/agent-heartbeats.test.js and tests/pull-only-heartbeat-wakes.test.js." }
];

// A module counts as tested when a test file contains a real import
// specifier resolving to it (static import/export, bare or dynamic import(),
// new URL() source reads). F-33: nothing else counts — in particular a
// path-anchored mention of `server/<rel>` in prose or comments does not.
// M-57 history: the pre-2026-09 check `haystack.includes(name sans .mjs)`
// counted "activity" as tested because a test mentioned "activity-feed", and
// "prefix" because of "prefix-extended"; the M-57 fix narrowed counting to
// real specifiers plus path-anchored mentions, and F-33 removes the mention
// half so only direct imports remain.
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

  // Real import specifiers, resolved against the tests/ dir.
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

  const untested = modules.filter(name => !imported.has(name));
  return { modules, untested };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { modules, untested } = findUntested(join(root, "server"), join(root, "tests"));
  const waivedNames = WAIVED.map(w => w.module);
  const badWaivers = WAIVED.filter(w =>
    !w.module || !w.module.endsWith(".mjs") ||
    typeof w.reason !== "string" || w.reason.trim().length < 20 ||
    waivedNames.indexOf(w.module) !== waivedNames.lastIndexOf(w.module) ||
    GRANDFATHERED.includes(w.module));
  if (badWaivers.length > 0) {
    console.error("Waiver rows must name a module once, stay out of the grandfather list, and carry a real reason (the covering tests named):");
    for (const w of badWaivers) console.error(`  ${w.module || "(unnamed)"}`);
    process.exit(1);
  }
  const fresh = untested.filter(name => !GRANDFATHERED.includes(name) && !waivedNames.includes(name));
  const stale = [...GRANDFATHERED, ...waivedNames].filter(name => !untested.includes(name));

  if (stale.length > 0) {
    console.error("Grandfather/waiver lists must shrink - these modules now have direct test imports:");
    for (const name of stale) console.error(`  ${name}`);
  }
  if (fresh.length > 0) {
    console.error("New server modules without any direct test import (add a direct test, or record an explicit waiver with a reason in WAIVED - do not extend the grandfather list):");
    for (const name of fresh) console.error(`  ${name}`);
  }
  if (fresh.length > 0 || stale.length > 0) process.exit(1);
  console.log(`ok - ${modules.length} server modules, ${untested.length} untested (${GRANDFATHERED.length} grandfathered, ${waivedNames.length} waived), no new untested modules`);
}
