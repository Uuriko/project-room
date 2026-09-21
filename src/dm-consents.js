// DM consent browser view-model + API helpers.
//
// The server keeps consent directional: one row per (requester → target)
// with a status of pending / approved / rejected / blocked / revoked.
// The list endpoint renders participants as display handles for reading and
// carries the authoritative requesterId/targetId for acting — display names
// are not unique per room, so browser actions resolve by id first and the
// handle fallback fails closed on ambiguity instead of guessing.
//
// Pure functions (dmConsentHandleOf, dmConsentPeerSummary,
// incomingDmRequests, dmConsentActionsForPeer, dmConsentFailureMessage)
// are unit-tested in tests/dm-consent-ui.test.js.

export const DM_CONSENT_STATUSES = Object.freeze(["pending", "approved", "rejected", "blocked", "revoked"]);
export const DM_CONSENT_DECISIONS = Object.freeze(["approve", "reject", "block"]);
// Server refusal codes for the DM consent gate (HTTP 403). These are
// application-level refusals — the session is still valid — so the HTTP
// client must NOT treat them like an auth failure (which ends access).
export const DM_CONSENT_REFUSAL_CODES = Object.freeze(["dm_consent_required", "dm_blocked"]);

// Mirrors server/dm-consents.mjs _handleOf exactly.
export function dmConsentHandleOf(member) {
  const name = typeof member?.displayName === "string" ? member.displayName.trim() : "";
  return name || member?.id || "";
}

// handle → member id, but only when the handle is unambiguous: duplicate
// display names fail closed (null) instead of guessing a target.
function memberIndexByHandle(members) {
  const counts = new Map(), ids = new Map();
  for (const member of Object.values(members ?? {})) {
    if (!member || member.active === false) continue;
    const handle = dmConsentHandleOf(member);
    if (!handle) continue;
    counts.set(handle, (counts.get(handle) ?? 0) + 1);
    ids.set(handle, member.id);
  }
  return handle => counts.get(handle) === 1 ? ids.get(handle) : null;
}

// A row belongs to the (selfId → peerId) outgoing direction, or the
// (peerId → selfId) incoming one. Ids win; the handle comparison is the
// fallback for rows that predate ids on the wire.
function rowDirection(row, selfId, peerId, peerHandle) {
  const reqId = typeof row?.requesterId === "string" ? row.requesterId : null;
  const tgtId = typeof row?.targetId === "string" ? row.targetId : null;
  if (reqId && tgtId) {
    if (reqId === selfId && tgtId === peerId) return "outgoing";
    if (reqId === peerId && tgtId === selfId) return "incoming";
    return null;
  }
  if (row?.outgoing) return row.target === peerHandle ? "outgoing" : null;
  return row?.requester === peerHandle ? "incoming" : null;
}

// Per-peer directional summary for the signed-in member (selfId):
//   outgoing — my ability to DM the peer (I am the requester)
//   incoming — the peer's ability to DM me (I am the target)
// Returns null for the member themselves or unknown peers.
export function dmConsentPeerSummary(consents, members, selfId, peerId) {
  const peer = members?.[peerId];
  if (!peer || peerId === selfId) return null;
  const handle = dmConsentHandleOf(peer);
  let outgoing = null, incoming = null, incomingReason = "";
  for (const row of consents ?? []) {
    const direction = rowDirection(row, selfId, peerId, handle);
    if (direction === "outgoing") outgoing = row.status;
    else if (direction === "incoming") { incoming = row.status; incomingReason = row.reason ?? ""; }
  }
  return Object.freeze({ peerId, handle, outgoing, incoming, incomingReason });
}

// Incoming pending requests targeted at the viewer (selfId), with requester
// ids resolved for the decide endpoint. Ambiguous or unmapped requesters are
// dropped — the decide URL needs a real, unambiguous member id.
export function incomingDmRequests(consents, members, selfId) {
  const resolve = memberIndexByHandle(members);
  const out = [];
  for (const row of consents ?? []) {
    if (row?.status !== "pending") continue;
    const reqId = typeof row?.requesterId === "string" ? row.requesterId : null;
    const tgtId = typeof row?.targetId === "string" ? row.targetId : null;
    // Targeted at me: by id when the row carries ids, else by the
    // server-computed outgoing flag (true only for my own requests).
    if (tgtId ? tgtId !== selfId : row?.outgoing) continue;
    if (reqId && reqId === selfId) continue;
    let requesterId = reqId && members?.[reqId] ? reqId : null;
    if (!requesterId && !reqId) requesterId = resolve(row?.requester);
    if (!requesterId) continue;
    out.push({ requesterId, requester: row.requester, reason: row.reason ?? "", at: row.createdAt ?? null });
  }
  return Object.freeze(out);
}

const STATUS_LABELS = Object.freeze({
  pending: "Request pending", approved: "Approved", rejected: "Declined",
  blocked: "Blocked", revoked: "Revoked",
});
export function dmConsentStatusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? "");
}

// Human-readable pair description for a member's Direct messages section.
export function dmConsentPairDescription(summary, peerName) {
  const name = peerName || "them";
  const lines = [];
  const outgoingText = {
    pending: `Your request to message ${name} is still pending.`,
    approved: `${name} approved your request — you can message them directly.`,
    rejected: `${name} declined your request. You can ask again.`,
    blocked: `${name} isn't accepting DM requests from you.`,
    revoked: `DM consent with ${name} was revoked. Send a fresh request to message again.`,
  }[summary?.outgoing];
  const incomingText = {
    pending: `${name} wants to message you — approve, reject, or block below.`,
    approved: `${name} can message you directly.`,
    rejected: `You declined ${name}'s request. They can ask again.`,
    blocked: `You've blocked ${name} — they can't message you or send new requests.`,
    revoked: `DM consent with ${name} was revoked.`,
  }[summary?.incoming];
  if (outgoingText) lines.push(outgoingText);
  if (incomingText) lines.push(incomingText);
  if (!lines.length) lines.push(`No DM arrangement with ${name} yet — messaging needs their consent first.`);
  return lines;
}

// Ordered UI actions for the pair. Each is { action, label, disabled? } where
// action is one of: request, approve, reject, block, unblock, revoke, or a
// "noop-*" label rendered as static text.
export function dmConsentActionsForPeer(summary) {
  if (!summary) return [];
  const actions = [];
  const { outgoing, incoming } = summary;
  // Their ability to message me (my decisions).
  if (incoming === "pending") {
    actions.push({ action: "approve", label: "Approve" });
    actions.push({ action: "reject", label: "Reject" });
  }
  if (incoming === "blocked") actions.push({ action: "unblock", label: "Unblock" });
  else actions.push({ action: "block", label: "Block" });
  // My ability to message them.
  if (outgoing === "approved") actions.push({ action: "revoke", label: "Revoke my consent" });
  else if (outgoing === "pending") actions.push({ action: "noop-pending", label: "Request pending", disabled: true });
  else if (outgoing === "blocked") actions.push({ action: "noop-blocked", label: "Not accepting requests", disabled: true });
  else actions.push({ action: "request", label: outgoing ? "Request again" : "Request to message" });
  // Their approved consent toward me is revocable too.
  if (incoming === "approved") actions.push({ action: "revoke", label: "Revoke their consent" });
  return actions;
}

// ---- API ------------------------------------------------------------------
// All through the room client's signed-in request path (browser session
// required server-side; these never run for the public read-only face).

export function fetchDmConsents(client) {
  return client.request(client.path("/dm-consents"));
}

export function requestDmConsent(client, targetId, reason = "") {
  const clean = String(reason ?? "").trim().slice(0, 500);
  return client.request(client.path("/dm-consents"), {
    method: "POST", data: clean ? { targetId, reason: clean } : { targetId },
  });
}

export function decideDmConsent(client, requesterId, decision) {
  if (!DM_CONSENT_DECISIONS.includes(decision)) throw new Error("decision must be approve, reject, or block");
  return client.request(client.path(`/dm-consents/${encodeURIComponent(requesterId)}/decide`), {
    method: "POST", data: { decision },
  });
}

export function revokeDmConsent(client, peerId) {
  return client.request(client.path("/dm-consents/revoke"), { method: "POST", data: { peerId } });
}

export function blockDmMember(client, peerId) {
  return client.request(client.path("/dm-consents/block"), { method: "POST", data: { peerId } });
}

export function unblockDmMember(client, peerId) {
  return client.request(client.path("/dm-consents/unblock"), { method: "POST", data: { peerId } });
}

// ---- failure messages -------------------------------------------------------
// Honest, actionable UI copy. Transport failures never leak raw text; consent
// gate codes explain exactly what to do next.
export function dmConsentFailureMessage(error, peerName) {
  const they = (one, many) => peerName ? `${peerName} ${one}` : `They ${many}`;
  const code = error?.code;
  if (code === "dm_consent_required") return `${they("hasn't", "haven't")} approved DMs from you yet — send a request from their profile in the People panel.`;
  if (code === "dm_blocked") return `${they("isn't", "aren't")} accepting direct messages from you.`;
  if (code === "dm_already_approved") return "DM consent is already approved — you can message them directly.";
  if (code === "dm_no_pending_request") return "That DM request is no longer pending.";
  if (code === "dm_nothing_to_revoke") return "There's no approved DM consent to revoke.";
  if (code === "dm_not_blocked") return "That member isn't blocked.";
  if (code === "target_not_found" || code === "blocked_not_found" || code === "requester_not_found" || code === "member_not_found") {
    return "That member isn't in this room anymore.";
  }
  if (typeof code === "string" && code.startsWith("invalid_dm")) return error?.message || "That DM action wasn't valid — check the details and try again.";
  const raw = String(error?.message ?? "");
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Couldn't reach the room — check your connection and try again.";
  }
  if (raw && !/^\s*$/.test(raw) && !/^<|doctype|html/i.test(raw)) return raw;
  return "That didn't go through — try again.";
}
