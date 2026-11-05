// Linear-parity agent session states for Board claims.
//
// Linear shows every delegated agent run in one of six states: pending,
// active, awaitingInput, error, complete, stale
// (https://linear.app/developers/agent-interaction). Room already records
// everything needed to answer the same question for a claim — state, owner,
// history stamps, lease and CI — so this module derives the state; it stores
// nothing and changes no claim. Read paths attach it only when
// ROOM_AGENT_SESSION_STATES=1 (off by default).
export const AGENT_SESSION_STATES = Object.freeze(["pending", "active", "awaitingInput", "error", "complete", "stale"]);
// Project Room uses 30 minutes without retained owner activity as stale.
export const STALE_AFTER_MS = 30 * 60 * 1000;
// A claim with no first activity this long after it was taken is pending.
export const ACK_WINDOW_MS = 10 * 1000;

export const agentSessionStatesEnabled = (env = process.env) => env?.ROOM_AGENT_SESSION_STATES === "1";

const ms = value => (typeof value === "string" ? Date.parse(value) : NaN);

function lastActivityMs(claim) {
  let last = NaN;
  for (const stamp of Array.isArray(claim?.history) ? claim.history : []) {
    if (claim.owner && stamp?.agentId !== claim.owner) continue;
    const at = ms(stamp?.at);
    if (Number.isFinite(at) && !(at <= last)) last = at;
  }
  // updatedAt belongs to any actor; it cannot establish owner activity.
  return last;
}

// Returns { state, reason } or null for an unclaimed/closed item that
// has no agent session (Linear only shows sessions for delegated work).
export function agentSessionOf(claim, now = Date.now()) {
  if (!claim || typeof claim !== "object") return null;
  const nowMs = typeof now === "number" ? now : ms(now);
  const state = claim.state;
  if (state === "unclaimed" || state === "closed" || !claim.owner && state !== "done") return null;
  const ci = claim.ci?.state ?? null;
  if (state === "done") return { state: "complete", reason: "verified" };
  if (ci === "failure") return { state: "error", reason: "ci_failure" };
  if (state === "blocked") return { state: "awaitingInput", reason: "blocked" };
  if (state === "delivered") return { state: "awaitingInput", reason: "awaiting_review" };
  const claimed = ms(claim.claimedAt);
  const last = lastActivityMs(claim);
  const lease = ms(claim.leaseExpiresAt);
  if (Number.isFinite(lease) && lease <= nowMs) return { state: "stale", reason: "lease_expired" };
  if (Number.isFinite(claimed) && !(last > claimed)) {
    return nowMs - claimed > STALE_AFTER_MS ? { state: "stale", reason: "no_activity" }
      : { state: "pending", reason: nowMs - claimed > ACK_WINDOW_MS ? "unresponsive" : "starting" };
  }
  if (!Number.isFinite(last)) return { state: "stale", reason: "owner_activity_unknown" };
  if (nowMs - last > STALE_AFTER_MS) return { state: "stale", reason: "no_activity" };
  return { state: "active", reason: state };
}

export function withAgentSessions(claims, now, env = process.env) {
  if (!agentSessionStatesEnabled(env) || !Array.isArray(claims)) return claims;
  return claims.map(claim => {
    // List pages carry only the state string to stay inside the 64 KiB page
    // budget; agentSessionOf() gives the reason for a single claim.
    const session = agentSessionOf(claim, now);
    return session ? { ...claim, agentSession: session.state } : claim;
  });
}
