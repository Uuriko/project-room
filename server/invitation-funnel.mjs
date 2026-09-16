// Invitation funnel: issued, accepted, activated.
//
// src/growth-metrics.js can only see accepted joins, because that is all the
// Room event log records. Invitations that were sent and never taken up live in
// the invitation journal, so the coefficient there is reported as a floor. This
// module closes that gap by reading journal snapshot records alongside Room
// state, which turns the floor into a real send-to-accept rate.
//
// The journal is private authority history. This module is server-side for that
// reason and emits aggregates only: no token hashes, no account ids, no display
// names, nothing that identifies a person outside this Room. REDACTED_FIELDS
// names what is deliberately never returned, and the test suite asserts it.
//
// Timestamps in journal records are epoch milliseconds, matching server/store.mjs.

import { memberTimeline } from "../src/growth-metrics.js";

// Account ids reach across Rooms and a token hash is a credential. Issuer and
// intended member ids are Room-scoped, the same class of identifier the Room
// already shows in its member list, so per-inviter breakdown stays available.
export const REDACTED_FIELDS = Object.freeze([
  "token_hash", "issue_fingerprint", "intended_account_id", "accepted_by_account_id",
  "issuer_account_id", "revoked_by_account_id", "intended_display_name",
  "redemption_id", "intended_permissions_json"
]);

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MIN_ISSUED = 5;
const MIN_ISSUERS = 3;

const list = (value) => (Array.isArray(value) ? value : []);
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Effective status, mirroring server/store.mjs: a pending invitation whose
 * expiry has passed reads as expired. The journal stores only pending,
 * accepted and revoked, so expiry has to be derived and never counted as a
 * live invitation still in play.
 */
export function invitationStatus(record, now = Date.now()) {
  if (record?.status === "pending" && integer(record.expires_at) !== null && record.expires_at <= now) return "expired";
  return record?.status ?? "unknown";
}

/**
 * The send side of the loop. Expiry is broken out on purpose: invitations that
 * quietly time out are the cheapest growth to recover, and they are invisible
 * in any metric that only counts joins.
 */
export function invitationFunnel(records, { now = Date.now() } = {}) {
  const rows = list(records).filter((record) => record && typeof record === "object");
  const counts = { pending: 0, expired: 0, accepted: 0, revoked: 0, unknown: 0 };
  const acceptDurations = [];
  const windows = [];
  const byIssuer = new Map();

  for (const record of rows) {
    const status = invitationStatus(record, now);
    counts[status] = (counts[status] ?? 0) + 1;

    const created = integer(record.created_at);
    const expires = integer(record.expires_at);
    if (created !== null && expires !== null && expires > created) windows.push(expires - created);
    if (status === "accepted") {
      const accepted = integer(record.accepted_at);
      if (created !== null && accepted !== null && accepted >= created) acceptDurations.push(accepted - created);
    }

    const issuer = record.issuer_member_id;
    if (typeof issuer === "string" && issuer) {
      const current = byIssuer.get(issuer) ?? { issuerMemberId: issuer, issued: 0, accepted: 0, expired: 0 };
      current.issued += 1;
      if (status === "accepted") current.accepted += 1;
      if (status === "expired") current.expired += 1;
      byIssuer.set(issuer, current);
    }
  }

  const issued = rows.length;
  const warnings = [];
  if (issued < MIN_ISSUED) warnings.push(`invitations issued: ${issued} of ${MIN_ISSUED} needed before these rates mean anything`);
  if (byIssuer.size < MIN_ISSUERS) warnings.push(`distinct inviters: ${byIssuer.size} of ${MIN_ISSUERS} needed before per-inviter comparison means anything`);
  if (counts.expired > counts.accepted && issued > 0) {
    warnings.push("More invitations expired than were accepted. The window or the reminder is wrong, not the pitch.");
  }

  return {
    issued,
    accepted: counts.accepted,
    pendingLive: counts.pending,
    expired: counts.expired,
    revoked: counts.revoked,
    acceptRate: ratio(counts.accepted, issued),
    // Invitations that died on the vine. Recovering these needs no new audience.
    expiryLossRate: ratio(counts.expired, issued),
    revokeRate: ratio(counts.revoked, issued),
    medianTimeToAcceptMs: median(acceptDurations),
    medianInviteWindowMs: median(windows),
    byIssuer: [...byIssuer.values()].sort((a, b) => b.accepted - a.accepted),
    insufficientData: issued < MIN_ISSUED,
    warnings
  };
}

/**
 * The whole loop, journal joined to Room state.
 *
 *   K = invitations issued per inviter  x  accept rate  x  activation rate
 *
 * The activation term is what stops a flattering number: someone who accepted
 * an invitation and never said anything cannot invite the next person, so they
 * do not carry the loop and should not be counted as though they did.
 */
export function trueInviteCoefficient(records, state, { now = Date.now(), activationWindowMs = WEEK_MS } = {}) {
  const funnel = invitationFunnel(records, { now });
  const rows = list(records);

  const timeline = new Map(memberTimeline(state).map((row) => [row.memberId, row]));
  const byInvitationId = new Map();
  for (const member of Object.values(state?.members ?? {})) {
    const invitationId = member?.membershipOrigin?.invitationId;
    if (invitationId) byInvitationId.set(invitationId, member.id);
  }
  // Older records may predate membershipOrigin; joined_event_id still links them.
  const eventToMember = new Map();
  for (const entry of list(state?.eventLog)) {
    if (entry?.data?.memberId) eventToMember.set(entry.id, entry.data.memberId);
  }

  let resolved = 0;
  let activated = 0;
  for (const record of rows) {
    if (invitationStatus(record, now) !== "accepted") continue;
    const memberId = byInvitationId.get(record.id) ?? eventToMember.get(record.joined_event_id);
    if (!memberId) continue;
    resolved += 1;
    const row = timeline.get(memberId);
    if (row && row.timeToFirstContributionMs !== null && row.timeToFirstContributionMs <= activationWindowMs) activated += 1;
  }

  const inviters = funnel.byIssuer.length;
  const issuedPerInviter = ratio(funnel.issued, inviters);
  const activationRate = ratio(activated, resolved);
  const k = issuedPerInviter !== null && funnel.acceptRate !== null && activationRate !== null
    ? issuedPerInviter * funnel.acceptRate * activationRate
    : null;

  const warnings = [...funnel.warnings];
  if (resolved < funnel.accepted) {
    warnings.push(`${funnel.accepted - resolved} accepted invitation(s) could not be matched to a member in this Room state; the activation term covers only the matched ones.`);
  }
  if (k === null) warnings.push("Not enough of the loop is observable to state a coefficient.");

  return {
    issuedPerInviter,
    acceptRate: funnel.acceptRate,
    activationRate,
    k,
    inviters,
    acceptedResolvedToMembers: resolved,
    activatedInvitees: activated,
    basis: "issued per inviter x accept rate x activation rate, from the invitation journal joined to the Room event log",
    funnel,
    insufficientData: funnel.insufficientData || resolved === 0,
    warnings
  };
}

const percent = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const number = (value) => (value === null ? "n/a" : (Math.round(value * 100) / 100).toString());
const duration = (ms) => {
  if (ms === null || !Number.isFinite(ms)) return "n/a";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / DAY_MS).toFixed(1)}d`;
};

/** Plain-text block, safe to paste into the agent channel. Carries no person-level field. */
export function formatInvitationReport(coefficient) {
  const { funnel } = coefficient;
  const lines = [
    "Invitation funnel",
    `  issued           ${funnel.issued}`,
    `  accepted         ${funnel.accepted} (${percent(funnel.acceptRate)})`,
    `  expired unused   ${funnel.expired} (${percent(funnel.expiryLossRate)})`,
    `  revoked          ${funnel.revoked}`,
    `  still live       ${funnel.pendingLive}`,
    `  time to accept   ${duration(funnel.medianTimeToAcceptMs)} median, window offered ${duration(funnel.medianInviteWindowMs)}`,
    "",
    "Coefficient",
    `  issued/inviter   ${number(coefficient.issuedPerInviter)}`,
    `  accept rate      ${percent(coefficient.acceptRate)}`,
    `  activation rate  ${percent(coefficient.activationRate)}`,
    `  K                ${number(coefficient.k)}`,
    ""
  ];
  if (funnel.byIssuer.length) {
    lines.push("By inviter");
    for (const issuer of funnel.byIssuer) {
      lines.push(`  ${issuer.issuerMemberId.padEnd(16)} ${issuer.accepted}/${issuer.issued} accepted, ${issuer.expired} expired`);
    }
    lines.push("");
  }
  if (coefficient.warnings.length) {
    lines.push("Read with care");
    for (const warning of coefficient.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}
