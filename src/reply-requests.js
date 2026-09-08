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
