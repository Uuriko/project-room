// Withheld, never refused: per-agent capability catalog filtering.
// (UFO-steal slice 4, RC-2026-09-27-2731; UFO slice: ToolDef flag.)
//
// UFO's insight, ported: flagged-off tools are WITHHELD FROM the model's
// catalog, never refused at call time. This module holds the single
// predicate capabilityVisibleTo(agent, capability) that every
// capability/tool catalog listing path must use: a capability the
// agent's grants/tiers do not admit is ABSENT from the listing JSON —
// never "present but denying".
//
// Design rules:
// - The catalog mirrors the POLICY (the autonomy-tier contract in
//   server/autonomy-tiers.mjs and the guest-scope contract from #1166),
//   not just the enforcement coverage. Call-time enforcement STAYS in
//   place as defense in depth: withholding removes the discovery
//   surface, it never substitutes for the check.
// - The catalog never regresses functionality: a capability the agent
//   can successfully invoke stays listed. The carve-outs below encode
//   the exact write subsets call time still permits, verified against
//   the denial code paths (see comments).
// - Grant edges (slice 1) plug in here: capability.requiresGrant +
//   agent.grants. Today no capability declares requiresGrant, so the
//   seam is inert — but the predicate is already the single place
//   where both the catalog and future grants decide visibility.
//
// Agent descriptor shape (built per request by resolveCatalogAgent;
// plain data, no store handles):
//   {
//     kind: "agent" | "human",        // humans are never tier-restricted
//     identityId,                      // pri_ identity id, or null
//     memberships: [{                  // one row per linked room member
//       roomId, memberId,
//       isGuest,                       // guest-agent-* member id (#1166)
//       autonomyTier,                  // t1_readonly | t2_standard
//       isOwner,                       // ownership implies full authority
//       active,
//     }],
//     grants: [],                      // slice-1 seam: capability grant edges
//   }
// Capability descriptor shape: the MCP tool definition ({ name,
// annotations.readOnlyHint }) or { name, readOnly }.

import { getTier, DEFAULT_AUTONOMY_TIER } from "./autonomy-tiers.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

// Write tools a guest agent may still invoke. The store.command guest
// gate (server/store.mjs) admits MESSAGE_POSTED chat posts — but drafts
// carrying a workItemId need the contributor tier — and
// MESSAGE_REACTION_SET; every other command type is 403
// guest_scope_denied, and #1166 extended the same denial to attachment
// staging, moderation reports, and wake-queue intents. Draft posts
// stay call-time-gated for observer-tier guests: the check remains as
// defense in depth.
export const GUEST_WRITABLE_TOOLS = Object.freeze(new Set(["room_post_message", "room_react"]));

// Write tools a t1_readonly agent may still invoke. The tier contract
// (server/autonomy-tiers.mjs T1_READONLY_ALLOWED_COMMANDS) keeps
// heartbeats and session status/stop reports landing while every other
// write is 403 agent_readonly (enforceAutonomyTiers /
// enforceAutonomyTierForAction).
export const T1_WRITABLE_TOOLS = Object.freeze(new Set(["heartbeat_set", "heartbeat_ack"]));

// A capability is a write when it is explicitly non-readonly. Unknown
// capabilities default to visible: withholding must never hide a tool
// the agent could successfully invoke.
export function capabilityIsWrite(capability) {
  if (!capability || typeof capability !== "object") return false;
  if (capability.readOnly === false) return true;
  if (capability.readOnly === true) return false;
  return capability.annotations?.readOnlyHint === false;
}

// The single visibility predicate. Reads are never withheld; writes
// are withheld unless some membership class admits them (an identity
// may hold different standing in different rooms — a tool is visible
// when the agent can use it SOMEWHERE; the target room's call-time
// check stays authoritative).
export function capabilityVisibleTo(agent, capability) {
  if (!agent || agent.kind === "human") return true;
  if (!capabilityIsWrite(capability)) return true;
  // Slice-1 seam: grant edges refine tiers. A capability that declares
  // a required grant is withheld unless the agent holds that grant
  // edge. Inert today: no capability declares requiresGrant.
  const requiresGrant = capability?.requiresGrant;
  if (requiresGrant !== undefined && requiresGrant !== null) {
    return (agent.grants ?? []).includes(requiresGrant);
  }
  const memberships = Array.isArray(agent.memberships) ? agent.memberships : [];
  if (memberships.length === 0) return true;
  const classes = new Set();
  for (const m of memberships) {
    if (!m || m.active === false) continue;
    if (m.isGuest) classes.add("guest");
    else if (m.isOwner || m.autonomyTier !== "t1_readonly") classes.add("full");
    else classes.add("t1");
  }
  if (classes.has("full")) return true;
  const name = capability?.name;
  if (classes.has("guest") && GUEST_WRITABLE_TOOLS.has(name)) return true;
  if (classes.has("t1") && T1_WRITABLE_TOOLS.has(name)) return true;
  return false;
}

// Build the per-request agent descriptor for the catalog listing.
// Reads each linked room's FRESH tier row (tiers are never cached) and
// never consults static state. Skips links whose room or membership no
// longer exists. Throws nothing: an unresolvable link degrades to a
// roomless descriptor (full catalog, onboarding stays reachable).
export function resolveCatalogAgent(store, identity) {
  const memberships = [];
  const identityId = identity?.identityId ?? null;
  if (store?.db && typeof identityId === "string" && identityId) {
    let links = [];
    try {
      links = store.db.prepare(
        "SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id = ?"
      ).all(identityId);
    } catch {
      links = [];
    }
    for (const { roomId, memberId } of links) {
      let state = null;
      try {
        state = store.room(roomId)?.state ?? null;
      } catch {
        state = null;
      }
      const member = state?.members?.[memberId] ?? null;
      if (!member || member.active === false) continue;
      let tier = null;
      try {
        tier = getTier(store.db, roomId, memberId)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER;
      } catch {
        tier = DEFAULT_AUTONOMY_TIER;
      }
      memberships.push({
        roomId,
        memberId,
        isGuest: isGuestAgentMemberId(memberId),
        autonomyTier: tier,
        isOwner: state?.room?.ownerId === memberId,
        active: true,
      });
    }
  }
  return { kind: "agent", identityId, memberships, grants: [] };
}
