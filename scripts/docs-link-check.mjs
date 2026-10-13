// Intra-repo markdown links in the maintained docs, plus the orphan
// gate: every maintained docs/ file must be reachable from docs/INDEX.md
// by following resolved links (decision #32), unless it is on the
// enumerated machine-reachable exception list below. The history
// archive (archive/docs/history/) is a record and is not checked.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function maintainedMarkdown() {
  const files = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"]
    .map(name => join(root, name))
    .filter(path => existsSync(path));
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "history") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk(join(root, "docs"));
  return files;
}

function withoutFences(text) {
  const lines = text.split("\n");
  const kept = [];
  let fence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) { fence = !fence; continue; }
    if (!fence) kept.push(line);
  }
  return kept.join("\n");
}

export function brokenDocLinks() {
  const failures = [];
  let checked = 0;
  for (const abs of maintainedMarkdown()) {
    const relFile = relative(root, abs).split("\\").join("/");
    const text = withoutFences(readFileSync(abs, "utf8"));
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const url = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("//")) continue;
      const pathPart = url.split("#")[0].split("?")[0];
      if (!pathPart) continue;
      checked += 1;
      let decoded;
      try { decoded = decodeURIComponent(pathPart); }
      catch { failures.push(`${relFile} has an undecodable link ${url}`); continue; }
      const resolved = normalize(join(dirname(abs), decoded));
      if (existsSync(resolved)) continue;
      failures.push(`${relFile} links to ${url}, which is not in the tree`);
    }
  }
  return { failures, checked };
}

// Orphan-gate exceptions: files under docs/ that are reached by a
// machine surface instead of by INDEX navigation. Each entry names the
// reaching mechanism; a file with no mechanism belongs in INDEX, not
// here. Entries for files an open PR is moving are marked with that PR
// and should be deleted when it lands (an exception for a missing or
// reachable file is inert, so landing order cannot break this gate).
export const ORPHAN_EXCEPTIONS = {
  "docs/ADMIN-GUIDE.md": "read by tests/admin-guide-doc.test.js",
  "docs/ARCHITECTURE.md": "linked from README.md and CONTRIBUTING.md; pinned by tests/docs-architecture.test.js",
  "docs/CHAOS.md": "read by the tests/chaos harness",
  "docs/CODEX-ROOM-HOST.md": "packaged by scripts/runtime-package.mjs",
  "docs/CONTRIBUTING-IN-ROOM.md": "linked from CONTRIBUTING.md",
  "docs/ERROR-TAXONOMY.md": "taxonomy source cited by src/agent-error.mjs",
  "docs/FLAKY-QUARANTINE.md": "read by the zero-bug-quarantine workflow and tests/work-claim-integrity.test.js",
  "docs/GROK-BUILD-CONTINUOUS.md": "plugin skill/command source (skills/grok-build-continuous)",
  "docs/INVITE-ONLY-CHECKLIST.md": "gate source for scripts/check.mjs and scripts/open-routes.mjs",
  "docs/JOURNEY-COVERAGE-MAP.md": "parsed by scripts/journey-coverage.mjs; enforced by tests/journey-coverage.test.js",
  "docs/MATCHMAKING.md": "cited by deploy/agent-discovery.mjs and server/work-declarations.mjs",
  "docs/PERF-BUDGET.md": "data source for scripts/perf-budget.mjs",
  "docs/PRIVACY-POLICY-TEMPLATE.md": "pinned by tests/legal-templates-grounding.test.js",
  "docs/RECEIPTS-PAGE.md": "implemented by server/receipts-page.mjs; cited in spec/",
  "docs/ROUTE-AUTH-TABLE.md": "verified via scripts/open-routes.mjs and scripts/check.mjs",
  "docs/SIGNED-AGENT-CARDS.md": "design source cited across server/agent-*.mjs",
  "docs/SPEND-PRIMITIVE.md": "pinned by tests/spend-pricing.test.js and tests/legal-templates-grounding.test.js",
  "docs/TERMS-OF-SERVICE-TEMPLATE.md": "pinned by tests/legal-templates-grounding.test.js",
  "docs/WEEKLY-LEARNINGS.md": "append target and default input of scripts/weekly-learnings.mjs, scripts/lesson-scorer.mjs, scripts/lesson-contradictions.mjs",
  "docs/a2a-receipt-extension.md": "cited by deploy/agent-discovery.mjs and spec/core/receipt.md",
  "docs/analytics/EVENTS.md": "pinned by tests/analytics-catalog.test.js",
  "docs/legal/acceptable-use.md": "runtime-read legal page (server/legal-pages.mjs)",
  "docs/legal/privacy.md": "runtime-read legal page (server/legal-pages.mjs)",
  "docs/legal/terms.md": "runtime-read legal page (server/legal-pages.mjs)",
  "docs/procedures/claim-protocol.md": "baked into deploy/procedures-index.mjs; served at /procedures",
  "docs/procedures/incident-triage.md": "baked into deploy/procedures-index.mjs; served at /procedures",
  "docs/procedures/merge-checklist.md": "baked into deploy/procedures-index.mjs; served at /procedures",
  "docs/signed-evidence.md": "cited by skills/project-room references",
  "docs/video-walkthrough-script.md": "groundability gate: tests/video-walkthrough-shots.test.js",
  // Pending moves (remove each entry when its PR lands):
  "docs/SERVER-COVERAGE.md": "generated report; un-committed by PR #3253",
  "docs/OPENAPI-CONTRACT-REPORT.md": "generated report; un-committed by PR #3253",
  "docs/AGENT-HOST-PLAN-2026-09-29.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/BUG-BOUNTY.md": "moves to archive/docs/plans/ in PR #3336; also read by tests/bug-bounty-honesty.test.js",
  "docs/CONTRIBUTOR-EXPERIENCE-PLAN.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/DEMIGOD-BUYER-OFFER.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/GROK-DEEP-PLUG-PLAN-2026-09-29.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/HERDR-OPERATOR-RUNBOOK.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/OAUTH-PROVIDER-SECURITY-REVIEW.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/OPEN-SOURCE-LAUNCH.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/PRODUCT200-CHAOS-REPORT.md": "moves to archive/docs/reports/ in PR #3336",
  "docs/QA-MUTATION-PROBES.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/SECURITY-REVIEW-2026-09-12.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/SECURITY-REVIEW-2026-09-14.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/SECURITY-REVIEW-IDENTITIES-2026-09-12.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/SESSION-ADAPTER.md": "moves to archive/docs/plans/ in PR #3336",
  "docs/exchange/103-reviewer-advisory-flow.md": "moves to archive/docs/plans/exchange/ in PR #3336",
  "docs/exchange/104-exchange-slice-2-spec.md": "moves to archive/docs/plans/exchange/ in PR #3336",
  "docs/exchange/105-credits-faucet-anti-farming.md": "moves to archive/docs/plans/exchange/ in PR #3336",
  "docs/exchange/106-bounty-pricing-guide.md": "moves to archive/docs/plans/exchange/ in PR #3336",
  "docs/exchange/117-exchange-incident-runbook.md": "moves to archive/docs/plans/exchange/ in PR #3336",
  "docs/exchange/118-credits-explorer-ui-mock.md": "moves to archive/docs/plans/exchange/ in PR #3336",
  "docs/security/deploy-pipeline-supply-chain-audit.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/security/monitoring-coverage-audit.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/security/pentest-run-2026-10-07.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/security/time-handling-audit.md": "moves to archive/docs/audits/ in PR #3336",
  "docs/security/webhook-security-review.md": "moves to archive/docs/audits/ in PR #3336",
};

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function docLinks(abs) {
  const text = withoutFences(readFileSync(abs, "utf8"));
  const targets = [];
  for (const match of text.matchAll(LINK_RE)) {
    const url = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("//")) continue;
    const pathPart = url.split("#")[0].split("?")[0];
    if (!pathPart) continue;
    let decoded;
    try { decoded = decodeURIComponent(pathPart); } catch { continue; }
    targets.push(normalize(join(dirname(abs), decoded)));
  }
  return targets;
}

export function orphanedDocs(exceptions = ORPHAN_EXCEPTIONS) {
  const maintained = maintainedMarkdown();
  const inSet = new Set(maintained);
  const rel = abs => relative(root, abs).split("\\").join("/");
  const docsRoot = join(root, "docs");
  const subjects = maintained.filter(abs => abs.startsWith(docsRoot));
  const indexAbs = join(docsRoot, "INDEX.md");
  if (!inSet.has(indexAbs)) return { failures: [], orphans: [] };
  const reached = new Set([indexAbs]);
  const queue = [indexAbs];
  while (queue.length) {
    const cur = queue.pop();
    for (const target of docLinks(cur)) {
      const candidates = [target, join(target, "README.md"), join(target, "index.md")];
      for (const cand of candidates) {
        if (inSet.has(cand) && !reached.has(cand)) { reached.add(cand); queue.push(cand); }
      }
    }
  }
  const orphans = subjects.filter(abs => !reached.has(abs) && !(rel(abs) in exceptions));
  return {
    orphans: orphans.map(rel),
    failures: orphans.map(abs =>
      `${rel(abs)} is not reachable from docs/INDEX.md — link it from INDEX or add a machine-reach exception with its mechanism to ORPHAN_EXCEPTIONS in scripts/docs-link-check.mjs`),
  };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const { failures, checked } = brokenDocLinks();
  const orphanFailures = orphanedDocs().failures;
  const all = [...failures, ...orphanFailures];
  if (all.length) {
    for (const failure of all) console.error(`docs-link-check: ${failure}`);
    console.error(`docs-link-check: FAILED (${all.length} broken, ${checked} checked)`);
    process.exit(1);
  }
  console.log(`docs-link-check: OK (${checked} links)`);
}
