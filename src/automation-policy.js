// Pure shared-automation policy. Not registered as service commands yet.
// Caller must supply authenticated actor and committed room state atomically.
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const active = (members, memberId) => id(memberId) && members?.[memberId]?.active === true && ["human", "agent"].includes(members[memberId].kind);
export const AUTOMATION_LIMIT = 100;
const definitionFields = ["title", "prompt", "recipientId", "trigger", "maxRuns", "maxRuntimeMs", "maxOutputBytes"];

export function validateAutomationDefinition(value) {
  check(exact(value, definitionFields) && text(value.title, 80) && text(value.prompt, 4096) && id(value.recipientId), "Invalid automation definition");
  const trigger = value.trigger;
  check(exact(trigger, ["kind"]) && trigger.kind === "manual"
    || exact(trigger, ["kind", "startAt", "intervalMs"]) && trigger.kind === "interval" && timestamp(trigger.startAt)
      && Number.isSafeInteger(trigger.intervalMs) && trigger.intervalMs >= 60000 && trigger.intervalMs <= 2592000000,
  "Choose a bounded manual or interval trigger");
  check(Number.isSafeInteger(value.maxRuns) && value.maxRuns >= 1 && value.maxRuns <= 100
    && Number.isSafeInteger(value.maxRuntimeMs) && value.maxRuntimeMs >= 1 && value.maxRuntimeMs <= 300000
    && Number.isSafeInteger(value.maxOutputBytes) && value.maxOutputBytes >= 1 && value.maxOutputBytes <= 1048576,
  "Invalid automation limits");
  return value;
}

// Closed requests do not free an execution that is still running/unconfirmed.
export function automationInFlight(automation, requests, runs) {
  const requestId = automation.lastRequestId;
  if (requestId === null) return false;
  const request = requests?.[requestId], run = runs?.[requestId];
  return Boolean(!request || !["answered", "declined", "cancelled"].includes(request.status)
    || run && !["succeeded", "failed", "cancelled"].includes(run.status));
}

export function automationDue(automation, { members, requests = {}, runs = {} }, now) {
  if (!automation || !timestamp(now) || !automation.ownerEnabled || !automation.recipientAccepted
    || !active(members, automation.ownerId) || !active(members, automation.definition.recipientId)
    || automation.dispatchCount >= automation.definition.maxRuns || automationInFlight(automation, requests, runs)) return null;
  const trigger = automation.definition.trigger;
  if (trigger.kind === "manual") return { slot: automation.dispatchCount, kind: "manual" };
  const elapsed = Date.parse(now) - Date.parse(trigger.startAt);
  if (elapsed < 0) return null;
  const slot = Math.floor(elapsed / trigger.intervalMs);
  // Only the latest due slot, never a catch-up burst. Revision is part of dispatch identity.
  return automation.lastSlot !== null && slot <= automation.lastSlot ? null : { slot, kind: "interval" };
}

export function transitionAutomation({ automation = null, actorId, roomOwnerId, members, automationCount = 0,
  requests = {}, runs = {} }, action, data, now) {
  check(active(members, actorId) && timestamp(now), "Active participant and server time required");
  check(integer(data?.expectedRevision) && data.expectedRevision === (automation?.revision ?? 0), "Automation revision changed");
  check(!automation || Date.parse(now) >= Date.parse(automation.updatedAt), "Automation time moved backwards");
  if (action === "create") {
    check(!automation && integer(automationCount) && automationCount < AUTOMATION_LIMIT && exact(data, ["expectedRevision", "automationId", "definition"]) && id(data.automationId), "Cannot create automation");
    validateAutomationDefinition(data.definition);
    check(data.definition.recipientId !== actorId && active(members, data.definition.recipientId), "Choose another active recipient");
    return { automation: { id: data.automationId, revision: 1, ownerId: actorId, definition: structuredClone(data.definition),
      ownerEnabled: false, recipientAccepted: false, dispatchCount: 0, lastSlot: null, lastRequestId: null, createdAt: now, updatedAt: now }, message: null };
  }
  check(automation, "Unknown automation");
  const next = structuredClone(automation);
  if (action === "update") {
    check(actorId === automation.ownerId && exact(data, ["expectedRevision", "definition"]), "Only the owner can edit scope");
    check(!automationInFlight(automation, requests, runs), "Previous request is still in flight");
    validateAutomationDefinition(data.definition);
    check(data.definition.recipientId !== actorId && active(members, data.definition.recipientId)
      && data.definition.maxRuns >= automation.dispatchCount, "Invalid recipient or remaining budget");
    Object.assign(next, { definition: structuredClone(data.definition), ownerEnabled: false, recipientAccepted: false, lastSlot: null });
  } else if (["enable", "accept", "pause"].includes(action)) {
    check(exact(data, ["expectedRevision"]), "Unexpected consent fields");
    if (action === "pause") {
      check(actorId === automation.ownerId || actorId === automation.definition.recipientId
        || actorId === roomOwnerId && members[actorId].kind === "human", "Cannot pause this automation");
      check(automation.ownerEnabled || automation.recipientAccepted, "Automation already paused");
      next.ownerEnabled = false; next.recipientAccepted = false;
    } else {
      check(active(members, automation.ownerId) && active(members, automation.definition.recipientId), "Automation participant unavailable");
      check(actorId === (action === "enable" ? automation.ownerId : automation.definition.recipientId), "Cannot supply another participant's consent");
      check(!(action === "enable" ? automation.ownerEnabled : automation.recipientAccepted), "Consent already recorded");
      if (action === "enable") next.ownerEnabled = true; else next.recipientAccepted = true;
    }
  } else {
    check(action === "dispatch" && exact(data, ["expectedRevision", "requestMessageId", "slot"]), "Invalid automation action");
    check(actorId === automation.ownerId, "Dispatch requires the authenticated owner");
    const due = automationDue(automation, { members, requests, runs }, now);
    check(due && integer(data.slot) && data.slot === due.slot && id(data.requestMessageId) && !Object.hasOwn(requests, data.requestMessageId), "Automation is not ready for this dispatch");
    Object.assign(next, { dispatchCount: automation.dispatchCount + 1, lastSlot: due.slot, lastRequestId: data.requestMessageId });
  }
  next.revision += 1; next.updatedAt = now;
  return { automation: next, message: action === "dispatch" ? {
    messageId: data.requestMessageId, body: automation.definition.prompt, requestKind: "reply", toMemberId: automation.definition.recipientId,
    workItemId: null, automationId: automation.id, automationRevision: automation.revision, automationSlot: data.slot
  } : null };
}
