// One Begin for already selected work. It performs the next verified Room
// operations and reports each confirmed stage. It does not invent success,
// and a disconnected host is never called working.
import { createHash } from "node:crypto";
import { activeClaim } from "../src/workflow.js";

const SCOPE_NEEDS = Object.freeze(["repository", "ref", "paths", "expiresAt"]);

export function beginRequestId(workItemId, action, expectedRevision) {
  const digest = createHash("sha256").update(`${workItemId}\n${action}\n${expectedRevision}`).digest("hex").slice(0, 32);
  return `begin-${digest}`;
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
  const requestId = beginRequestId(item.id, action, expectedRevision);
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

export function validBeginArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  if (!keys.includes("workItemId") || keys.some(key => !["workItemId", "repository", "ref", "paths", "expiresAt"].includes(key))) return false;
  if (typeof args.workItemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(args.workItemId) || args.workItemId.length > 128) return false;
  if (args.repository !== undefined && (typeof args.repository !== "string" || !args.repository.trim() || args.repository.length > 4096)) return false;
  if (args.ref !== undefined && (typeof args.ref !== "string" || !args.ref.trim() || args.ref.length > 4096)) return false;
  if (args.expiresAt !== undefined && (typeof args.expiresAt !== "string" || !args.expiresAt.trim() || args.expiresAt.length > 64)) return false;
  if (args.paths !== undefined && (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 64
    || args.paths.some(path => typeof path !== "string" || !path.trim() || path.length > 512))) return false;
  return true;
}

// Reads current work between stages. An unknown response keeps the same
// request id and does not mark the host working.
export async function beginSelectedWork({ connected, read, execute, scope = null, now = Date.now() } = {}) {
  if (connected !== true) {
    return { working: false, confirmed: [], stopped: "disconnected", invented: false };
  }
  const confirmed = [];
  const seen = new Set();
  for (let step = 0; step < 4; step += 1) {
    let context;
    try {
      context = await read();
    } catch {
      return { working: false, confirmed, stopped: "unknown",
        resume: { tool: "room_read_work", workItemId: scope?.workItemId ?? null }, invented: false };
    }
    if (!context?.work || !context.viewer) {
      return { working: false, confirmed, stopped: "unknown",
        resume: { tool: "room_read_work", workItemId: scope?.workItemId ?? null }, invented: false };
    }
    const plan = planBegin(context.work, context.viewer, { scope, now });
    if (!plan.stage) {
      const started = confirmed.some(row => row.action === "room_start_work") && context.work.state === "working";
      return {
        working: started, confirmed, invented: false,
        stopped: plan.reason === "ready" ? null : plan.reason,
        next: plan.next, resume: plan.resume ?? null
      };
    }
    if (seen.has(plan.stage.requestId)) {
      return { working: false, confirmed, stopped: "unknown", resume: plan.stage, invented: false };
    }
    seen.add(plan.stage.requestId);
    let result;
    try {
      result = await execute(plan.stage);
    } catch {
      return { working: false, confirmed, stopped: "unknown", resume: plan.stage, invented: false };
    }
    if (!result || result.status === "unconfirmed" || result.status === "unknown") {
      return { working: false, confirmed, stopped: "unknown", resume: plan.stage, invented: false };
    }
    if (result.status !== "recorded" && result.status !== "confirmed") {
      return { working: false, confirmed, stopped: "refused", refusal: result.code || result.status,
        resume: plan.stage, invented: false };
    }
    confirmed.push({ action: plan.stage.action, requestId: plan.stage.requestId, eventId: result.eventId ?? null });
  }
  return { working: false, confirmed, stopped: "unknown", invented: false };
}
