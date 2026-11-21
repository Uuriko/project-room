// One Begin for already selected work. It performs the next verified Room
// operations and reports each confirmed stage. It does not invent success,
// and a disconnected host is never called working.
import { createHash } from "node:crypto";
import { activeClaim } from "../src/workflow.js";

const SCOPE_NEEDS = Object.freeze(["repository", "ref", "paths", "expiresAt"]);
// Read-side interpretation of prerequisite observations ({id,state,satisfied})
// from a selected-work read. Advisory only: claim/start admission rechecks.
// Anything not established as satisfied holds an execution recommendation;
// a missing list is unknown, never ready. Returns null when nothing is awaited.
export const PREREQUISITE_GATED_STEPS = Object.freeze(["claim", "start"]);
export function prerequisiteHold(dependencies) {
  if (!Array.isArray(dependencies)) return { known: false, waitingOn: [], more: 0 };
  const unmet = dependencies.filter(dep => dep?.satisfied !== true);
  if (!unmet.length) return null;
  return { known: true, waitingOn: unmet.slice(0, 3).map(dep => ({ id: dep.id, state: typeof dep.state === "string" ? dep.state : "unknown" })),
    more: Math.max(0, unmet.length - 3) };
}


export function stepWithPrerequisiteHold(step, hold) {
  if (!hold || !PREREQUISITE_GATED_STEPS.includes(step.action)) return step;
  return { ...step, action: "wait_prerequisites", label: "Wait for prerequisites", needsAttention: false,
    waitingOn: hold.waitingOn, ...(hold.more ? { waitingOnMore: hold.more } : {}) };
}

function canonicalBeginInput(input) {
  const scope = input || {};
  const paths = Array.isArray(scope.paths) ? scope.paths : [];
  return JSON.stringify([scope.repository ?? "", scope.ref ?? "", paths, scope.expiresAt ?? ""]);
}

// Scoped writes bind the stage ID to the reservation. Unscoped stages keep
// the work/action/revision ID.
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
  let input = null;
  if (action === "room_start_work") input = item.claim ?? null;
  if (action === "room_acquire_claim" || action === "room_accept_work" && item.mode === "write" && validScope(scope)) input = scope;
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
    return { stage: stage("room_accept_work", item, item.revision, scope), reason: null, next: "accept" };
  }
  if (item.mode === "write" && !ownClaim && ["accepted", "working"].includes(item.state)) {
    if (!can("write_external") && !(item.externalWriteGrantBy && item.externalWriteGrantFor === member.id)) return { stage: null, reason: "permission", next: "claim" };
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
  if (!keys.includes("workItemId") || keys.some(key => !["workItemId", "repository", "ref", "paths", "expiresAt", "invocationRequestId", "expectedRevision"].includes(key))) return false;
  if (!idOk(args.workItemId)) return false;
  if (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || args.expectedRevision >= Number.MAX_SAFE_INTEGER)) return false;
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

// The command receipt key. It identifies the recorded operation, not a guessed revision.
export function operationKey(memberId, requestId) {
  return createHash("sha256").update(`${memberId}:${requestId}`).digest("hex");
}

function beginReceipt(event, requestId, item) {
  if (!event || !item || !requestId) return null;
  if (!["work.accepted", "claim.acquired", "work.started"].includes(event.type) || event.data?.workItemId !== item.id) return null;
  if (event.actorId !== item.accountableMemberId) return null;
  if (event.idempotencyKey !== operationKey(item.accountableMemberId, requestId)) return null;
  return {
    action: { "work.accepted": "room_accept_work", "claim.acquired": "room_acquire_claim", "work.started": "room_start_work" }[event.type],
    requestId, eventId: event.id, type: event.type,
    ...(event.type === "claim.acquired" ? { scope: {
      repository: event.data.repository, ref: event.data.ref, paths: event.data.paths, expiresAt: event.data.expiresAt
    }, acquiredAt: event.at } : {}),
    workItemId: event.data.workItemId, actorId: event.actorId,
    expectedRevision: event.data.expectedRevision ?? null
  };
}

export function exactBeginReceipt(receipt, page, item) {
  const row = page.events.find(entry => (entry.event ?? entry).id === receipt.eventId);
  return row ? beginReceipt(row.event ?? row, receipt.operationId, item) : null;
}

// Pages are { events, next, hasMore }. A missing receipt is null, not a guessed revision.
export async function findBeginReceipt(pages, requestId, item) {
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = await pages(after);
    for (const row of result?.events || []) {
      const found = beginReceipt(row.event || row, requestId, item);
      if (found) return found;
    }
    if (!result?.hasMore) return null;
    if (!Number.isSafeInteger(result.next) || result.next <= after) return null;
    after = result.next;
  }
  return null;
}

function preservedResume(pending, stage) {
  return {
    requestId: pending.requestId,
    action: pending.action ?? null,
    expectedRevision: pending.expectedRevision ?? null,
    args: pending.args ?? null,
    ...(stage ? { planned: {
      action: stage.action, requestId: stage.requestId,
      expectedRevision: stage.expectedRevision, args: stage.args
    } } : {})
  };
}

// A retry without a stage ID can advance only across a complete consecutive
// chain of its own accepted, claimed and started operations. Gaps and other
// writers remain stale, even if the current state looks workable.
async function recoverBeginChain({ work, viewer }, scope, requiredRevision, receipts, now) {
  if (!receipts || viewer.active === false || viewer.id !== work.accountableMemberId
    || !["accepted", "working"].includes(work.state)) return null;
  const reserve = work.mode === "write";
  if (reserve && work.claim && (!activeClaim(work, now) || work.claim.holderId !== viewer.id
    || requestedScope(scope) && !sameExactScope(work.claim, scope))) return null;
  const actions = ["room_accept_work"];
  if (reserve && validScope(scope) && work.claim && sameExactScope(work.claim, scope)) actions.push("room_acquire_claim");
  if (work.state === "working" && (!reserve || work.claim)) actions.push("room_start_work");
  if (work.revision - requiredRevision > actions.length) return null;
  const confirmed = [];
  let actionIndex = 0;
  for (let revision = requiredRevision; revision < work.revision; revision++) {
    const lastChoice = actions.length - (work.revision - revision);
    let found = null;
    while (actionIndex <= lastChoice) {
      const action = actions[actionIndex++];
      const { requestId } = stage(action, work, revision, scope);
      const receipt = await receipts(requestId, work);
      if (receipt?.requestId !== requestId || receipt.action !== action || receipt.workItemId !== work.id
        || receipt.actorId !== viewer.id || receipt.expectedRevision !== revision || !receipt.eventId) continue;
      if (action === "room_acquire_claim" && (!sameExactScope(receipt.scope, scope) || receipt.acquiredAt !== work.claim.acquiredAt)) return null;
      found = { action, requestId, eventId: receipt.eventId };
      break;
    }
    if (!found) return null;
    confirmed.push(found);
  }
  return confirmed;
}

// Reads current work between stages. An unknown response keeps the same
// request id. working is Room work state, not an external host start.
// invocation pins an unknown stage. A different id is not executed unless the
// exact claim or its recorded operation receipt already landed. A later revision
// is not proof. A guarded retry can recover a verified chain without a stage ID.
export async function beginSelectedWork({ connected, read, execute, scope = null, now = Date.now(), invocation = null, receipts = null, expectedRevision } = {}) {
  if (connected !== true) {
    return { working: false, roomState: null, confirmed: [], stopped: "disconnected", invented: false };
  }
  const confirmed = [];
  const seen = new Set();
  let pending = invocation?.requestId ? invocation : null;
  let requiredRevision = expectedRevision;
  const refresh = { tool: "room_read_work", workItemId: scope?.workItemId ?? null };
  const stale = context => stoppedResult(context, { confirmed, stopped: "stale_revision", resume: refresh,
    next: context.next?.action ?? null });
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
    if (requiredRevision !== undefined && context.work.revision < requiredRevision) return stale(context);
    if (!pending && requiredRevision !== undefined && context.work.revision > requiredRevision) {
      if (step !== 0) return stale(context);
      let recovered;
      try {
        recovered = await recoverBeginChain(context, scope, requiredRevision, receipts, now);
      } catch {
        return stoppedResult(context, { confirmed, stopped: "unknown", resume: refresh });
      }
      if (!recovered) return stale(context);
      confirmed.push(...recovered);
      requiredRevision = context.work.revision;
    }
    const plan = planBegin(context.work, context.viewer, { scope, now });
    if (requiredRevision !== undefined && pending && !plan.stage) {
      try {
        const found = receipts ? await receipts(pending.requestId, context.work) : null;
        if (plan.reason === "ready" && found?.type === "work.started"
            && found.requestId === pending.requestId && found.workItemId === context.work.id
            && found.actorId === context.viewer.id && Number.isSafeInteger(found.expectedRevision)
            && found.expectedRevision >= requiredRevision
            && found.expectedRevision + 1 === context.work.revision) {
          confirmed.push({ action: found.action, requestId: found.requestId, eventId: found.eventId });
          return readResult(context, plan, confirmed);
        }
      } catch {
        return stoppedResult(context, { confirmed, stopped: "unknown", resume: preservedResume(pending) });
      }
      return stale(context);
    }
    if (!plan.stage) return readResult(context, plan, confirmed);
    // Older clients can already hold the unscoped accept ID. Preserve that
    // explicitly pinned operation at its original revision across upgrades.
    if (pending && plan.stage.action === "room_accept_work" && context.work.mode === "write"
        && (requiredRevision === undefined || requiredRevision === context.work.revision)
        && pending.requestId === beginRequestId(context.work.id, plan.stage.action, context.work.revision)) {
      plan.stage.requestId = pending.requestId;
      plan.stage.args.requestId = pending.requestId;
    }
    if (pending && plan.stage.requestId !== pending.requestId) {
      let claim = claimLanded(context.work, scope, pending);
      let accept = null;
      if (!claim && plan.stage.action !== "room_accept_work") {
        try {
          const found = receipts ? await receipts(pending.requestId, context.work) : null;
          const matches = found && found.requestId === pending.requestId
            && found.workItemId === context.work.id && found.actorId === context.work.accountableMemberId;
          if (requiredRevision !== undefined && matches && (found.expectedRevision < requiredRevision
              || !Number.isSafeInteger(found.expectedRevision) || found.expectedRevision + 1 !== context.work.revision)) return stale(context);
          accept = matches && found.type === "work.accepted" ? found : null;
          claim = Boolean(matches && found.type === "claim.acquired"
            && activeClaim(context.work, now) && context.work.claim.holderId === found.actorId
            && context.work.claim.acquiredAt === found.acquiredAt
            && sameExactScope(found.scope, scope) && sameExactScope(context.work.claim, scope));
        } catch {
          return stoppedResult(context, {
            confirmed, stopped: "unknown", resume: preservedResume(pending, plan.stage),
            currentClaim: plan.currentClaim ?? claimView(context.work), next: plan.next
          });
        }
      }
      if (!claim && !accept) {
        return stoppedResult(context, {
          confirmed, stopped: "invocation_mismatch", resume: preservedResume(pending, plan.stage),
          currentClaim: plan.currentClaim ?? claimView(context.work), next: plan.next
        });
      }
      pending = null;
    }
    if (pending && requiredRevision !== undefined && plan.stage.expectedRevision < requiredRevision) return stale(context);
    // Known unfinished prerequisites: stop before a claim/start that admission
    // would refuse. Accept still runs; an absent observation is left to admission.
    const hold = plan.stage.action !== "room_accept_work" && Array.isArray(context.dependencies)
      ? prerequisiteHold(context.dependencies) : null;
    if (hold) {
      return { ...stoppedResult(context, { confirmed, stopped: "waiting_on_prerequisites", next: plan.next,
        resume: { tool: "room_read_work", workItemId: context.work.id } }),
        waitingOn: hold.waitingOn, ...(hold.more ? { waitingOnMore: hold.more } : {}) };
    }
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
    if (requiredRevision !== undefined) requiredRevision = plan.stage.expectedRevision + 1;
    pending = null;
  }
  return { working: false, roomState: null, confirmed, stopped: "unknown", invented: false };
}
