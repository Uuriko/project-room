// Pure policy for a request's execution, independent of Work Items.
// The service must supply authenticated actor/current request in one transaction.
// Registered as schema-v31 commands: see docs/REQUEST-RUN-CONTRACT.md.
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);
const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const requireValid = (condition, message) => { if (!condition) throw new Error(message); };
const terminal = status => ["succeeded", "failed", "cancelled"].includes(status);
export const REQUEST_RUN_MAX_ATTEMPTS = 3;

export function validRequestRun(run) {
  const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!exact(run, ["requestMessageId", "runId", "memberId", "status", "revision", "usedRunIds", "contextEventId", "instructionsRevision",
    "maxRuntimeMs", "maxOutputBytes", "startedAt", "updatedAt", "deadlineAt", "stoppedAt", "stopRequestedById"])) return false;
  return [run.requestMessageId, run.runId, run.memberId, run.contextEventId].every(id)
    && revision(run.revision) && run.revision > 0 && revision(run.instructionsRevision)
    && ["running", "stop_requested", "succeeded", "failed", "cancelled"].includes(run.status)
    && Array.isArray(run.usedRunIds) && run.usedRunIds.length >= 1 && run.usedRunIds.length <= REQUEST_RUN_MAX_ATTEMPTS
    && run.usedRunIds.every(id) && new Set(run.usedRunIds).size === run.usedRunIds.length && run.usedRunIds.at(-1) === run.runId
    && Number.isSafeInteger(run.maxRuntimeMs) && run.maxRuntimeMs >= 1 && run.maxRuntimeMs <= 300000
    && Number.isSafeInteger(run.maxOutputBytes) && run.maxOutputBytes >= 1 && run.maxOutputBytes <= 1048576
    && [run.startedAt, run.updatedAt, run.deadlineAt].every(timestamp)
    && Date.parse(run.updatedAt) >= Date.parse(run.startedAt)
    && Date.parse(run.deadlineAt) - Date.parse(run.startedAt) === run.maxRuntimeMs
    && (terminal(run.status) ? run.stoppedAt === run.updatedAt : run.stoppedAt === null)
    && (run.stopRequestedById === null || id(run.stopRequestedById))
    && (run.status !== "stop_requested" || id(run.stopRequestedById))
    && (run.status !== "running" || run.stopRequestedById === null)
    && (run.status !== "succeeded" || run.stopRequestedById === null && Date.parse(run.updatedAt) < Date.parse(run.deadlineAt));
}

export function requestRunView(state, requestMessageId, viewerId, now = new Date().toISOString()) {
  const run = state?.requestRuns?.[requestMessageId], request = state?.replyRequests?.[requestMessageId], viewer = state?.members?.[viewerId];
  if (!run || !request) return null;
  const labels = { running: "Run in progress", stop_requested: "Stop requested", succeeded: "Run finished", failed: "Run failed", cancelled: "Run cancelled" };
  const current = requestRunMayExecute(run, request, state.room.charter?.revision ?? 0, now);
  return { label: run.status === "running" && !current ? "Run unconfirmed" : labels[run.status] ?? "Run unconfirmed",
    canStop: run.status === "running" && viewer?.active === true && (viewerId === request.requesterId
      || viewerId === request.recipientId || viewerId === state.room.ownerId && viewer.kind === "human") };
}

export function requestRunMayExecute(run, request, instructionsRevision, now) {
  return Boolean(run && request && run.status === "running" && request.status === "open"
    && run.requestMessageId === request.id && run.memberId === request.recipientId
    && run.contextEventId === request.contextEventId && run.instructionsRevision === instructionsRevision
    && Number.isFinite(Date.parse(now)) && Date.parse(now) >= Date.parse(run.startedAt)
    && Date.parse(now) < Date.parse(run.deadlineAt));
}

export function transitionRequestRun({ run = null, request, actor, ownerId, instructionsRevision }, action, data, now) {
  requireValid(id(request?.id) && id(request?.recipientId) && id(request?.requesterId)
    && id(request?.contextEventId) && revision(instructionsRevision), "Invalid request context");
  requireValid(id(actor?.id) && actor.active === true, "Active participant required");
  requireValid(typeof now === "string" && Number.isFinite(Date.parse(now)) && new Date(now).toISOString() === now,
    "Canonical server time required");
  requireValid(!run || run.requestMessageId === request.id, "Run belongs to another request");
  requireValid(revision(data?.expectedRevision) && data.expectedRevision === (run?.revision ?? 0), "Run revision changed");
  requireValid(!run || Date.parse(now) >= Date.parse(run.updatedAt), "Run time moved backwards");

  if (action === "claim") {
    requireValid(exact(data, ["expectedRevision", "runId", "contextEventId", "instructionsRevision", "maxRuntimeMs", "maxOutputBytes"]), "Invalid claim fields");
    requireValid(actor.id === request.recipientId && request.status === "open", "Only the recipient can claim an open request");
    requireValid(id(data.runId) && data.contextEventId === request.contextEventId
      && data.instructionsRevision === instructionsRevision, "Request context changed");
    requireValid(!run || terminal(run.status), "Previous execution is not confirmed stopped");
    requireValid(Number.isSafeInteger(data.maxRuntimeMs) && data.maxRuntimeMs >= 1 && data.maxRuntimeMs <= 300000
      && Number.isSafeInteger(data.maxOutputBytes) && data.maxOutputBytes >= 1 && data.maxOutputBytes <= 1048576, "Invalid execution limits");
    const usedRunIds = run?.usedRunIds ?? [];
    requireValid(usedRunIds.length < REQUEST_RUN_MAX_ATTEMPTS && !usedRunIds.includes(data.runId), "Execution attempt unavailable");
    return { requestMessageId: request.id, runId: data.runId, memberId: actor.id, status: "running",
      revision: data.expectedRevision + 1, usedRunIds: [...usedRunIds, data.runId],
      contextEventId: data.contextEventId, instructionsRevision, maxRuntimeMs: data.maxRuntimeMs,
      maxOutputBytes: data.maxOutputBytes, startedAt: now, updatedAt: now,
      deadlineAt: new Date(Date.parse(now) + data.maxRuntimeMs).toISOString(), stoppedAt: null, stopRequestedById: null };
  }
  requireValid(run && !terminal(run.status) && id(data.runId) && data.runId === run.runId, "No matching active run");
  if (action === "request_stop") {
    requireValid(exact(data, ["expectedRevision", "runId"]), "Invalid stop fields");
    requireValid(actor.id === request.requesterId || actor.id === request.recipientId
      || actor.id === ownerId && actor.kind === "human", "Cannot stop this request run");
    requireValid(run.status === "running", "Stop already requested");
    return { ...structuredClone(run), status: "stop_requested", revision: run.revision + 1,
      updatedAt: now, stopRequestedById: actor.id };
  }
  requireValid(action === "finish" && exact(data, ["expectedRevision", "runId", "status"]), "Invalid finish fields");
  requireValid(actor.id === run.memberId && actor.id === request.recipientId, "Only the executing recipient can finish");
  requireValid(terminal(data.status), "Terminal execution status required");
  requireValid(data.status !== "succeeded" || requestRunMayExecute(run, request, instructionsRevision, now), "Run cannot report success");
  return { ...structuredClone(run), status: data.status, revision: run.revision + 1, updatedAt: now, stoppedAt: now };
}
