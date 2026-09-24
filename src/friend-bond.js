// Friend / Bond chrome for the People panel.
//
// One control, three labels: Friend, Proposed, Friends. Propose and accept
// omit scopes so the server keeps its default (all v1 scopes on propose,
// the proposal as-is on accept). This is not the room-chat DM consent
// maze in src/dm-consents.js.

// 403s that mean "the bond gate said no", not "this session is over".
export const BOND_REFUSAL_CODES = Object.freeze([
  "no_bond", "bond_pending", "bond_revoked", "scope_denied", "bond_not_recipient"
]);

export function identityIdOf(member, presence) {
  if (typeof member?.identityId === "string" && member.identityId) return member.identityId;
  if (typeof presence?.ownerIdentityId === "string" && presence.ownerIdentityId) return presence.ownerIdentityId;
  return null;
}

function bondTime(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// GET /bonds stores epoch millis. The room projection stores event `at` as
// an ISO string. Both have to compare, or a stale list row hides a live accept.
export function bondStamp(bond) {
  const times = [bond?.proposedAt, bond?.acceptedAt, bond?.revokedAt].map(bondTime).filter(n => n !== null);
  return times.length ? Math.max(...times) : 0;
}

function bondLifecycleRank(bond) {
  if (bond?.state === "revoked") return 4;
  if (bond?.state === "active") return 3;
  if (bond?.state === "expired") return 2;
  if (bond?.state === "proposed") return 1;
  return 0;
}

// Newer stamp wins. The list is applied second, so it still wins a tie
// between different bond ids (an expired proposal has no newer event, and a
// re-proposal replaces a revoked projection). The same id does not go
// backwards: a stale "proposed" list row must not hide an active projection
// that shares its stamp.
function preferFriendBond(next, prev) {
  if (!prev) return true;
  const nextStamp = bondStamp(next);
  const prevStamp = bondStamp(prev);
  if (nextStamp !== prevStamp) return nextStamp > prevStamp;
  if (next.id && next.id === prev.id) {
    const nextRank = bondLifecycleRank(next);
    const prevRank = bondLifecycleRank(prev);
    if (nextRank !== prevRank) return nextRank > prevRank;
  }
  return true;
}

export function mergeFriendBonds(listed, projected) {
  const byPair = new Map();
  const add = bond => {
    if (!bond || typeof bond.agentAId !== "string" || typeof bond.agentBId !== "string") return;
    if (!bond.agentAId || !bond.agentBId || bond.agentAId === bond.agentBId) return;
    const key = bond.agentAId < bond.agentBId
      ? `${bond.agentAId}\0${bond.agentBId}`
      : `${bond.agentBId}\0${bond.agentAId}`;
    const prev = byPair.get(key);
    if (preferFriendBond(bond, prev)) byPair.set(key, bond);
  };
  const projectedBonds = projected && typeof projected === "object" && !Array.isArray(projected)
    ? Object.values(projected) : Array.isArray(projected) ? projected : [];
  for (const bond of projectedBonds) add(bond);
  for (const bond of listed ?? []) add(bond);
  return Object.freeze([...byPair.values()]);
}

export function bondWithPeer(bonds, selfIdentityId, peerIdentityId) {
  if (!selfIdentityId || !peerIdentityId || selfIdentityId === peerIdentityId) return null;
  return (bonds ?? []).find(bond => bond && (
    (bond.agentAId === selfIdentityId && bond.agentBId === peerIdentityId)
    || (bond.agentAId === peerIdentityId && bond.agentBId === selfIdentityId)
  )) ?? null;
}

// state: none | pending | incoming | outgoing | active
// actions: propose | accept | decline | revoke | dm
// pending: a proposal exists but this member's identity is not resolved yet.
// Revoke is not offered then — treating "unknown" as outgoing put Revoke on
// an incoming request.
export function friendChrome({ bond, selfIdentityId } = {}) {
  const none = Object.freeze({
    state: "none", label: "Friend", bondId: null,
    actions: Object.freeze([{ action: "propose", label: "Friend" }])
  });
  if (!bond || bond.state === "revoked" || bond.state === "expired" || bond.state === "none") return none;
  if (bond.state === "proposed") {
    if (!selfIdentityId) {
      return Object.freeze({
        state: "pending", label: "Proposed", bondId: bond.id ?? null,
        actions: Object.freeze([])
      });
    }
    const incoming = bond.proposedById !== selfIdentityId;
    if (incoming) {
      return Object.freeze({
        state: "incoming", label: "Proposed", bondId: bond.id ?? null,
        actions: Object.freeze([{ action: "accept", label: "Accept" }, { action: "decline", label: "Decline" }])
      });
    }
    return Object.freeze({
      state: "outgoing", label: "Proposed", bondId: bond.id ?? null,
      actions: Object.freeze([{ action: "revoke", label: "Revoke" }])
    });
  }
  if (bond.state === "active") {
    const actions = [];
    // Missing or empty acceptedScopes is the server default (all v1, which
    // includes peer.dm). List rows and the room projection sometimes omit
    // the field after the bond is already active; hiding Message then makes
    // Friends look like it dropped the DM. Hide Message only when a
    // non-empty list explicitly leaves peer.dm out.
    if (friendOffersPeerDm(bond)) actions.push({ action: "dm", label: "Message" });
    actions.push({ action: "revoke", label: "Revoke" });
    return Object.freeze({
      state: "active", label: "Friends", bondId: bond.id ?? null,
      actions: Object.freeze(actions)
    });
  }
  return none;
}

function friendOffersPeerDm(bond) {
  const scopes = bond?.acceptedScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  return scopes.includes("peer.dm");
}

// After Friend, Accept, Decline, or Revoke, keyboard focus belongs on the
// People-rail group, never on the Revoke button. A repeated Enter while
// Friend or Accept was held used to activate Revoke and flip the bond back.
export function friendFocusTarget(action) {
  if (action === "dm") return "composer";
  return "group";
}

// Scopes stay off the wire. The server treats an omitted list as all v1 scopes.
export function proposeBondData(to) {
  if (typeof to !== "string" || !to) throw new Error("to is required");
  return { to };
}

export function friendBondCommand(action, { to, bondId, body, messageId } = {}) {
  if (action === "propose") return { type: "bond.propose", data: proposeBondData(to) };
  if (action === "accept") return { type: "bond.accept", data: { bondId } };
  if (action === "decline") return { type: "bond.decline", data: { bondId } };
  if (action === "revoke") return { type: "bond.revoke", data: { bondId } };
  // messageId is a client-generated UUID. Key order is the documented shape.
  if (action === "dm") return { type: "dm.posted", data: { messageId, to, body } };
  throw new Error("Unknown friend action");
}

export function friendFailureMessage(error) {
  const code = error?.code;
  if (code === "no_bond") return "No active bond with this agent. Choose Friend to propose one. Sharing a room is not a bond.";
  if (code === "bond_pending") return "Bond is proposed, not accepted. The other agent must accept before a peer message works.";
  if (code === "bond_revoked") return "This bond was revoked. Choose Friend to propose again.";
  if (code === "scope_denied") return "This bond does not include peer messages.";
  if (code === "identity_required") return "Bond is between agent identities. This member has no linked agent identity.";
  if (code === "peer_not_found") return "No agent identity is linked to that member.";
  if (code === "bond_self") return "You cannot friend yourself.";
  if (code === "bond_not_recipient") return "Only the other agent can accept or decline this proposal.";
  if (typeof error?.message === "string" && error.message && error.message !== "Request failed") return error.message;
  return "Friend action failed. Try again.";
}
