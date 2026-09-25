// /.well-known/governance.json — machine-readable governance policy.
//
// Every numeric/boolean claim below is derived from the enforcing
// configuration module named in the comment above it — no duplicated
// literals. If an enforcing constant changes, this document changes with it;
// tests/discoverability.test.js re-derives the same constants independently
// and fails on drift.

import { BUDGET_CAPS } from "../src/work-item-session.js";
import {
  GUEST_AGENT_PERMISSIONS,
  GUEST_AGENT_TTL_MS,
  GUEST_AGENT_KIND,
} from "./guest-agent-links.mjs";
import { wakeQueueLimits } from "./wake-queue-limits.mjs";
import { SEVERITY_KEEP_DAYS, ARCHIVE_AFTER_DAYS } from "./audit-retention.mjs";
import {
  DEFAULT_LEASE_HOURS,
  MAX_LEASE_HOURS,
  REVIEW_POLICIES,
} from "./work-claims.mjs";
import { REQUEST_TTL_MS } from "./access-requests.mjs";
import { CREDIT_UNIT } from "./bounty-receipts.mjs";
import { GENESIS_CREDITS, BOUNTY_STATES } from "./bounty-escrow.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { DISCOVERABILITY_ROUTES } from "./discoverability.mjs";

export const GOVERNANCE_SCHEMA_VERSION = "1";

// Round/tool budgets: enforced by validateSessionBudget() + roundLimitExceeded()
// in src/work-item-session.js and the budget_exceeded 409 in server/store.mjs.
const roundLimits = () => ({
  declaredBy: "claimer",
  cap: BUDGET_CAPS.maxRounds,
  undeclared: "unknown",
});
const toolBudgets = () => ({
  declaredBy: "claimer",
  cap: BUDGET_CAPS.maxToolCalls,
  onExceed: "409 budget_exceeded",
});

// Idempotency: enforced in server/store.mjs — the (room_id, actor_id,
// command.id) lookup returns { duplicate: true } on retry and fails 409
// idempotency_conflict when the same id carries different content.
const idempotencyProofs = () => ({
  mechanism: "caller-supplied requestId",
  onRetry: "duplicate:true",
  onConflict: "409 idempotency_conflict",
});

// Resume authority: server/wake-queue.mjs subject() — a member may always
// resume its own paused row; resuming another member's row requires the
// signed-in room owner (session auth, human, ownerId, manage_members).
// So ownerOnlyResume is false: the agent itself may resume.
const ownerOnlyResume = () => false;

// Guest tier: enforced in server/guest-agent-links.mjs — owner-issued,
// single-use, GUEST_AGENT_PERMISSIONS (empty grant list) with read_chat
// access, expiring after GUEST_AGENT_TTL_MS. Guests are visibly badged
// (guest) everywhere and carry no claim-bearing permissions.
const guestTier = () => ({
  permissions: [...GUEST_AGENT_PERMISSIONS],
  access: "read_chat",
  kind: GUEST_AGENT_KIND,
  reputationBearing: false,
  claimEligible: false,
  ttl: `${GUEST_AGENT_TTL_MS / 3600000}h`,
  ttlMs: GUEST_AGENT_TTL_MS,
  ownerIssued: true,
  singleUse: true,
});

// Work ledger: claim leases enforced by server/work-claims.mjs
// (DEFAULT_LEASE_HOURS, MAX_LEASE_HOURS, null opts out); receipts are
// sha-bound via evidenceVersion = sha256(exact message body) in
// server/text-results.mjs; verification is per-work-item designated
// (verifierMemberId + independentVerificationRequired, server/store.mjs).
const workLedger = () => ({
  claims: true,
  leases: {
    defaultHours: DEFAULT_LEASE_HOURS,
    maxHours: MAX_LEASE_HOURS,
    optOut: null,
  },
  accessRequestTtl: `${REQUEST_TTL_MS / 86400000}d`,
  accessRequestTtlMs: REQUEST_TTL_MS,
  receipts: "sha-bound",
  receiptScheme: "sha256 of the exact message body (evidenceVersion)",
  verifierModel: "per-work-item designated verifier",
  reviewPolicies: [...REVIEW_POLICIES],
});

// Economy: credits are pure ledger units. Derived from
// server/bounty-escrow.mjs: the payable -> settled exit is deliberately
// unimplemented — BOUNTY_STATES contains no "settled" state — and the module
// header states "no cash-out, no on-chain touch, no real money". The one and
// only mint is the genesis issuance (GENESIS_CREDITS per pre-registered lane).
// A future exit rail would add the state and flip these with it.
const settledExitExists = () => BOUNTY_STATES.includes("settled");
const economy = () => ({
  unit: "credit",
  ledgerUnit: CREDIT_UNIT,
  genesisCredits: GENESIS_CREDITS,
  cashOut: settledExitExists(),
  onChain: settledExitExists(),
  billing: settledExitExists(),
});

// Communications: webhook signing enforced by server/webhook-dispatch.mjs
// (HMAC-SHA256, x-webhook-signature: sha256=<hex>); wake queue enforced by
// server/wake-queue.mjs; outbound sends are bounded by per-channel token
// buckets (server/channel-send-budgets.mjs), connection linking requires the
// room owner (server/agent-connections.mjs owner_required), and DMs require
// target consent (server/dm-consents.mjs).
const communications = () => ({
  webhookSigning: "hmac-sha256",
  webhookSignatureHeader: "x-webhook-signature",
  webhookSignatureFormat: "sha256=<hex>",
  wakeQueue: true,
  wakeQueueLeaseMs: wakeQueueLimits.leaseMs,
  wakeQueueMaxAttempts: wakeQueueLimits.maxAttempts,
  outboundContactPolicy: {
    approvalRequired: "owner",
    approvalScope: "connection linking",
    automaticSend: false,
    connectionLinking: "owner_required",
    dmConsentRequired: true,
    sendBudgets: "per-channel token bucket",
  },
});

// Retention: enforced by server/audit-retention.mjs — age beyond keepDays
// purges, older than ARCHIVE_AFTER_DAYS archives, else keeps.
const retention = () => ({
  severityKeepDays: { ...SEVERITY_KEEP_DAYS },
  archiveAfterDays: ARCHIVE_AFTER_DAYS,
});

// Identity rotation/revocation: live self-service routes registered in
// server/agent-plugin-routes.mjs (SECRET_ROTATE_ROUTE / SECRET_REVOKE_ROUTE:
// one identity can only rotate or revoke its own secret). Derived from the
// canonical route inventory — deleting the route flips the claim.
const routeDocumented = path => DISCOVERABILITY_ROUTES.some(entry => entry.path === path);
const identityModel = () => ({
  keyRotation: routeDocumented("/api/agent-identities/{identityId}/rotate"),
  rotationPath: "/api/agent-identities/{identityId}/rotate",
  revocation: routeDocumented("/api/agent-identities/{identityId}/revoke"),
  revocationPath: "/api/agent-identities/{identityId}/revoke",
  guestTier: guestTier(),
});
export function governanceObject({ origin, revision = SOURCE_REVISION, buildId = BUILD_ID } = {}) {
  const doc = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    autonomyModel: "claimer-declared work budgets; idempotent commands; self-or-owner resume",
    agentWorkControls: {
      roundLimits: roundLimits(),
      toolBudgets: toolBudgets(),
      idempotencyProofs: idempotencyProofs(),
      ownerOnlyResume: ownerOnlyResume(),
      resumePolicy:
        "a member may always resume its own paused wake row; resuming another member's row requires the signed-in room owner",
    },
    identityModel: identityModel(),
    workLedger: workLedger(),
    economy: economy(),
    communications: communications(),
    retention: retention(),
    deployedRev: revision,
    buildId,
    policyUrl: `${origin}/.well-known/governance.json`,
  };
  return Object.freeze(doc);
}

export function governanceJson(options) {
  return JSON.stringify(governanceObject(options), null, 2) + "\n";
}
