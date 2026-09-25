// One Begin for already selected work. It performs the next verified Room
// operations and reports each confirmed stage. It does not invent success,
// and a disconnected host is never called working.
import { createHash } from "node:crypto";
import { activeClaim } from "../src/workflow.js";

const SCOPE_NEEDS = Object.freeze(["repository", "ref", "paths", "expiresAt"]);

function canonicalBeginInput(input) {
  const scope = input || {};
  const paths = Array.isArray(scope.paths) ? scope.paths : [];
  return JSON.stringify([scope.repository ?? "", scope.ref ?? "", paths, scope.expiresAt ?? ""]);
}

// Claim and start ids include the exact scope. Accept and a start with no
// claim keep the previous work/action/revision id so an unchanged retry matches.
export function beginRequestId(workItemId, action, expectedRevision, input = null) {
  const body = input == null
    ? `${workItemId}\n${action}\n${expectedRevision}`
    : `${workItemId}\n${action}\n${expectedRevision}\n${canonicalBeginInput(input)}`;
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return `begin-${digest}`;
}

export function sameExactScope(claim, scope) {
  if (!claim || !scope) return false;
  if (claim.repository !== scope.repository || claim.ref !== scope.ref || claim.expiresAt !== scope.expiresAt) return false;
  if (!Array.isArray(claim.paths) || !Array.isArray(scope.paths) || claim.paths.length !== scope.paths.length) return false;
  return claim.paths.every((path, index) => path === scope.paths[index]);
}

function requestedScope(scope) {
  return Boolean(scope && SCOPE_NEEDS.some(key => scope[key] !== undefined));
}

function claimView(item) {
  const claim = item?.claim;
  if (!claim || claim.status !== "active") return null;
  return {
    repository: claim.repository, ref: claim.ref,
    paths: Array.isArray(claim.paths) ? [...claim.paths] : [],
    expiresAt: claim.expiresAt, holderId: claim.holderId ?? null
  };
}

function validScope(scope) {
  return Boolean(scope
    && typeof scope.repository === "string" && scope.repository.trim()
    && typeof scope.ref === "string" && scope.ref.trim()
    && Array.isArray(scope.paths) && scope.paths.length > 0 && scope.paths.length <= 64
    && scope.paths.every(path => typeof path === "string" && path.trim() && path.length <= 512)
    && typeof scope.expiresAt === "string" && scope.expiresAt.trim());
}

function stage(action, item, expectedRevision, scope) {
  const input = action === "room_acquire_claim" ? scope : action === "room_start_work" && item.claim ? item.claim : null;
  const requestId = beginRequestId(item.id, action, expectedRevision, input);
  const args = { requestId, workItemId: item.id, expectedRevision };
  if (action === "room_acquire_claim") {
    args.repository = scope.repository;
    args.ref = scope.ref;
    args.paths = [...scope.paths];
    args.expiresAt = scope.expiresAt;
  }
  return { action, requestId, expectedRevision, args };
}

// The single next verified operation, or a stop that does not start work.
export function planBegin(item, member, { scope = null, now = Date.now() } = {}) {
  if (!item || !member || member.active === false || member.id !== item.accountableMemberId) {
    return { stage: null, reason: "not_accountable", next: null };
  }
  const can = permission => Array.isArray(member.permissions) && member.permissions.includes(permission);
  const ownClaim = activeClaim(item, now) && item.claim.holderId === member.id;
  if (item.state === "proposed") {
    if (!can("accept_work")) return { stage: null, reason: "permission", next: "accept" };
    return { stage: stage("room_accept_work", item, item.revision), reason: null, next: "accept" };
  }
  if (item.mode === "write" && !ownClaim && ["accepted", "working"].includes(item.state)) {
    if (!can("write_external")) return { stage: null, reason: "permission", next: "claim" };
    if (!validScope(scope)) {
      return { stage: null, reason: "exact_scope_required", next: "claim",
        resume: { action: "room_acquire_claim", needs: [...SCOPE_NEEDS] } };
    }
    return { stage: stage("room_acquire_claim", item, item.revision, scope), reason: null, next: "claim" };
  }
  if (item.mode === "write" && ownClaim && requestedScope(scope) && !sameExactScope(item.claim, scope)) {
    return { stage: null, reason: "scope_mismatch", next: "claim", currentClaim: claimView(item), resume: null };
  }
  if (item.state === "accepted") {
    if (!can("accept_work")) return { stage: null, reason: "permission", next: "start" };
    if (item.mode === "write" && !ownClaim) {
      return { stage: null, reason: "exact_scope_required", next: "claim",
        resume: { action: "room_acquire_claim", needs: [...SCOPE_NEEDS] } };
    }
    return { stage: stage("room_start_work", item, item.revision), reason: null, next: "start" };
  }
  if (item.state === "working") return { stage: null, reason: "ready", next: "in_progress" };
  return { stage: null, reason: "nothing_to_begin", next: item.state ?? null };
}

const idOk = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) && value.length <= 128;

export function validBeginArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  if (!keys.includes("workItemId") || keys.some(key => !["workItemId", "repository", "ref", "paths", "expiresAt", "invocationRequestId"].includes(key))) return false;
  if (!idOk(args.workItemId)) return false;
  if (args.invocationRequestId !== undefined && !idOk(args.invocationRequestId)) return false;
  if (args.repository !== undefined && (typeof args.repository !== "string" || !args.repository.trim() || args.repository.length > 4096)) return false;
  if (args.ref !== undefined && (typeof args.ref !== "string" || !args.ref.trim() || args.ref.length > 4096)) return false;
  if (args.expiresAt !== undefined && (typeof args.expiresAt !== "string" || !args.expiresAt.trim() || args.expiresAt.length > 64)) return false;
  if (args.paths !== undefined && (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 64
    || args.paths.some(path => typeof path !== "string" || !path.trim() || path.length > 512))) return false;
  return true;
}

function stoppedResult(context, { confirmed, stopped, resume, refusal = null, currentClaim = null, next = null }) {
  const roomState = context?.work?.state ?? null;
  return {
    working: false, roomState, confirmed, invented: false, stopped, next, resume,
    ...(refusal ? { refusal } : {}),
    ...(currentClaim ? { currentClaim } : {})
  };
}

// working follows Room work state only after a read that is not a stop.
// A disconnected call, an unknown write, and a scope mismatch are not working.
function readResult(context, plan, confirmed) {
  const roomState = context.work.state;
  const stopped = plan.reason === "ready" ? null : plan.reason;
  return {
    working: stopped ? false : roomState === "working",
    roomState, confirmed, invented: false, stopped,
    next: plan.next, resume: plan.resume ?? null,
    ...(plan.currentClaim ? { currentClaim: plan.currentClaim } : {})
  };
}

function claimLanded(item, scope, invocation) {
  return Boolean(invocation?.requestId && item && scope
    && item.claim?.status === "active" && item.claim.holderId === item.accountableMemberId
    && sameExactScope(item.claim, scope)
    && invocation.requestId === beginRequestId(item.id, "room_acquire_claim", item.revision - 1, scope));
}

// Reads current work between stages. An unknown response keeps the same
// request id. working is Room work state, not an external host start.
// invocation pins an unknown stage: a different id is not executed, and a
// later revision is not given a new write unless that exact claim already landed.
export async function beginSelectedWork({ connected, read, execute, scope = null, now = Date.now(), invocation = null } = {}) {
  if (connected !== true) {
    return { working: false, roomState: null, confirmed: [], stopped: "disconnected", invented: false };
  }
  const confirmed = [];
  const seen = new Set();
  let pending = invocation?.requestId ? invocation : null;
  for (let step = 0; step < 4; step += 1) {
    let context;
    try {
      context = await read();
    } catch {
      return stoppedResult(null, { confirmed, stopped: "unknown",
        resume: pending ?? { tool: "room_read_work", workItemId: scope?.workItemId ?? null } });
    }
    if (!context?.work || !context.viewer) {
      return stoppedResult(context, { confirmed, stopped: "unknown",
        resume: pending ?? { tool: "room_read_work", workItemId: scope?.workItemId ?? null } });
    }
    const plan = planBegin(context.work, context.viewer, { scope, now });
    if (!plan.stage) return readResult(context, plan, confirmed);
    if (pending && plan.stage.requestId !== pending.requestId && !claimLanded(context.work, scope, pending)) {
      return stoppedResult(context, {
        confirmed, stopped: "invocation_mismatch", resume: pending,
        currentClaim: plan.currentClaim ?? claimView(context.work), next: plan.next
      });
    }
    if (pending && plan.stage.requestId !== pending.requestId) pending = null;
    if (seen.has(plan.stage.requestId)) {
      return stoppedResult(context, { confirmed, stopped: "unknown", resume: plan.stage });
    }
    seen.add(plan.stage.requestId);
    let result;
    try {
      result = await execute(plan.stage);
    } catch {
      return stoppedResult(context, { confirmed, stopped: "unknown", resume: plan.stage });
    }
    if (!result || result.status === "unconfirmed" || result.status === "unknown") {
      return stoppedResult(context, { confirmed, stopped: "unknown", resume: plan.stage });
    }
    if (result.status !== "recorded" && result.status !== "confirmed") {
      return stoppedResult(context, { confirmed, stopped: "refused", refusal: result.code || result.status, resume: plan.stage });
    }
    confirmed.push({ action: plan.stage.action, requestId: plan.stage.requestId, eventId: result.eventId ?? null });
    pending = null;
  }
  return { working: false, roomState: null, confirmed, stopped: "unknown", invented: false };
}
