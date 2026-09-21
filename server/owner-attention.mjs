// #662 — "Needs your attention" owner-gate card: a single rollup of every
// place a human owner decision is required (pending access requests, work
// awaiting verification/decision, spend-allowance headroom, expiring claim
// leases). Owner-only (403 otherwise); every item carries the concrete
// next action, following the existing `next`-action convention, so approvals
// live in the conversation surface instead of a separate admin area.
//
// Named owner-attention to avoid the unrelated W4-46 quiet-hours/digest
// "attention" module (server/attention.mjs).
//
// Local ServiceError (mirrors server/access-requests.mjs): store.mjs imports
// are avoided here to keep the Workers bundle cycle-free; http.mjs injects
// its store and AccessRequests instances.
import { spendAllowanceReport } from "./spend-allowance.mjs";

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// A claim lease inside this horizon is worth the owner's attention.
const CLAIM_LEASE_WARN_MS = 24 * 60 * 60 * 1000;
// Spend headroom below this fraction of the allowance needs a top-up decision.
const SPEND_HEADROOM_WARN_FRACTION = 0.2;
// The card is a triage surface, not a full queue.
const MAX_ITEMS = 25;

function requireOwner(store, auth, roomId) {
  // Mirrors the diagnostics-export owner gate on main.
  if (auth.member.kind !== "human" || auth.member.id !== store.room(roomId).state.room.ownerId
    || !auth.member.permissions.includes("manage_members")) {
    fail(403, "owner_required", "Only the room owner can view the attention rollup");
  }
}

function decideActions(roomId, request) {
  const path = `/api/rooms/${roomId}/access-requests/${request.requestId}/decide`;
  return Object.freeze([
    Object.freeze({ action: "approve", method: "POST", path,
      body: Object.freeze({ decision: "approve", permissions: request.requestedPermissions, note: null }) }),
    Object.freeze({ action: "deny", method: "POST", path,
      body: Object.freeze({ decision: "deny", permissions: [], note: null }) }),
  ]);
}

function reviewAction(roomId, workItemId) {
  return Object.freeze({ action: "review", method: "GET",
    path: `/api/rooms/${roomId}/work-context?workItemId=${encodeURIComponent(workItemId)}` });
}

export function attentionReport(deps, token, roomId, expectedSessionBinding = null, nowMs = Date.now()) {
  const { store, accessRequests } = deps;
  if (!store || !accessRequests) fail(500, "misconfigured", "Attention rollup is not wired");
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  requireOwner(store, auth, roomId);
  const items = [];

  // 1. Pending access requests — the only item with true inline approve/deny.
  for (const request of accessRequests.list(token, roomId, { status: "pending" }, expectedSessionBinding)) {
    items.push(Object.freeze({
      kind: "access_request",
      id: request.requestId,
      severity: "action",
      title: `${request.displayName} asks to join`,
      detail: `Requested ${request.requestedPermissions.join(", ")}`,
      actions: decideActions(roomId, request),
    }));
  }

  const room = store.room(roomId);
  for (const item of Object.values(room.state.workItems ?? {})) {
    // 2. Work awaiting verification or an owner decision.
    if (item.state === "completed" && item.independentVerificationRequired && !item.verification) {
      items.push(Object.freeze({
        kind: "verification",
        id: item.id,
        severity: "action",
        title: `Verify: ${item.title}`,
        detail: "Completed work is waiting for independent verification",
        actions: Object.freeze([reviewAction(roomId, item.id)]),
      }));
    } else if (item.state === "completed" && item.ownerDecisionRequired && !item.decision) {
      items.push(Object.freeze({
        kind: "decision",
        id: item.id,
        severity: "action",
        title: `Decide: ${item.title}`,
        detail: "Completed work is waiting for your decision",
        actions: Object.freeze([reviewAction(roomId, item.id)]),
      }));
    }
    // 4. Claim leases expiring inside the warning horizon.
    const claim = item.claim;
    if (claim && claim.status === "active" && typeof claim.expiresAt === "string") {
      const expiresMs = Date.parse(claim.expiresAt);
      if (Number.isFinite(expiresMs) && expiresMs - nowMs < CLAIM_LEASE_WARN_MS) {
        const hours = Math.max(0, Math.round((expiresMs - nowMs) / 3600000));
        items.push(Object.freeze({
          kind: "claim_lease",
          id: item.id,
          severity: expiresMs <= nowMs ? "action" : "info",
          title: `Claim expiring: ${item.title}`,
          detail: expiresMs <= nowMs ? "The claim lease has expired" : `The claim lease expires in about ${hours}h`,
          actions: Object.freeze([reviewAction(roomId, item.id)]),
        }));
      }
    }
  }

  // 3. Spend-allowance headroom running out (or already over).
  const spend = spendAllowanceReport(room.state, nowMs);
  if (spend.allowance && typeof spend.headroomCents === "number"
    && spend.headroomCents < SPEND_HEADROOM_WARN_FRACTION * spend.allowance.allowanceCents) {
    items.push(Object.freeze({
      kind: "spend",
      id: "spend-allowance",
      severity: "action",
      title: spend.overCents > 0 ? "Spend allowance exceeded" : "Spend allowance running low",
      detail: spend.overCents > 0
        ? `Committed spend is ${spend.overCents}c over the allowance`
        : `${spend.headroomCents}c of headroom left in the current period`,
      actions: Object.freeze([Object.freeze({ action: "adjust", method: "POST",
        path: `/api/rooms/${roomId}/spend-allowance`,
        hint: "Send { allowanceCents, periodDays? } to raise the allowance" })]),
    }));
  }

  return Object.freeze({
    roomId,
    evaluatedThrough: room.sequence,
    itemCount: items.length,
    items: Object.freeze(items.slice(0, MAX_ITEMS)),
  });
}
