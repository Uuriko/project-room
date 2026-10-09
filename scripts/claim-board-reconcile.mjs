// claim-board-reconcile.mjs — offline, read-only reconciliation of a work-claim
// board snapshot against its own ledger rows, room events, role reports, and
// linked PR/branch data.
//
// GUILD-03 (COORD-300, Dot redirect 2026-10-09): additive diagnostic only.
// It never touches a live system, never imports the HTTP layer, never writes
// anything. Input is a JSON snapshot file (see docs/CLAIM-RECONCILE.md for the
// schema); output is findings on stdout.
//
// Detects:
//   STALE_READY             — board queue=ready item that is not actionable
//                             (linked PR merged/closed, superseded card, or
//                             untouched past the staleness horizon)
//   MISSING_LEDGER_ROW      — item state implies transitions its history
//                             ledger never recorded (no truncation to blame)
//   ROLE_OWNERSHIP_MISMATCH — a role reported as owned (e.g. ROLE-DEPLOYER)
//                             with no live matching claim card on the board
//   MISSING_PR_ROW          — claim links a PR the PR snapshot has no row for
//   CLAIM_PR_STATE_DRIFT    — linked PR merged/closed but claim not settled
//   ORPHAN_BRANCH           — claim's branch exists nowhere in the snapshot
//   EVENT_BOARD_DIVERGENCE  — latest work_claim.updated event disagrees with
//                             the board row (or the row is missing entirely)
//
// Board ready-queue semantics and PR-URL canonicalization are borrowed from
// the live modules (server/claim-coordination.mjs) so "ready" means exactly
// what the board means. Everything else is derived from the snapshot alone.
//
// Exit codes: 0 = no findings, 2 = findings, 1 = bad input/usage.
import { readFileSync } from "node:fs";
import { readyClaims, parsePullRequestUrl } from "../server/claim-coordination.mjs";

const SNAPSHOT_SCHEMA = "claim-board-snapshot/v1";
const LIVE_CLAIM_STATES = new Set(["claimed", "in_progress", "blocked"]);
const TERMINAL_STATES = new Set(["done", "closed"]);
// History actions that prove the state a row claims to be in. A row that lost
// older rows to SEC-2 truncation (historyOmitted > 0) is reported separately
// as LEDGER_TRUNCATED: absence of proof is not proof of absence there.
const STATE_PROOF = Object.freeze({
  claimed: ["claim", "pause"],
  in_progress: ["claim", "start"],
  blocked: ["claim", "start", "block"],
  done: ["claim", "finish"],
  closed: ["close", "cancel"],
});
const DEFAULT_HORIZON_HOURS = 72;

const msOf = iso => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid ISO timestamp: ${String(iso)}`);
  return ms;
};

function validateSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("snapshot must be a JSON object");
  if (raw.schema !== SNAPSHOT_SCHEMA) throw new Error(`snapshot.schema must be ${SNAPSHOT_SCHEMA}`);
  if (!Array.isArray(raw.claims)) throw new Error("snapshot.claims must be an array");
  if (typeof raw.now !== "string") throw new Error("snapshot.now must be an ISO timestamp");
  msOf(raw.now); // throws when unparseable
  return {
    schema: raw.schema,
    roomId: typeof raw.roomId === "string" ? raw.roomId : null,
    nowMs: msOf(raw.now),
    claims: raw.claims,
    roleReports: Array.isArray(raw.roleReports) ? raw.roleReports : [],
    roomEvents: Array.isArray(raw.roomEvents) ? raw.roomEvents : [],
    prs: Array.isArray(raw.prs) ? raw.prs : [],
    branches: Array.isArray(raw.branches) ? raw.branches : [],
    horizonHours: Number.isFinite(raw.stalenessHorizonHours) && raw.stalenessHorizonHours > 0
      ? raw.stalenessHorizonHours : DEFAULT_HORIZON_HOURS,
  };
}

const leaseExpired = (item, nowMs) => {
  if (!item || item.leaseExpiresAt == null) return false;
  return msOf(item.leaseExpiresAt) <= nowMs;
};

const pullUrlsOf = item => {
  const urls = [];
  if (item?.pullRequest?.url) urls.push(item.pullRequest.url);
  for (const entry of (item?.pullRequests ?? [])) {
    if (entry && typeof entry.url === "string") urls.push(entry.url);
  }
  return urls;
};

function prIndex(prs) {
  const byUrl = new Map();
  const byNumberRepo = new Map();
  for (const pr of prs) {
    const parsed = parsePullRequestUrl(pr?.url ?? "");
    const number = Number.isInteger(pr?.number) ? pr.number : parsed?.number ?? null;
    const repo = typeof pr?.repo === "string" ? pr.repo : parsed?.repo ?? null;
    const state = typeof pr?.state === "string" ? pr.state : null;
    const branch = typeof pr?.branch === "string" ? pr.branch : null;
    if (number != null && repo) byNumberRepo.set(`${repo}#${number}`, { number, repo, state, branch });
    const canonical = parsed?.url ?? (typeof pr?.url === "string" ? pr.url : null);
    if (canonical) byUrl.set(canonical, { number, repo, state, branch });
  }
  return { byUrl, byNumberRepo };
}

function findPr(index, url) {
  const parsed = parsePullRequestUrl(url);
  if (!parsed) return { row: null, malformed: true };
  return {
    row: index.byUrl.get(parsed.url) ?? index.byNumberRepo.get(`${parsed.repo}#${parsed.number}`) ?? null,
    malformed: false,
  };
}

// --- check 1: stale READY items ---------------------------------------------
function checkStaleReady(snap) {
  const findings = [];
  const readyIds = new Set(readyClaims(snap.claims).map(item => item.id));
  const prs = prIndex(snap.prs);
  const horizonMs = snap.horizonHours * 3600_000;
  for (const item of snap.claims) {
    if (!readyIds.has(item.id)) continue;
    if (item.supersededBy) {
      findings.push({ code: "STALE_READY", severity: "warn", claimId: item.id,
        detail: `superseded by ${item.supersededBy} but still listed ready`,
        evidence: { supersededBy: item.supersededBy, state: item.state } });
      continue;
    }
    let prStale = false;
    for (const url of pullUrlsOf(item)) {
      const { row, malformed } = findPr(prs, url);
      if (malformed) continue;
      if (row && (row.state === "merged" || row.state === "closed")) {
        findings.push({ code: "STALE_READY", severity: "warn", claimId: item.id,
          detail: `linked PR ${row.repo}#${row.number} is ${row.state}; work already delivered`,
          evidence: { pullRequest: url, prState: row.state } });
        prStale = true;
      }
    }
    if (prStale) continue;
    if (typeof item.updatedAt === "string") {
      try {
        if (snap.nowMs - msOf(item.updatedAt) > horizonMs) {
          findings.push({ code: "STALE_READY", severity: "warn", claimId: item.id,
            detail: `untouched for over ${snap.horizonHours}h while listed ready`,
            evidence: { updatedAt: item.updatedAt, horizonHours: snap.horizonHours } });
        }
      } catch { /* unparseable updatedAt: not our call to make */ }
    }
  }
  return findings;
}

// --- check 2: missing ledger rows -------------------------------------------
function checkLedger(snap) {
  const findings = [];
  for (const item of snap.claims) {
    const proof = STATE_PROOF[item.state];
    if (!proof) continue; // unclaimed rows need no ledger proof
    const history = Array.isArray(item.history) ? item.history : [];
    const actions = new Set(history.map(stamp => stamp?.action));
    if (proof.some(action => actions.has(action))) continue;
    const omitted = Number.isInteger(item.historyOmitted) && item.historyOmitted > 0 ? item.historyOmitted : 0;
    if (omitted > 0) {
      findings.push({ code: "LEDGER_TRUNCATED", severity: "info", claimId: item.id,
        detail: `state is ${item.state} but history lost ${omitted} row(s) to truncation; ledger proof not verifiable`,
        evidence: { state: item.state, historyOmitted: omitted } });
    } else {
      findings.push({ code: "MISSING_LEDGER_ROW", severity: "error", claimId: item.id,
        detail: `state is ${item.state} with no history stamp proving it (expected one of: ${proof.join(", ")})`,
        evidence: { state: item.state, historyActions: [...actions] } });
    }
  }
  return findings;
}

// --- check 3: reported role ownership vs board cards ---------------------------
function checkRoles(snap) {
  const findings = [];
  const byId = new Map(snap.claims.map(item => [item.id, item]));
  const liveRoleCards = new Set();
  for (const report of snap.roleReports) {
    const role = report?.role;
    if (typeof role !== "string" || role.length === 0) continue;
    const card = byId.get(role);
    const live = card && LIVE_CLAIM_STATES.has(card.state) && !leaseExpired(card, snap.nowMs);
    const ownerMatches = live && card.owner === report.reportedOwner;
    if (live) liveRoleCards.add(role);
    if (!card) {
      findings.push({ code: "ROLE_OWNERSHIP_MISMATCH", severity: "error", claimId: role,
        detail: `role reported as owned by ${report.reportedOwner} but no claim card exists on the board`,
        evidence: { role, reportedOwner: report.reportedOwner, source: report.source ?? null } });
    } else if (!LIVE_CLAIM_STATES.has(card.state) || leaseExpired(card, snap.nowMs)) {
      findings.push({ code: "ROLE_OWNERSHIP_MISMATCH", severity: "error", claimId: role,
        detail: `role reported as owned by ${report.reportedOwner} but the card is ${card.state}${leaseExpired(card, snap.nowMs) ? " (lease lapsed)" : ""}`,
        evidence: { role, reportedOwner: report.reportedOwner, cardState: card.state, cardOwner: card.owner ?? null } });
    } else if (card.owner !== report.reportedOwner) {
      findings.push({ code: "ROLE_OWNERSHIP_MISMATCH", severity: "error", claimId: role,
        detail: `role reported as owned by ${report.reportedOwner} but the live card is held by ${card.owner}`,
        evidence: { role, reportedOwner: report.reportedOwner, cardOwner: card.owner } });
    }
  }
  for (const item of snap.claims) {
    if (typeof item.id === "string" && item.id.startsWith("ROLE-") &&
        LIVE_CLAIM_STATES.has(item.state) && !leaseExpired(item, snap.nowMs) &&
        !liveRoleCards.has(item.id) &&
        !snap.roleReports.some(report => report?.role === item.id)) {
      findings.push({ code: "ROLE_UNREPORTED", severity: "info", claimId: item.id,
        detail: `live role card held by ${item.owner} with no matching role report in the snapshot`,
        evidence: { role: item.id, cardOwner: item.owner } });
    }
  }
  return findings;
}

// --- check 4: PR / branch reconciliation --------------------------------------
function checkPrBranch(snap) {
  const findings = [];
  const prs = prIndex(snap.prs);
  const branchSet = new Set(snap.branches);
  const prBranches = new Set([...prs.byUrl.values(), ...prs.byNumberRepo.values()]
    .map(row => row.branch).filter(branch => typeof branch === "string"));
  for (const item of snap.claims) {
    if (TERMINAL_STATES.has(item.state)) continue;
    for (const url of pullUrlsOf(item)) {
      const { row, malformed } = findPr(prs, url);
      if (malformed) {
        findings.push({ code: "MISSING_PR_ROW", severity: "warn", claimId: item.id,
          detail: `claim links an unparseable PR URL; cannot reconcile`,
          evidence: { pullRequest: url } });
        continue;
      }
      if (!row) {
        findings.push({ code: "MISSING_PR_ROW", severity: "warn", claimId: item.id,
          detail: `claim links ${url} but the PR snapshot has no row for it`,
          evidence: { pullRequest: url } });
      } else if ((row.state === "merged" || row.state === "closed") && LIVE_CLAIM_STATES.has(item.state)) {
        findings.push({ code: "CLAIM_PR_STATE_DRIFT", severity: "warn", claimId: item.id,
          detail: `linked PR ${row.repo}#${row.number} is ${row.state} but the claim is still ${item.state}`,
          evidence: { pullRequest: url, prState: row.state, claimState: item.state } });
      }
    }
    if (typeof item.branch === "string" && item.branch.length > 0 &&
        !branchSet.has(item.branch) && !prBranches.has(item.branch)) {
      findings.push({ code: "ORPHAN_BRANCH", severity: "warn", claimId: item.id,
        detail: `claim works on branch ${item.branch}, which appears in neither the branch list nor any PR row`,
        evidence: { branch: item.branch } });
    }
  }
  return findings;
}

// --- check 5: room events vs board rows ----------------------------------------
function checkEvents(snap) {
  const findings = [];
  const byId = new Map(snap.claims.map(item => [item.id, item]));
  const latest = new Map();
  for (const envelope of snap.roomEvents) {
    const data = envelope?.data;
    if (!data || typeof data.workClaim !== "string") continue;
    const atMs = typeof envelope.at === "string" ? Date.parse(envelope.at) : NaN;
    const prior = latest.get(data.workClaim);
    if (!prior || (Number.isFinite(atMs) && atMs >= prior.atMs)) {
      latest.set(data.workClaim, { action: data.action, claimState: data.claimState, ownerId: data.ownerId ?? null, atMs });
    }
  }
  for (const [claimId, event] of latest) {
    const row = byId.get(claimId);
    if (!row) {
      findings.push({ code: "EVENT_BOARD_DIVERGENCE", severity: "error", claimId,
        detail: `latest room event (${event.action}) references a claim with no board row`,
        evidence: { action: event.action, claimState: event.claimState, ownerId: event.ownerId } });
      continue;
    }
    if (typeof event.claimState === "string" && event.claimState !== row.state) {
      findings.push({ code: "EVENT_BOARD_DIVERGENCE", severity: "error", claimId,
        detail: `latest room event says state ${event.claimState} but the board row says ${row.state}`,
        evidence: { eventState: event.claimState, boardState: row.state, action: event.action } });
    } else if (event.ownerId !== (row.owner ?? null) && typeof event.claimState === "string") {
      findings.push({ code: "EVENT_BOARD_DIVERGENCE", severity: "error", claimId,
        detail: `latest room event names owner ${event.ownerId ?? "none"} but the board row names ${row.owner ?? "none"}`,
        evidence: { eventOwner: event.ownerId, boardOwner: row.owner ?? null, boardState: row.state } });
    }
  }
  return findings;
}

export function reconcile(rawSnapshot) {
  const snap = validateSnapshot(rawSnapshot);
  return Object.freeze([
    ...checkStaleReady(snap),
    ...checkLedger(snap),
    ...checkRoles(snap),
    ...checkPrBranch(snap),
    ...checkEvents(snap),
  ].map(finding => Object.freeze({ ...finding })));
}

export const CHECK_NAMES = Object.freeze([
  "STALE_READY", "MISSING_LEDGER_ROW", "LEDGER_TRUNCATED",
  "ROLE_OWNERSHIP_MISMATCH", "ROLE_UNREPORTED",
  "MISSING_PR_ROW", "CLAIM_PR_STATE_DRIFT", "ORPHAN_BRANCH",
  "EVENT_BOARD_DIVERGENCE",
]);

// CLI -------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const snapshotIdx = args.indexOf("--snapshot");
  const path = snapshotIdx >= 0 ? args[snapshotIdx + 1] : null;
  if (!path) {
    console.error("usage: node scripts/claim-board-reconcile.mjs --snapshot <file.json> [--pretty]");
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`cannot read snapshot: ${err.message}`);
    process.exit(1);
  }
  let findings;
  try {
    findings = reconcile(raw);
  } catch (err) {
    console.error(`invalid snapshot: ${err.message}`);
    process.exit(1);
  }
  const pretty = args.includes("--pretty");
  console.log(pretty ? JSON.stringify(findings, null, 2) : JSON.stringify(findings));
  process.exit(findings.length > 0 ? 2 : 0);
}
