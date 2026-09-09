// Shared request semantics. Deliberately independent of events, storage and UI.
export const REPLY_CANCELLED = "reply_request.cancelled";
export const REPLY_POLICY_VERSION = 1;
export const MAX_REPLY_REQUESTS = 500;
export const REPLY_FIELDS = Object.freeze(["requestKind", "responseToRequestId", "expectedRequestRevision", "responseOutcome", "contextEventId", "contextSequence"]);
const own = (value, key) => Object.hasOwn(value, key);
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);
const text = value => typeof value === "string" && value.length <= 4096 && value.trim().length > 0;
const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const requireValid = (valid, message) => { if (!valid) throw new Error(message); };

// Browser drafts have a separate identity for each explicit mode, even inside
// one conversation. Keys cannot collide with a canonical message ID.
export function replyDraftKey(mode, threadId = null) {
  if (mode?.kind === "request" && mode.resultEventId) return JSON.stringify(["result-question", mode.workItemId, mode.resultEventId]);
  return mode ? JSON.stringify(["request", mode.kind, mode.requestMessageId ?? threadId]) : threadId;
}
const resultReceipt = (state, mode) => {
  const work = state.workItems?.[mode.workItemId];
  return [...(work?.receiptHistory ?? []), work?.receipt].find(receipt => receipt?.eventId === mode.resultEventId);
};
// A question gathers context. It never changes credit, work state or review authority.
export function creditQuestion(state, workItemId, memberId, resultEventId) {
  const work = state.workItems?.[workItemId], receipt = work?.receipt;
  if (!receipt || receipt.eventId !== resultEventId || !state.members?.[memberId] || state.members[memberId].active === false) return null;
  const mode = { kind: "request", workItemId, resultEventId, resultMessageId: receipt.nativeText?.messageId ?? null };
  if (!validReplyDraft(mode, state)) return null;
  const reporter = receipt.reportedById, member = state.members[reporter];
  const credit = receipt.externalProducer ?? "Not reported";
  return { mode, toMemberId: reporter !== memberId && member?.active !== false && member ? reporter : "",
    replyToId: mode.resultMessageId,
    body: `Who contributed to this result, and what did each person or AI do?\n\nReported credit: ${credit}`
      + (receipt.nativeText ? "" : `\nResult record: ${receipt.eventId}`) };
}
export function validReplyDraft(mode, state) {
  if (!mode || typeof mode !== "object" || Array.isArray(mode)) return false;
  if (mode.kind === "request") {
    if (Object.keys(mode).length === 1) return true;
    const keys = ["kind", "workItemId", "resultEventId", "resultMessageId"], receipt = resultReceipt(state, mode);
    return Object.keys(mode).length === keys.length && keys.every(key => own(mode, key))
      && id(mode.workItemId) && id(mode.resultEventId) && Boolean(receipt)
      && mode.resultMessageId === (receipt.nativeText?.messageId ?? null)
      && (mode.resultMessageId === null || state.messages?.some(message => message.id === mode.resultMessageId && message.workItemId === mode.workItemId));
  }
  const request = state.replyRequests?.[mode.requestMessageId];
  const keys = ["kind", "requestMessageId", "expectedRequestRevision", "requesterId", "workItemId", "contextEventId", "contextSequence"];
  return ["answered", "declined", "cancelled"].includes(mode.kind) && request
    && Object.keys(mode).length === keys.length && keys.every(key => own(mode, key))
    && revision(mode.expectedRequestRevision) && mode.expectedRequestRevision <= request.revision
    && mode.requesterId === request.requesterId && mode.workItemId === request.workItemId
    && id(mode.contextEventId) && Number.isSafeInteger(mode.contextSequence) && mode.contextSequence > 0;
}
export function replyDraftData(mode, { body, toMemberId, replyToId, messageId }) {
  if (!mode) return { ...(messageId === undefined ? {} : { messageId }), body, toMemberId, replyToId };
  if (mode.kind === "cancelled") return { requestMessageId: mode.requestMessageId,
    expectedRequestRevision: mode.expectedRequestRevision, reason: body };
  const data = mode.kind === "request" ? { messageId, body, toMemberId, replyToId, requestKind: "reply",
      ...(mode.resultEventId ? { workItemId: mode.workItemId, replyToId: mode.resultMessageId } : {}) }
    : { messageId, body, toMemberId: mode.requesterId, replyToId: mode.requestMessageId,
      workItemId: mode.workItemId, responseToRequestId: mode.requestMessageId,
      expectedRequestRevision: mode.expectedRequestRevision, responseOutcome: mode.kind,
      contextEventId: mode.contextEventId, contextSequence: mode.contextSequence };
  replyPostMode(data);
  return data;
}
export async function confirmsReplyCommand(receipt, command, roomId, memberId) {
  const event = receipt?.event, expected = { ...command.data };
  if (command.type === "message.posted") expected.requestPolicyVersion = REPLY_POLICY_VERSION;
  if (!Number.isSafeInteger(receipt?.sequence) || receipt.sequence < 1 || typeof receipt.duplicate !== "boolean"
    || !id(event?.id) || event.type !== command.type || event.roomId !== roomId || event.actorId !== memberId
    || event.causationId !== (command.causationId ?? null) || !event.data
    || Object.keys(event.data).length !== Object.keys(expected).length
    || !Object.keys(expected).every(key => own(event.data, key) && event.data[key] === expected[key])) return false;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${memberId}:${command.id}`));
  return event.idempotencyKey === [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// Commands use this strict validator before the service stamps the event. Old
// unmarked events may contain ignored fields; they must remain ordinary messages.
export function replyPostMode(data) {
  const fields = REPLY_FIELDS.filter(key => own(data, key));
  if (!fields.length) return null;
  requireValid(id(data.messageId) && text(data.body), "Reply requests require an explicit message and text");
  requireValid(!["packetId", "basisRevision", "allowOlderBasis"].some(key => own(data, key)), "Reply requests cannot include proposal fields");
  if (own(data, "requestKind")) {
    requireValid(fields.length === 1 && data.requestKind === "reply" && id(data.toMemberId), "Invalid reply request fields");
    return "open";
  }
  requireValid(fields.length === REPLY_FIELDS.length - 1 && id(data.responseToRequestId)
    && revision(data.expectedRequestRevision) && ["answered", "declined"].includes(data.responseOutcome)
    && id(data.contextEventId) && Number.isSafeInteger(data.contextSequence) && data.contextSequence > 0,
  "Invalid reply response fields");
  requireValid(id(data.replyToId) && id(data.toMemberId) && own(data, "workItemId")
    && (data.workItemId === null || id(data.workItemId)), "Reply responses require exact conversation links");
  return "respond";
}

export function replyRequest(state, requestMessageId) {
  requireValid(id(requestMessageId) && state.replyRequests && own(state.replyRequests, requestMessageId), "Unknown reply request");
  return state.replyRequests[requestMessageId];
}

function openRevision(request, expected) {
  requireValid(revision(expected) && expected === request.revision, "Stale reply request revision");
  requireValid(request.status === "open", "Invalid transition: reply request is no longer open");
}

export function prepareReplyPost(state, incoming) {
  if (!own(incoming.data, "requestPolicyVersion")) return null;
  requireValid(incoming.data.requestPolicyVersion === REPLY_POLICY_VERSION, "Unsupported reply request policy");
  const mode = replyPostMode(incoming.data);
  requireValid(mode, "Reply request policy requires explicit request fields");
  const data = incoming.data;
  const allowed = ["messageId", "body", "workItemId", "replyToId", "toMemberId", "requestPolicyVersion", ...REPLY_FIELDS];
  requireValid(Object.keys(data).every(key => allowed.includes(key)), "Unexpected reply request fields");
  if (mode === "open") {
    requireValid(data.toMemberId !== incoming.actorId, "A reply request needs another participant");
    requireValid(Object.keys(state.replyRequests ?? {}).length < MAX_REPLY_REQUESTS, "Reply request capacity reached");
  } else {
    const request = replyRequest(state, data.responseToRequestId);
    openRevision(request, data.expectedRequestRevision);
    requireValid(incoming.actorId === request.recipientId, "Only the requested participant may answer or decline");
    requireValid(data.replyToId === request.id && data.toMemberId === request.requesterId && data.workItemId === request.workItemId,
      "Reply response conversation links changed");
    requireValid(data.contextEventId === request.contextEventId, "Stale reply request context");
  }
  return mode;
}

// Each message belongs to its nearest explicit request, until a different-work
// branch intervenes. Descendants cannot escape an excluded branch accidentally.
export function replyContextOwners(state) {
  const owners = new Map(), requests = state.replyRequests ?? {};
  for (const message of state.messages) {
    if (own(requests, message.id)) { owners.set(message.id, message.id); continue; }
    const parent = owners.get(message.replyToId), request = parent && requests[parent];
    if (request && (!message.workItemId || message.workItemId === request.workItemId)) owners.set(message.id, parent);
  }
  return owners;
}

export function recordReplyPost(state, incoming, mode) {
  const data = incoming.data, messageId = data.messageId || incoming.id;
  if (mode === "open") {
    state.replyRequests ??= {};
    state.replyRequests[messageId] = {
      id: messageId, openingEventId: incoming.id, requesterId: incoming.actorId,
      recipientId: data.toMemberId, workItemId: data.workItemId || null,
      status: "open", revision: 0, createdAt: incoming.at,
      contextEventId: incoming.id, contextMessageId: messageId,
      terminalEventId: null, terminalActorId: null, closedAt: null,
      responseMessageId: null, responseContextSequence: null, reason: null
    };
  } else if (mode === "respond") {
    Object.assign(replyRequest(state, data.responseToRequestId), {
      status: data.responseOutcome, revision: data.expectedRequestRevision + 1,
      terminalEventId: incoming.id, terminalActorId: incoming.actorId, closedAt: incoming.at,
      responseMessageId: messageId, responseContextSequence: data.contextSequence
    });
  } else if (state.replyRequests) {
    const requestId = replyContextOwners(state).get(messageId), request = requestId && state.replyRequests[requestId];
    if (request?.status === "open") Object.assign(request, { contextEventId: incoming.id, contextMessageId: messageId });
  }
}

export function cancelReplyRequest(state, incoming) {
  const data = incoming.data, actor = state.members[incoming.actorId];
  requireValid(Object.keys(data).length === 3 && Object.keys(data).every(key =>
    ["requestMessageId", "expectedRequestRevision", "reason"].includes(key)), "Unexpected reply cancellation fields");
  const request = replyRequest(state, data.requestMessageId);
  requireValid(actor && actor.active !== false, "Inactive reply request actor");
  requireValid(incoming.actorId === request.requesterId || actor.kind === "human" && incoming.actorId === state.room.ownerId,
    "Only the requester or Room owner may cancel");
  requireValid(text(data.reason), "Cancellation needs a reason");
  openRevision(request, data.expectedRequestRevision);
  Object.assign(request, { status: "cancelled", revision: data.expectedRequestRevision + 1,
    terminalEventId: incoming.id, terminalActorId: incoming.actorId, closedAt: incoming.at, reason: data.reason });
}
