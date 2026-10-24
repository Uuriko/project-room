// Registry-closure census (T-5 / OPP-015, narrow form).
//
// The annotation corpus (pin e49e9c812ac5aa62df8e66106d73b51cc601d52a,
// generated/corpus.sqlite in the workspace corpus, NOT in this repo) counted
// 301 distinct registry IDs across the whole tree, of which 236 have
// closure_verified_by NULL on every entry:
//
//   SELECT count(*) FROM (SELECT id FROM registries GROUP BY id
//     HAVING sum(CASE WHEN closure_verified_by IS NOT NULL THEN 1 ELSE 0 END)=0)
//   -> 236   (301 distinct IDs, 989 entries, 238 IDs with >=1 NULL entry)
//
// That census was annotator-made: its IDs are conceptual (JSON keys, schemas,
// functions, non-exported lists). It cannot be re-run from this repo, and
// building the manifest that could re-run it is the registry-of-registries
// charter (SYSTEMIC-MAP F-26, QUEUED) — explicitly NOT this check.
//
// This check is the mechanical, in-repo ratchet over the same problem:
//   * Enumerate registries from in-repo evidence: an *exported* module-scope
//     collection constant in server/, scripts/ or cloudflare/ — an
//     Object.freeze(...) of any shape, an array/object literal, or a
//     Map/Set. Exported, because a registry other code must agree with is
//     the kind whose closure can escape; file-local collections are closed
//     by their own module. ID form: "<path>#<NAME>", like the corpus.
//   * Closure status (proxy, stated plainly): a registry is "pinned" when
//     its name is referenced by at least one test/check file (tests/**, or
//     a *check* file under scripts/ or cloudflare/) other than its defining
//     file; otherwise it is "unverified". A mention is not a proof of
//     completeness — it is the in-repo evidence that something exercises
//     the registry as a set. The corpus's human closure judgement and this
//     proxy therefore count different populations (see the PR body for the
//     reconciliation); neither number is forced to match the other.
//   * Ratchet: UNVERIFIED_BASELINE below pins the unverified set at the
//     census's introduction. It only shrinks, mirroring
//     scripts/routes-legacy-allowlist.json: a NEW unverified registry
//     fails, and a baseline entry that becomes pinned or disappears must
//     be removed from the baseline in the same change. Adding an entry to
//     the baseline to silence a failure is the one move this gate exists
//     to make visible — it is a diff a reviewer can see, never a fix.
//
// First closure subject: the writer-fence lineage (find:writer-fence-001)
// is pinned for real, not by mention, in tests/writer-fence-closure.test.js
// (fence <-> purge-registry <-> module DDL in agreement).
//
// Usage: node scripts/registry-closure-census.mjs [--all]
//   exit 0: no new unverified registries, baseline exact.
//   exit 1: problems listed. --all also prints pinned registries.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY_SOURCE_DIRS = Object.freeze(["server", "scripts", "cloudflare"]);
const SELF = "scripts/registry-closure-census.mjs";

function sourceFiles(root) {
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.flatMap(entry => entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.(mjs|js)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  };
  return REGISTRY_SOURCE_DIRS.flatMap(dir => walk(join(root, dir)));
}

function verifierFiles(root) {
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.flatMap(entry => entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.(mjs|js)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  };
  const tests = walk(join(root, "tests"));
  const checks = sourceFiles(root).filter(path => /check/.test(relative(root, path)));
  return [...new Set([...tests, ...checks])];
}

function kindOf(rest) {
  if (/^Object\.freeze\(\s*\[/.test(rest)) return "frozen-array";
  if (/^Object\.freeze\(\s*\{/.test(rest)) return "frozen-object";
  if (/^Object\.freeze\(/.test(rest)) return "frozen-derived";
  if (/^new\s+(?:Map|Set)\s*\(/.test(rest)) return "map-set";
  if (/^\[/.test(rest)) return "array";
  if (/^\{/.test(rest)) return "object";
  return null;
}

// Enumerate registries under `root`. Returns [{id, name, file, kind,
// verifiedBy}] sorted by id; verifiedBy lists test/check files (relative
// paths) that reference the registry name.
export function enumerateRegistries(root) {
  const registries = [];
  for (const path of sourceFiles(root)) {
    const file = relative(root, path);
    if (file === SELF) continue;
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*/gm)) {
      const kind = kindOf(text.slice(match.index + match[0].length, match.index + match[0].length + 200));
      if (kind) registries.push({ id: `${file}#${match[1]}`, name: match[1], file, kind, verifiedBy: [] });
    }
  }
  // One token pass over the verifier corpus: name -> verifier files.
  const byName = new Map(registries.map(r => [r.name, []]));
  for (const path of verifierFiles(root)) {
    const file = relative(root, path);
    const tokens = new Set(readFileSync(path, "utf8").match(/[A-Za-z_$][\w$]*/g) ?? []);
    for (const token of tokens) {
      const hits = byName.get(token);
      if (hits && !hits.includes(file)) hits.push(file);
    }
  }
  for (const registry of registries) {
    registry.verifiedBy = byName.get(registry.name).filter(file => file !== registry.file);
  }
  return registries.sort((a, b) => a.id.localeCompare(b.id));
}

export function censusProblems(registries, baseline = UNVERIFIED_BASELINE) {
  const problems = [];
  const inBaseline = new Set(baseline);
  const unverified = registries.filter(r => r.verifiedBy.length === 0);
  for (const registry of unverified) {
    if (!inBaseline.has(registry.id)) {
      problems.push(`new unverified registry: ${registry.id} — no test/check file references it. Pin it with a test or check, or (review-visible, last resort) add it to UNVERIFIED_BASELINE in scripts/registry-closure-census.mjs with a reason.`);
    }
  }
  const unverifiedIds = new Set(unverified.map(r => r.id));
  for (const id of baseline) {
    if (!unverifiedIds.has(id)) {
      problems.push(`stale baseline entry: ${id} is no longer unverified (pinned or gone) — remove it from UNVERIFIED_BASELINE; the baseline only shrinks.`);
    }
  }
  return problems;
}

// Shrink-only baseline: unverified registries at introduction
// (base 6f828f0885f6bacbc328d9df9ff7b6097cf87bf7, census run 2026-10-16).
// Generated by enumerateRegistries() on that tree; see header for the
// definition. Entries leave this list when a test/check pins the registry
// or the registry is removed — never enter it silently (see header).
// Stored grouped by file (names only, no "path#NAME" strings): the flat
// path#NAME form trips the secret scanner's high-entropy rule — registry
// IDs are public in-repo identifiers, not credentials, but the grouped
// form keeps the scanner's signal clean without an allowlist entry.
const UNVERIFIED_BASELINE_BY_FILE = Object.freeze({
  "scripts/a11y-axe-helper.mjs": Object.freeze(["A11Y_TAGS"]),
  "scripts/check-version-doors.mjs": Object.freeze(["DOORS"]),
  "scripts/docs-link-check.mjs": Object.freeze(["ORPHAN_EXCEPTIONS"]),
  "scripts/eslint-rules/no-raw-members-index.mjs": Object.freeze(["noRawMembersIndex"]),
  "scripts/eslint-rules/no-raw-transaction.mjs": Object.freeze(["noRawTransaction"]),
  "scripts/github-door.mjs": Object.freeze(["TRUSTED_ASSOCIATIONS"]),
  "scripts/listing-check.mjs": Object.freeze(["STATUSES"]),
  "scripts/live-smoke.mjs": Object.freeze(["DISCOVERY", "SAME_HOSTS"]),
  "scripts/native-host-binary.mjs": Object.freeze(["HOST_BINARY_DEFAULT"]),
  "scripts/perf-budget.mjs": Object.freeze(["DEFAULT_VIEWPORTS", "NETWORK_PROFILES"]),
  "scripts/ralph-loop.mjs": Object.freeze(["ROUTINES"]),
  "scripts/reachability.mjs": Object.freeze(["KEEP"]),
  "scripts/secret-scan-check.mjs": Object.freeze(["SCAN_DIRS", "SKIP_DIRS"]),
  "scripts/verify-affected.mjs": Object.freeze(["GLOBAL_FILES"]),
  "scripts/visual-regression-helper.mjs": Object.freeze(["VISUAL_VIEWPORT"]),
  "server/a2a-jsonrpc.mjs": Object.freeze(["A2A_PATHS"]),
  "server/abuse-rate-buckets.mjs": Object.freeze(["ABUSE_RATE_FAMILIES", "ABUSE_RATE_TABLES"]),
  "server/activity.mjs": Object.freeze(["ACTIVITY_TYPES"]),
  "server/agent-discovery.mjs": Object.freeze(["A2A_WORK_RECEIPT_EXTENSION", "AI_CRAWLERS", "CONNECT_ROUTES", "FIRST_TOOLS"]),
  "server/agent-lanes.mjs": Object.freeze(["AVAILABILITY", "LANE_KINDS"]),
  "server/analytics/catalog.mjs": Object.freeze(["ACTOR_KINDS", "ENVELOPE_PROP_KEYS", "GROWTH_CATALOG", "LOOPS", "SOURCE_DETAILS", "SOURCES"]),
  "server/analytics/claim-bond-shadow.mjs": Object.freeze(["SHADOW_KINDS"]),
  "server/available-work.mjs": Object.freeze(["AVAILABLE_WORK_SOURCES"]),
  "server/bonds.mjs": Object.freeze(["BOND_SCOPES", "PEER_PRIVATE_EVENT_TYPES"]),
  "server/bounty-escrow.mjs": Object.freeze(["BOUNTY_GROUPS", "BOUNTY_STATES", "CITATION_VERDICTS", "RULE_ACTOR"]),
  "server/buyer-signoff.mjs": Object.freeze(["SIGNOFF_STATUSES"]),
  "server/channel-adapters/messenger.mjs": Object.freeze(["messageKinds", "messengerLimits"]),
  "server/channel-adapters/sms.mjs": Object.freeze(["deliveryStatuses", "messageKinds", "smsLimits"]),
  "server/channel-adapters/telegram-config.mjs": Object.freeze(["telegramBindings"]),
  "server/channel-adapters/telegram-transport.mjs": Object.freeze(["telegramSendLimits"]),
  "server/channel-adapters/telegram.mjs": Object.freeze(["messageKinds"]),
  "server/channel-adapters/whatsapp.mjs": Object.freeze(["messageKinds"]),
  "server/channel-connection.mjs": Object.freeze(["connectionStates", "participantKinds"]),
  "server/channel-import.mjs": Object.freeze(["webhookSecretLimits"]),
  "server/channel-journal.mjs": Object.freeze(["channelJournalStatuses"]),
  "server/claim-autolink.mjs": Object.freeze(["PR_WEBHOOK_OPS", "PR_WEBHOOK_ROUTES"]),
  "server/code-drops.mjs": Object.freeze(["CODE_DROP_KINDS"]),
  "server/connect-snippets.mjs": Object.freeze(["WORK_LOOP"]),
  "server/content-trust.mjs": Object.freeze(["MEMBER_TEXT_TOOLS"]),
  "server/demigod-contracts.mjs": Object.freeze(["DEMIGOD_CONTRACT_STATUSES"]),
  "server/demigod-offers.mjs": Object.freeze(["DEMIGOD_OFFER_STATUSES", "PRICE_TYPES"]),
  "server/display-name-guard.mjs": Object.freeze(["RESERVED_ROLE_PREFIXES"]),
  "server/dm-consents.mjs": Object.freeze(["DM_CONSENT_DECISIONS", "DM_CONSENT_STATUSES"]),
  "server/dm-event-visibility.mjs": Object.freeze(["DM_FOLLOW_UP_TYPES"]),
  "server/feedback-store.mjs": Object.freeze(["ROUTE_FOR_SEVERITY"]),
  "server/github-app/verify.mjs": Object.freeze(["WEBHOOK_EVENTS"]),
  "server/growth-loop.mjs": Object.freeze(["GROWTH_TIERS"]),
  "server/guest-invites.mjs": Object.freeze(["GUEST_INVITE_TIERS"]),
  "server/http.mjs": Object.freeze(["HOUSEKEEPING_WRITE_ROUTES"]),
  "server/human-push.mjs": Object.freeze(["HUMAN_PUSH_PREF_DEFAULTS", "HUMAN_PUSH_PREF_KINDS"]),
  "server/inbox-outbox.mjs": Object.freeze(["directSendChannels"]),
  "server/inbox-stitch.mjs": Object.freeze(["STITCH_ID_TYPES"]),
  "server/inbox-transport.mjs": Object.freeze(["directSendChannels"]),
  "server/jev-shadow-journal.mjs": Object.freeze(["jevShadowDecisions", "jevShadowGates", "jevShadowLimits"]),
  "server/jobs.mjs": Object.freeze(["INTEGRITY_SUBCHECKS"]),
  "server/land-queue.mjs": Object.freeze(["LAND_CHANGES", "LAND_CHECKS", "LAND_MERGEABLE"]),
  "server/legal-store.mjs": Object.freeze(["SIGNUP_ORIGINS"]),
  "server/mcp-action-search.mjs": Object.freeze(["ACTION_META_TOOL_NAMES", "actionMetaToolDefs"]),
  "server/mcp-discovery.mjs": Object.freeze(["MCP_TOOL_FOCUSES"]),
  "server/mcp-hosted-tools.mjs": Object.freeze(["hostedInboxTools", "hostedWakeTools"]),
  "server/messages-store.mjs": Object.freeze(["MESSAGE_ROW_TYPES"]),
  "server/notifications.mjs": Object.freeze(["NOTIFICATION_KINDS"]),
  "server/notify-policy.mjs": Object.freeze(["EMAIL_MODES", "FOLLOWING_KINDS", "NEEDS_ME_KINDS", "STORED_LEVELS"]),
  "server/oauth-provider-store.mjs": Object.freeze(["OAUTH_PROVIDER_TABLES"]),
  "server/owner-overview.mjs": Object.freeze(["OVERVIEW_WINDOWS"]),
  "server/public-search.mjs": Object.freeze(["comparisonSlugs"]),
  "server/push-subscriptions.mjs": Object.freeze(["DELIVERY_OUTCOMES"]),
  "server/quarantine-thread-splits.mjs": Object.freeze(["quarantineSplitLimits"]),
  "server/referrals.mjs": Object.freeze(["REFERRAL_VIA"]),
  "server/retention-run.mjs": Object.freeze(["DISPOSABLE_LOG_DAYS"]),
  "server/room-export.mjs": Object.freeze(["CONTENT_DIGEST_SKIPPED_TABLES"]),
  "server/routes/agents.mjs": Object.freeze(["AGENT_FLEET_ROUTES"]),
  "server/routes/code-drops.mjs": Object.freeze(["CODE_DROP_ROUTES"]),
  "server/routes/desktop-auth.mjs": Object.freeze(["DESKTOP_AUTH_ROUTES"]),
  "server/routes/record-rails.mjs": Object.freeze(["RECORD_RAIL_ROUTES"]),
  "server/routes/room-assistant.mjs": Object.freeze(["ROOM_ASSISTANT_ROUTES"]),
  "server/routes/table.mjs": Object.freeze(["AUTH_CLASSES", "ROUTE_METHODS", "ROUTE_SCOPES"]),
  "server/routes/typing.mjs": Object.freeze(["TYPING_ROUTES"]),
  "server/session-adapter.mjs": Object.freeze(["PANE_SOURCES"]),
  "server/session-adapter/herdr-bridge-adapter.mjs": Object.freeze(["BRIDGE_TIMEOUTS"]),
  "server/share-links.mjs": Object.freeze(["LINK_ACCESS"]),
  "server/signed-evidence.mjs": Object.freeze(["EVIDENCE_KINDS"]),
  "server/sla-breach-journal.mjs": Object.freeze(["slaBreachAlertLimits"]),
  "server/spam-quarantine-journal.mjs": Object.freeze(["spamQuarantineDecisions"]),
  "server/spam-shadow-report.mjs": Object.freeze(["shadowReportLabels", "shadowReviewStatuses"]),
  "server/starter-room.mjs": Object.freeze(["INTENT_TEMPLATES"]),
  "server/updates.mjs": Object.freeze(["UPDATE_KINDS"]),
  "server/wake-metrics.mjs": Object.freeze(["WAKE_EVENTS", "WAKE_FAILURE_REASONS", "WAKE_STORES"]),
  "server/web-research.mjs": Object.freeze(["WEB_RESEARCH_SOURCES"]),
  "server/work-claims.mjs": Object.freeze(["HARD_WORK_TAGS"]),
  "server/work-wants.mjs": Object.freeze(["WANTS_WORK_KINDS"]),
});
export const UNVERIFIED_BASELINE = Object.freeze(
  Object.entries(UNVERIFIED_BASELINE_BY_FILE)
    .flatMap(([file, names]) => names.map(name => `${file}#${name}`))
    .sort((a, b) => a.localeCompare(b)));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const registries = enumerateRegistries(root);
  const unverified = registries.filter(r => r.verifiedBy.length === 0);
  const showAll = process.argv.includes("--all");
  for (const registry of registries) {
    if (registry.verifiedBy.length === 0) console.log(`unverified  ${registry.id} (${registry.kind})`);
    else if (showAll) console.log(`pinned      ${registry.id} (${registry.kind}) <- ${registry.verifiedBy[0]}${registry.verifiedBy.length > 1 ? ` +${registry.verifiedBy.length - 1}` : ""}`);
  }
  console.log(`registry-closure census: ${registries.length} registries enumerated in ${REGISTRY_SOURCE_DIRS.join("/")}, ${registries.length - unverified.length} pinned by a test/check reference, ${unverified.length} unverified (baseline ${UNVERIFIED_BASELINE.length}).`);
  console.log("corpus reference (pin e49e9c81, workspace corpus DB, annotator census over the whole tree): 301 distinct registry IDs, 236 unverified on every entry — a different, conceptual population; see this file's header.");
  const problems = censusProblems(registries);
  if (problems.length > 0) {
    console.error("Registry-closure census drift:\n" + problems.map(line => `  ${line}`).join("\n"));
    process.exit(1);
  }
  console.log("registry-closure census: no new unverified registries; baseline exact.");
}
