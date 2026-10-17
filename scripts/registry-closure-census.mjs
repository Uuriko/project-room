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
export const UNVERIFIED_BASELINE = Object.freeze([
  "scripts/a11y-axe-helper.mjs#A11Y_TAGS",
  "scripts/check-version-doors.mjs#DOORS",
  "scripts/docs-link-check.mjs#ORPHAN_EXCEPTIONS",
  "scripts/eslint-rules/no-raw-members-index.mjs#noRawMembersIndex",
  "scripts/eslint-rules/no-raw-transaction.mjs#noRawTransaction",
  "scripts/github-door.mjs#TRUSTED_ASSOCIATIONS",
  "scripts/listing-check.mjs#STATUSES",
  "scripts/live-smoke.mjs#DISCOVERY",
  "scripts/live-smoke.mjs#SAME_HOSTS",
  "scripts/native-host-binary.mjs#HOST_BINARY_DEFAULT",
  "scripts/perf-budget.mjs#DEFAULT_VIEWPORTS",
  "scripts/perf-budget.mjs#NETWORK_PROFILES",
  "scripts/ralph-loop.mjs#ROUTINES",
  "scripts/reachability.mjs#KEEP",
  "scripts/secret-scan-check.mjs#SCAN_DIRS",
  "scripts/secret-scan-check.mjs#SKIP_DIRS",
  "scripts/verify-affected.mjs#GLOBAL_FILES",
  "scripts/visual-regression-helper.mjs#VISUAL_VIEWPORT",
  "server/a2a-jsonrpc.mjs#A2A_PATHS",
  "server/abuse-rate-buckets.mjs#ABUSE_RATE_FAMILIES",
  "server/abuse-rate-buckets.mjs#ABUSE_RATE_TABLES",
  "server/activity.mjs#ACTIVITY_TYPES",
  "server/agent-discovery.mjs#A2A_WORK_RECEIPT_EXTENSION",
  "server/agent-discovery.mjs#AI_CRAWLERS",
  "server/agent-discovery.mjs#CONNECT_ROUTES",
  "server/agent-discovery.mjs#FIRST_TOOLS",
  "server/agent-lanes.mjs#AVAILABILITY",
  "server/agent-lanes.mjs#LANE_KINDS",
  "server/analytics/catalog.mjs#ACTOR_KINDS",
  "server/analytics/catalog.mjs#ENVELOPE_PROP_KEYS",
  "server/analytics/catalog.mjs#GROWTH_CATALOG",
  "server/analytics/catalog.mjs#LOOPS",
  "server/analytics/catalog.mjs#SOURCE_DETAILS",
  "server/analytics/catalog.mjs#SOURCES",
  "server/analytics/claim-bond-shadow.mjs#SHADOW_KINDS",
  "server/available-work.mjs#AVAILABLE_WORK_SOURCES",
  "server/bonds.mjs#BOND_SCOPES",
  "server/bonds.mjs#PEER_PRIVATE_EVENT_TYPES",
  "server/bounty-escrow.mjs#BOUNTY_GROUPS",
  "server/bounty-escrow.mjs#BOUNTY_STATES",
  "server/bounty-escrow.mjs#CITATION_VERDICTS",
  "server/bounty-escrow.mjs#RULE_ACTOR",
  "server/buyer-signoff.mjs#SIGNOFF_STATUSES",
  "server/channel-adapters/messenger.mjs#messageKinds",
  "server/channel-adapters/messenger.mjs#messengerLimits",
  "server/channel-adapters/sms.mjs#deliveryStatuses",
  "server/channel-adapters/sms.mjs#messageKinds",
  "server/channel-adapters/sms.mjs#smsLimits",
  "server/channel-adapters/telegram-config.mjs#telegramBindings",
  "server/channel-adapters/telegram-transport.mjs#telegramSendLimits",
  "server/channel-adapters/telegram.mjs#messageKinds",
  "server/channel-adapters/whatsapp.mjs#messageKinds",
  "server/channel-connection.mjs#connectionStates",
  "server/channel-connection.mjs#participantKinds",
  "server/channel-import.mjs#webhookSecretLimits",
  "server/channel-journal.mjs#channelJournalStatuses",
  "server/claim-autolink.mjs#PR_WEBHOOK_OPS",
  "server/claim-autolink.mjs#PR_WEBHOOK_ROUTES",
  "server/code-drops.mjs#CODE_DROP_KINDS",
  "server/connect-snippets.mjs#WORK_LOOP",
  "server/content-trust.mjs#MEMBER_TEXT_TOOLS",
  "server/demigod-contracts.mjs#DEMIGOD_CONTRACT_STATUSES",
  "server/demigod-offers.mjs#DEMIGOD_OFFER_STATUSES",
  "server/demigod-offers.mjs#PRICE_TYPES",
  "server/display-name-guard.mjs#RESERVED_ROLE_PREFIXES",
  "server/dm-consents.mjs#DM_CONSENT_DECISIONS",
  "server/dm-consents.mjs#DM_CONSENT_STATUSES",
  "server/dm-event-visibility.mjs#DM_FOLLOW_UP_TYPES",
  "server/feedback-store.mjs#ROUTE_FOR_SEVERITY",
  "server/github-app/verify.mjs#WEBHOOK_EVENTS",
  "server/growth-loop.mjs#GROWTH_TIERS",
  "server/guest-invites.mjs#GUEST_INVITE_TIERS",
  "server/http.mjs#HOUSEKEEPING_WRITE_ROUTES",
  "server/human-push.mjs#HUMAN_PUSH_PREF_DEFAULTS",
  "server/human-push.mjs#HUMAN_PUSH_PREF_KINDS",
  "server/inbox-outbox.mjs#directSendChannels",
  "server/inbox-stitch.mjs#STITCH_ID_TYPES",
  "server/inbox-transport.mjs#directSendChannels",
  "server/jev-shadow-journal.mjs#jevShadowDecisions",
  "server/jev-shadow-journal.mjs#jevShadowGates",
  "server/jev-shadow-journal.mjs#jevShadowLimits",
  "server/jobs.mjs#INTEGRITY_SUBCHECKS",
  "server/land-queue.mjs#LAND_CHANGES",
  "server/land-queue.mjs#LAND_CHECKS",
  "server/land-queue.mjs#LAND_MERGEABLE",
  "server/legal-store.mjs#SIGNUP_ORIGINS",
  "server/mcp-action-search.mjs#ACTION_META_TOOL_NAMES",
  "server/mcp-action-search.mjs#actionMetaToolDefs",
  "server/mcp-discovery.mjs#MCP_TOOL_FOCUSES",
  "server/mcp-hosted-tools.mjs#hostedInboxTools",
  "server/mcp-hosted-tools.mjs#hostedWakeTools",
  "server/messages-store.mjs#MESSAGE_ROW_TYPES",
  "server/notifications.mjs#NOTIFICATION_KINDS",
  "server/notify-policy.mjs#EMAIL_MODES",
  "server/notify-policy.mjs#FOLLOWING_KINDS",
  "server/notify-policy.mjs#NEEDS_ME_KINDS",
  "server/notify-policy.mjs#STORED_LEVELS",
  "server/oauth-provider-store.mjs#OAUTH_PROVIDER_TABLES",
  "server/owner-overview.mjs#OVERVIEW_WINDOWS",
  "server/public-search.mjs#comparisonSlugs",
  "server/push-subscriptions.mjs#DELIVERY_OUTCOMES",
  "server/quarantine-thread-splits.mjs#quarantineSplitLimits",
  "server/referrals.mjs#REFERRAL_VIA",
  "server/retention-run.mjs#DISPOSABLE_LOG_DAYS",
  "server/room-export.mjs#CONTENT_DIGEST_SKIPPED_TABLES",
  "server/routes/agents.mjs#AGENT_FLEET_ROUTES",
  "server/routes/code-drops.mjs#CODE_DROP_ROUTES",
  "server/routes/desktop-auth.mjs#DESKTOP_AUTH_ROUTES",
  "server/routes/record-rails.mjs#RECORD_RAIL_ROUTES",
  "server/routes/room-assistant.mjs#ROOM_ASSISTANT_ROUTES",
  "server/routes/table.mjs#AUTH_CLASSES",
  "server/routes/table.mjs#ROUTE_METHODS",
  "server/routes/table.mjs#ROUTE_SCOPES",
  "server/routes/typing.mjs#TYPING_ROUTES",
  "server/session-adapter.mjs#PANE_SOURCES",
  "server/session-adapter/herdr-bridge-adapter.mjs#BRIDGE_TIMEOUTS",
  "server/share-links.mjs#LINK_ACCESS",
  "server/signed-evidence.mjs#EVIDENCE_KINDS",
  "server/sla-breach-journal.mjs#slaBreachAlertLimits",
  "server/spam-quarantine-journal.mjs#spamQuarantineDecisions",
  "server/spam-shadow-report.mjs#shadowReportLabels",
  "server/spam-shadow-report.mjs#shadowReviewStatuses",
  "server/starter-room.mjs#INTENT_TEMPLATES",
  "server/updates.mjs#UPDATE_KINDS",
  "server/wake-metrics.mjs#WAKE_EVENTS",
  "server/wake-metrics.mjs#WAKE_FAILURE_REASONS",
  "server/wake-metrics.mjs#WAKE_STORES",
  "server/web-research.mjs#WEB_RESEARCH_SOURCES",
  "server/work-claims.mjs#HARD_WORK_TAGS",
  "server/work-wants.mjs#WANTS_WORK_KINDS",
]);

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
