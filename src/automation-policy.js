// Shared-automation policy. Persistence and authenticated dispatch live in events/store.
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
export async function confirmsAutomationCommand(receipt, command, expectedData, roomId, memberId) {
  const e = receipt?.event;
  const canonical = value => Array.isArray(value) ? JSON.stringify(value) : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  if (!Number.isSafeInteger(receipt?.sequence) || receipt.sequence < 1 || typeof receipt.duplicate !== "boolean"
    || !id(e?.id) || e.type !== command.type || e.roomId !== roomId || e.actorId !== memberId
    || e.causationId !== (command.causationId ?? null) || !timestamp(e.at) || canonical(e.data) !== canonical(expectedData)) return false;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${memberId}:${command.id}`));
  return e.idempotencyKey === [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export const AUTOMATION_MESSAGE_FIELDS = ["automationId", "automationRevision", "automationSlot"];
export const isAutomationDispatch = data => AUTOMATION_MESSAGE_FIELDS.some(key => Object.hasOwn(data, key));
export function validAutomationRequest(value) {
  return Boolean(exact(value, ["id", "revision", "slot", "maxRuntimeMs", "maxOutputBytes"]) && id(value.id)
    && integer(value.revision) && value.revision > 0 && integer(value.slot)
    && Number.isSafeInteger(value.maxRuntimeMs) && value.maxRuntimeMs >= 1 && value.maxRuntimeMs <= 300000
    && Number.isSafeInteger(value.maxOutputBytes) && value.maxOutputBytes >= 1 && value.maxOutputBytes <= 1048576);
}
export function validateAutomationDispatch(data) {
  check(exact(data, ["messageId", ...AUTOMATION_MESSAGE_FIELDS]) && id(data.messageId) && id(data.automationId)
    && integer(data.automationRevision) && integer(data.automationSlot), "Invalid automation dispatch selection");
}
export function prepareAutomationDispatch(state, actorId, data, now) {
  validateAutomationDispatch(data);
  check(!state.messages.some(message => message.id === data.messageId), "Message already exists");
  check(!state.agentHalts?.[actorId], "Clear the recorded halt before dispatching automation");
  return transitionAutomation({ automation: state.automations?.[data.automationId] ?? null, actorId,
    roomOwnerId: state.room.ownerId, members: state.members, requests: state.replyRequests, runs: state.requestRuns },
  "dispatch", { expectedRevision: data.automationRevision, requestMessageId: data.messageId, slot: data.automationSlot }, now);
}
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

// Presentation/preview only. Every subsequent command rechecks committed state.
export function automationPreview(state, automationId, viewerId, now, includeDefinition = false) {
  const automation = state.automations?.[automationId];
  check(automation && active(state.members, viewerId) && timestamp(now), "Unknown automation or participant");
  const owner = viewerId === automation.ownerId, recipient = viewerId === automation.definition.recipientId;
  const available = active(state.members, automation.ownerId) && active(state.members, automation.definition.recipientId);
  const inFlight = automationInFlight(automation, state.replyRequests, state.requestRuns);
  const due = automationDue(automation, { members: state.members, requests: state.replyRequests, runs: state.requestRuns }, now);
  const halted = Boolean(state.agentHalts?.[automation.ownerId]);
  const status = !available ? "unavailable" : !automation.ownerEnabled && !automation.recipientAccepted ? "paused"
    : !automation.ownerEnabled ? "needs_creator" : !automation.recipientAccepted ? "needs_recipient"
      : automation.dispatchCount >= automation.definition.maxRuns ? "exhausted" : inFlight ? "in_flight"
        : halted ? "halted" : due ? "ready" : "waiting";
  const trigger = automation.definition.trigger;
  const nextDueAt = trigger.kind === "interval" && ["ready", "waiting"].includes(status)
    ? new Date(Date.parse(trigger.startAt) + (due?.slot ?? Math.max(0, (automation.lastSlot ?? -1) + 1)) * trigger.intervalMs).toISOString() : null;
  return { id: automation.id, revision: automation.revision, title: automation.definition.title,
    ownerId: automation.ownerId, recipientId: automation.definition.recipientId, status,
    remainingRuns: automation.definition.maxRuns - automation.dispatchCount,
    nextSlot: status === "ready" ? due.slot : null, nextDueAt, lastRequestId: automation.lastRequestId,
    ...(includeDefinition ? { definition: structuredClone(automation.definition),
      consent: { creator: automation.ownerEnabled, recipient: automation.recipientAccepted },
      actions: { edit: owner && !inFlight, enable: owner && available && !automation.ownerEnabled,
        accept: recipient && available && !automation.recipientAccepted,
        pause: (owner || recipient || viewerId === state.room.ownerId && state.members[viewerId].kind === "human")
          && (automation.ownerEnabled || automation.recipientAccepted), dispatch: owner && status === "ready" },
      backgroundDispatchEnabled: false } : {}) };
}

export function validAutomationPreview(value, selected = false) {
  if (!exact(value, ["id", "revision", "title", "ownerId", "recipientId", "status", "remainingRuns", "nextSlot", "nextDueAt", "lastRequestId",
    ...(selected ? ["definition", "consent", "actions", "backgroundDispatchEnabled"] : [])])) return false;
  if (![value.id, value.ownerId, value.recipientId].every(id) || !integer(value.revision) || value.revision < 1 || !text(value.title, 80)
    || !["unavailable", "paused", "needs_creator", "needs_recipient", "exhausted", "in_flight", "halted", "ready", "waiting"].includes(value.status)
    || !integer(value.remainingRuns) || value.remainingRuns > 100 || !(value.nextSlot === null || integer(value.nextSlot))
    || (value.status === "ready") !== (value.nextSlot !== null) || !(value.nextDueAt === null || timestamp(value.nextDueAt))
    || !(value.lastRequestId === null || id(value.lastRequestId))) return false;
  if (!selected) return true;
  try { validateAutomationDefinition(value.definition); } catch { return false; }
  return value.definition.title === value.title && value.definition.recipientId === value.recipientId
    && value.remainingRuns <= value.definition.maxRuns && value.backgroundDispatchEnabled === false
    && exact(value.consent, ["creator", "recipient"]) && Object.values(value.consent).every(v => typeof v === "boolean")
    && exact(value.actions, ["edit", "enable", "accept", "pause", "dispatch"]) && Object.values(value.actions).every(v => typeof v === "boolean");
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
