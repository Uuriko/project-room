// #662 — "Needs your attention" owner-gate card: a single rollup of every
// place a human owner decision is required (pending access requests, work
// awaiting verification/decision, board work-claims awaiting review, spend-
// allowance headroom, expiring claim leases). Owner-only (403 otherwise);
// every item carries the concrete
// next action, following the existing `next`-action convention, so approvals
// live in the conversation surface instead of a separate admin area.
//
// Named owner-attention to avoid the unrelated W4-46 quiet-hours/digest
// "attention" module (server/attention.mjs).
//
// Local ServiceError (mirrors server/access-requests.mjs): store.mjs imports
// are avoided here to keep the Workers bundle cycle-free; http.mjs injects
// its store and AccessRequests instances. The work-claims kernel is a pure
// module (no store import), so its close/review predicates are safe to use.
import { createHash } from "node:crypto";
import { spendAllowanceReport } from "./spend-allowance.mjs";
import { canCloseWork, hasCurrentReview, resolveNamedReviewers } from "./work-claims.mjs";

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

// A full card keeps decisions ahead of informational leases. Under the cap,
// insertion order stays so an owner still sees requests before later notes.
function orderedAttention(items) {
  if (items.length <= MAX_ITEMS) return items;
  const actions = items.filter(item => item.severity === "action");
  const rest = items.filter(item => item.severity !== "action");
  return [...actions, ...rest];
}

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

// The one #662 item shape with a true inline action. Exported for the
// cross-room Owner Cockpit (#3342), which merges these items across rooms
// and must not grow a second copy of the decide contract.
export function accessRequestAttentionItem(roomId, request) {
  return Object.freeze({
    kind: "access_request",
    id: request.requestId,
    severity: "action",
    title: request.kind === "permissions" ? `${request.displayName} wants: ${request.requestedPermissions.join(", ")}` : `${request.displayName} asks to join`,
    detail: `Requested ${request.requestedPermissions.join(", ")}`,
    actions: decideActions(roomId, request),
  });
}

function reviewAction(roomId, workItemId) {
  return Object.freeze({ action: "review", method: "GET",
    path: `/api/rooms/${roomId}/work-context?workItemId=${encodeURIComponent(workItemId)}` });
}

function boardReviewAction(roomId, claimId) {
  return Object.freeze({ action: "review", method: "GET",
    path: `/api/rooms/${roomId}/work-claims/${encodeURIComponent(claimId)}` });
}

// Mirror of the work-claim routes' mayReviewWorkClaims (work-claim-routes.mjs:
// mayWriteWorkClaims || the verify permission), computed over a members map.
// The routes re-check on POST; this only decides whose delivered claims the
// rollup may call the owner's business.
const CLAIM_PROFILES = Object.freeze({
  contribute: ["accept_work", "complete_work"],
  review: ["verify"],
  collaborate: ["steer", "accept_work", "complete_work", "verify"],
});
function mayReviewClaimMember(member, ownerId) {
  if (!member || member.active === false) return false;
  if (ownerId && member.id === ownerId) return true;
  const permissions = new Set(member.permissions ?? []);
  if (permissions.has("verify")) return true;
  if (member.kind === "human") return permissions.has("accept_work") || permissions.has("complete_work");
  return Object.values(CLAIM_PROFILES).some(profile => profile.every(name => permissions.has(name)));
}

export function attentionReport(deps, token, roomId, expectedSessionBinding = null, nowMs = Date.now(), { cursor = null, includeShadow = false } = {}) {
  const { store, accessRequests } = deps;
  if (!store || !accessRequests) fail(500, "misconfigured", "Attention rollup is not wired");
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  requireOwner(store, auth, roomId);
  const items = [];

  // 1. Pending access requests — the only item with true inline approve/deny.
  for (const request of accessRequests.list(token, roomId, { status: "pending" }, expectedSessionBinding)) {
    items.push(accessRequestAttentionItem(roomId, request));
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

  // 2b. Board work-claims delivered and awaiting the owner's review or
  // verification (#3754). The claims registry is the record now; the legacy
  // workItems loop above never sees board-native work, so before this input
  // existed a delivered claim awaiting its reviewer produced no item at all.
  // Eligibility mirrors the work-claim routes' verify gate: the claim's
  // review policy (room default when unset); a claim naming other reviewers
  // (rev-<memberId> tags) awaits them, not the owner; and once the owner
  // holds a current approval, canCloseWork decides whether the pending act
  // is the owner's verify or somebody else's.
  const claims = typeof store.workClaims?.list === "function" ? store.workClaims.list(roomId) : [];
  if (claims.length) {
    const members = room.state.members ?? {};
    const ownerId = auth.member.id;
    const roomOwnerId = room.state.room?.ownerId ?? null;
    const reviewMembers = Object.values(members)
      .filter(member => mayReviewClaimMember(member, roomOwnerId)).map(member => member.id);
    const verifyMembers = Object.values(members)
      .filter(member => member && member.active !== false && (member.permissions ?? []).includes("verify"))
      .map(member => member.id);
    const roomPolicy = typeof store.workClaims?.configFor === "function"
      ? store.workClaims.configFor(roomId)?.reviewPolicy : undefined;
    for (const item of claims) {
      if (!item || item.state !== "delivered") continue;
      const policy = item.reviewPolicy ?? roomPolicy ?? "self_attested";
      if (canCloseWork(item, ownerId, { policy, verifyMembers, reviewMembers })) {
        items.push(Object.freeze({
          kind: "board_review",
          id: item.id,
          severity: "action",
          title: `Review: ${item.title}`,
          detail: policy === "self_attested"
            ? "Delivered work is waiting for your verification"
            : "Delivered work you approved is waiting for your verification",
          actions: Object.freeze([boardReviewAction(roomId, item.id)]),
        }));
        continue;
      }
      // Not the owner's to close: their review is the pending act only when
      // the claim is someone else's under a reviewed policy, they are an
      // eligible reviewer, no other reviewer is named, and they have not
      // already approved (an approved-but-unclosable claim waits on a
      // verifier, not on another review).
      if (policy === "self_attested" || !item.owner || item.owner === ownerId) continue;
      if (!reviewMembers.includes(ownerId)) continue;
      const named = resolveNamedReviewers(item, members);
      if (named.length > 0 && !named.includes(ownerId)) continue;
      const review = (item.reviews ?? []).find(entry => entry?.memberId === ownerId && entry?.verdict === "approve");
      const approved = Boolean(review && hasCurrentReview(item, ownerId)
        && (item.attestations ?? []).some(entry => entry?.memberId === ownerId && entry?.at === review.at));
      if (approved) continue;
      items.push(Object.freeze({
        kind: "board_review",
        id: item.id,
        severity: "action",
        title: `Review: ${item.title}`,
        detail: "Delivered work is waiting for your review",
        actions: Object.freeze([boardReviewAction(roomId, item.id)]),
      }));
    }
  }

  // 2c. SEC2-C-B verification drift: an active identity-linked member
  // seated in a room whose policy requires verified identities, while
  // the identity carries no attestation. Unverify suspends gated seats
  // in the same act, so this derived item is the standing signal for
  // the drift that remains reachable — a policy switched on over
  // already-seated members, an owner seat (never attestation-gated),
  // or a suspension that could not run (named on the unverify result).
  const plugin = store.agentPlugin;
  if (plugin && plugin.roomVerificationPolicy(roomId).requireVerified) {
    const members = room.state.members ?? {};
    const links = store.db.prepare(
      "SELECT identity_id AS identityId, member_id AS memberId FROM identity_links WHERE room_id=?").all(roomId);
    for (const link of links) {
      const member = Object.hasOwn(members, link.memberId) ? members[link.memberId] : null;
      if (!member || member.active === false) continue;
      if (plugin.verificationLevel(link.identityId) === "verified") continue;
      items.push(Object.freeze({
        kind: "verification_drift",
        id: link.identityId,
        severity: "action",
        title: `Unverified member seated: ${member.displayName ?? link.memberId}`,
        detail: "This room requires verified identities, but this member's identity has no verification attestation (withdrawn or never granted). Re-verify the identity or remove the member.",
        actions: Object.freeze([Object.freeze({ action: "review", method: "GET",
          path: `/api/agent-identities/${encodeURIComponent(link.identityId)}/verification` })]),
      }));
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

  // Shadow measurements never require an owner action. Keep them available
  // only to an explicitly requested diagnostics view, separate from triage.
  if (includeShadow && store.jevShadow) {
    for (const entry of store.jevShadow.list({ roomId, escalate: true, limit: 5 })) {
      const label = entry.gate === "receipt" && entry.subject ? `work "${entry.subject}"` : entry.path;
      items.push(Object.freeze({
        kind: "jev_escalation",
        id: entry.id,
        ...(entry.gate === "receipt" && room.state.workItems?.[entry.subject] ? { workItemId: entry.subject } : {}),
        severity: "info",
        title: `Shadow gate would escalate: ${label}`,
        detail: `Jev ${entry.gate} gate scored ${(entry.score * 100).toFixed(0)}% (would-be: ${entry.decision}) — accepted anyway, shadow mode`,
        actions: Object.freeze([Object.freeze({ action: "review", method: "GET",
          path: `/api/rooms/${roomId}/jev-shadow?gate=${entry.gate}&limit=25`,
          hint: "Hand-review recent shadow decisions with scores" })]),
      }));
    }
  }

  const ordered = orderedAttention(items);
  // A changed queue restarts at the first page; never combine pages from
  // different snapshots or silently skip entries after a removal.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    roomId, auth.member.id, auth.sessionBinding ?? null, ordered,
  ])).digest("hex");
  const match = typeof cursor === "string" && cursor.match(/^([a-f0-9]{64}):([0-9]{1,10})$/);
  const requestedOffset = match ? Number(match[2]) : 0;
  const valid = match && match[1] === fingerprint && requestedOffset % MAX_ITEMS === 0
    && requestedOffset < ordered.length;
  const pageOffset = valid ? requestedOffset : 0;
  const pageCursor = offset => `${fingerprint}:${offset}`;
  return Object.freeze({
    roomId,
    // Viewer echo for the client's ownsResponse identity check: without these
    // the browser client treats the rollup as a session change and ends access
    // (which hides owner UI like the invite button). Mirrors store.mjs sessionView.
    viewerId: auth.member.id,
    viewerAccountId: auth.account?.id ?? null,
    viewerAuthEpoch: auth.account?.authEpoch ?? null,
    viewerSessionBinding: auth.sessionBinding,
    viewerSessionRevision: auth.sessionRevision ?? null,
    evaluatedThrough: room.sequence,
    itemCount: items.length,
    actionCount: items.filter(item => item.severity === "action").length,
    pageOffset,
    reset: cursor !== null && !valid,
    previousCursor: pageOffset > 0 ? pageCursor(Math.max(0, pageOffset - MAX_ITEMS)) : null,
    nextCursor: pageOffset + MAX_ITEMS < ordered.length ? pageCursor(pageOffset + MAX_ITEMS) : null,
    items: Object.freeze(ordered.slice(pageOffset, pageOffset + MAX_ITEMS)),
  });
}
