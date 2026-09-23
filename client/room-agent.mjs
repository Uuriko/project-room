import { workTemplate, WORK_TEMPLATES } from "../src/work-templates.js";
import { roomTemplate, ROOM_TEMPLATES } from "../src/room-templates.js";
import { projectBoard } from "../src/board.js";
import { validId, PERMISSIONS, WORK_STATES, AGENT_AUTONOMY_PERMISSIONS } from "../src/events.js";
import { nextWorkStep, workActions, reusableWorkDefinition, workCollaboration, workResume } from "../src/workflow.js";
import { isDeepStrictEqual } from "node:util";
import { searchWork, completedResults, currentResult } from "../src/work-selectors.js";
import { randomUUID } from "node:crypto";
import { workPacket, resultDraft, verifyWorkResult, resumeMarkdown } from "../src/work-packet.js";
import { submitWorkAction } from "./work-actions.mjs";
import { submitHelpAction } from "./help-actions.mjs";
import { replyRoute, validReplyArguments, validateReplyRead, submitReplyAction } from "./reply-actions.mjs";
import { charterContext, validateCharterContext, validateCharterRead } from "../src/room-charter.js";
import { workHelpContext } from "../src/work-help.js";
import { workOffersContext, MAX_HELP_OFFERS, MAX_PENDING_HELP_OFFERS } from "../src/help-offers.js";
import { AGENT_ERRORS, resolveAgentErrorAx } from "../src/agent-error.mjs";
import { edgeDoorApiPath } from "../deploy/agent-discovery.mjs";

export { AGENT_ERRORS };
export class RoomClientError extends Error {
  constructor(status, code, message, retryAfterMs = null, extras = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    const ax = resolveAgentErrorAx(status, code, message, extras);
    this.reason = ax.reason;
    this.hint = ax.hint;
    this.next = ax.next;
    this.errorStatus = ax.status;
  }
}
export const validWorkSearchQuery = query => typeof query === "string" && query.length <= 200 && query.trim().length > 0;
function checkedCharter(value, horizon) {
  try {
    const result = validateCharterContext(value);
    if (!Number.isSafeInteger(horizon) || result.revision > horizon) throw new Error();
    return result;
  } catch { throw new RoomClientError(200, "invalid_response", "Room returned invalid instructions metadata"); }
}

function checkedOffers(result) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  try {
    const read = result.offers, entries = read?.offers, a = read?.availability;
    if (result.offerContextVersion !== 1 || !object(read) || read.version !== 1
      || Object.keys(read).sort().join() !== "availability,offers,retainedOfferCount,version"
      || !Array.isArray(entries) || entries.length > MAX_HELP_OFFERS
      || !count(read.retainedOfferCount) || read.retainedOfferCount < entries.length || read.retainedOfferCount > MAX_HELP_OFFERS
      || !count(a?.pendingForViewer) || a.pendingForViewer > MAX_PENDING_HELP_OFFERS || a.pendingForViewer > read.retainedOfferCount) throw new Error();
    const members = Object.fromEntries(result.context.participants.filter(p => p.unavailable !== true).map(p => [p.id, p]));
    const rows = Object.fromEntries(entries.map(entry => {
      if (!object(entry?.offer) || entry.offer.workItemId !== result.work.id
        || entry.offer.revision > result.evaluatedThrough || entry.offer.invitation?.revision > result.evaluatedThrough
        || Date.parse(entry.offer.updatedAt) > Date.parse(result.evaluatedAt)) throw new Error();
      return [entry.offer.id, entry.offer];
    }));
    if (Object.keys(rows).length !== entries.length) throw new Error();
    const expected = workOffersContext({ room: { id: result.roomId, ownerId: result.context.roomOwnerId }, members,
      workItems: { [result.work.id]: result.work }, helpOffers: rows }, result.work.id, result.viewer.id, result.evaluatedAt);
    if (!isDeepStrictEqual(entries, expected.offers) || a.pendingForViewer < expected.availability.pendingForViewer) throw new Error();
    // These two room-wide counts are service facts, not reconstructed from a
    // selected-task export. All decisions/identities for this work are checked.
    const local = expected.availability;
    const reason = !result.help.canOffer ? "invitation_unavailable" : local.existingOfferId ? "already_offered"
      : local.selectedOfferId ? "helper_selected" : read.retainedOfferCount >= MAX_HELP_OFFERS ? "history_full"
        : local.pendingForWork >= MAX_PENDING_HELP_OFFERS ? "work_offer_limit"
          : a.pendingForViewer >= MAX_PENDING_HELP_OFFERS ? "member_offer_limit" : null;
    if (!isDeepStrictEqual(a, { ...local, pendingForViewer: a.pendingForViewer, reason, canOffer: reason === null })) throw new Error();
  } catch { throw new RoomClientError(200, "invalid_response", "Help offers do not match selected work and participants"); }
}

function checkedWorkSnapshot(value, roomId) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
  const exact = (value, keys) => object(value) && Object.keys(value).sort().join(" ") === keys.split(" ").sort().join(" ");
  try {
    const state = value?.state, projected = Object.hasOwn(value, "snapshotView") || Object.hasOwn(value, "snapshotVersion");
    if (!object(value) || value.roomId !== roomId || !integer(value.sequence) || !object(state)
      || state.room?.id !== roomId || !validId(value.viewerId) || !object(state.members) || !object(state.workItems)
      || !Object.hasOwn(state.members, value.viewerId) || Object.keys(state.members).length > 100 || Object.keys(state.workItems).length > 500) throw new Error();
    if (projected) {
      const help = Object.hasOwn(value, "helpContextVersion") || Object.hasOwn(value, "evaluatedAt");
      if (value.snapshotView !== "work" || value.snapshotVersion !== 1
        || !exact(value, "snapshotView snapshotVersion roomId sequence state charter viewerId viewerAccountId viewerAuthEpoch viewerSessionBinding viewerSessionRevision" + (help ? " helpContextVersion evaluatedAt" : ""))
        || help && (value.helpContextVersion !== 1 || typeof value.evaluatedAt !== "string" || !Number.isFinite(Date.parse(value.evaluatedAt)) || new Date(value.evaluatedAt).toISOString() !== value.evaluatedAt)
        || !exact(state, "room members workItems")) throw new Error();
    } else if (value.replyRequestContractVersion !== undefined && value.replyRequestContractVersion !== 1
      || !integer(value.cursor) || value.cursor > value.sequence
      || !Array.isArray(state.messages) || !Array.isArray(state.eventLog)) throw new Error();
    // Legacy compatibility validates the consumed envelope/current records, not
    // unused history integrity. It never issues a second, weaker fallback request.
    for (const [id, member] of Object.entries(state.members)) {
      if (!validId(id) || member?.id !== id || !text(member.displayName) || !["agent", "human"].includes(member.kind)
        || typeof member.active !== "boolean" || !integer(member.revision) || member.revision > value.sequence
        || !Array.isArray(member.permissions) || member.permissions.some(p => !PERMISSIONS.includes(p))
        || new Set(member.permissions).size !== member.permissions.length) throw new Error();
    }
    for (const [id, item] of Object.entries(state.workItems)) {
      if (!validId(id) || item?.id !== id || !text(item.title) || !text(item.definitionOfDone)
        || !Object.values(WORK_STATES).includes(item.state) || !integer(item.revision) || item.revision > value.sequence
        || !["read", "write"].includes(item.mode) || !Number.isFinite(Date.parse(item.updatedAt))
        || !validId(item.accountableMemberId) || !Object.hasOwn(state.members, item.accountableMemberId)
        || ["independentVerificationRequired", "ownerDecisionRequired"].some(key => typeof item[key] !== "boolean")
        || ["verifierMemberId", "humanDecisionMakerId", "supersededBy"].some(key => item[key] !== null && !validId(item[key]))
        || ["claim", "receipt", "verification", "decision", "blocker"].some(key => item[key] !== null && !object(item[key]))) throw new Error();
      if (projected && ["receiptHistory", "verificationHistory", "decisionHistory"].some(key => Object.hasOwn(item, key))) throw new Error();
      if (item.receipt && (!validId(item.receipt.eventId) || !text(item.receipt.evidenceVersion)
        || !text(item.receipt.summary) || !text(item.receipt.nextAction)
        || item.receipt.producerId !== null && !validId(item.receipt.producerId))) throw new Error();
      if (item.verification && (!validId(item.verification.completionEventId) || !text(item.verification.evidenceVersion)
        || !["pass", "fail"].includes(item.verification.result) || typeof item.verification.independenceConfirmed !== "boolean")) throw new Error();
      if (item.decision && (!validId(item.decision.completionEventId) || !text(item.decision.evidenceVersion)
        || !["approved", "changes_requested", "rejected"].includes(item.decision.decision))) throw new Error();
      if (item.claim && (!validId(item.claim.holderId) || !Number.isFinite(Date.parse(item.claim.expiresAt))
        || !["active", "released", "superseded"].includes(item.claim.status))) throw new Error();
      if (item.blocker && (!text(item.blocker.reason) || !text(item.blocker.nextAction))) throw new Error();
      if (value.helpContextVersion === 1) {
        const help = workHelpContext(state, id, value.viewerId, value.evaluatedAt);
        if (help.revision > value.sequence) throw new Error();
      }
    }
    checkedCharter(value.charter, value.sequence);
    return value;
  } catch { throw new RoomClientError(200, "invalid_response", "Room returned an invalid work snapshot"); }
}

// Minimal, explicit client for a single configured service and Room. It neither
// dispatches agents nor follows evidence links. Keep the token in operator memory.
const assertServiceOrigin = origin => {
  const url = new URL(origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Use a fixed HTTPS origin or an isolated loopback development origin");
  return url.origin;
};
export { assertServiceOrigin };

// Shared transport for requests made before a room is selected. Bearers never
// follow redirects or use ambient cookies; caller cancellation retains a deadline.
async function discoveryRequest(origin, path, { method = "GET", body, token, sameOrigin = false } = {}, { fetchImpl = globalThis.fetch, signal } = {}) {
  let service;
  try { service = assertServiceOrigin(origin); }
  catch { throw new RoomClientError(0, "invalid_config", "Use a fixed HTTPS origin or an isolated loopback development origin"); }
  let response;
  try {
    response = await fetchImpl(`${service}${edgeDoorApiPath(service, path)}`, {
      method, redirect: "error", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      ...(body !== undefined || token ? { headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(sameOrigin ? { Origin: service } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error instanceof RoomClientError) throw error;
    throw new RoomClientError(0, "service_unavailable", "Could not complete the request. Check the service address and retry.");
  }
  let value;
  try { value = await response.json(); } catch { value = null; }
  if (!response.ok) throw new RoomClientError(response.status, value?.error?.code ?? "request_failed", value?.error?.message ?? "Room request failed");
  return value;
}
function requireIdentitySecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("pri_"))
    throw new RoomClientError(0, "invalid_config", "A valid identity secret is required");
}

// Mint an identity without a room credential; store the returned secret securely.
export async function createAgentIdentity(origin, displayName, options = {}) {
  const value = await discoveryRequest(origin, "/api/agent-identities", { method: "POST", body: { displayName, ...(options.identitySecret ? { recoverable: true } : {}) }, token: options.identitySecret }, options);
  if (options.identitySecret && value?.identityId) value.secret = options.identitySecret;
  if (typeof value?.identityId !== "string" || typeof value?.secret !== "string") throw new RoomClientError(200, "invalid_response", "Room returned an invalid identity");
  return value;
}
export async function redeemAgentInvite(origin, code, displayName, options = {}) {
  const value = await discoveryRequest(origin, "/api/agent-invites/redeem", { method: "POST", body: { code, displayName }, token: options.identitySecret }, options);
  if (options.identitySecret && value?.identityId) value.secret = options.identitySecret;
  if (typeof value?.identityId !== "string" || typeof value?.secret !== "string" || typeof value?.memberId !== "string")
    throw new RoomClientError(200, "invalid_response", "Room returned an invalid invite redemption");
  return value;
}
// Preview consumes nothing and returns no identity data.
export async function previewAgentInvite(origin, code, options = {}) {
  const value = await discoveryRequest(origin, `/api/agent-invites/preview?code=${encodeURIComponent(code)}`, {}, options);
  if (typeof value?.roomId !== "string" || !Array.isArray(value?.permissions) || typeof value?.profile !== "string")
    throw new RoomClientError(200, "invalid_response", "Room returned an invalid invite preview");
  return value;
}
export async function requestAccess(origin, { roomId, identityId, displayName, requestedPermissions, note, requestId } = {}, options = {}) {
  // The route requires all six keys, including an idempotency key.
  const value = await discoveryRequest(origin, "/api/access-requests", { method: "POST", body: {
    roomId, identityId, displayName, requestedPermissions,
    note: typeof note === "string" ? note : "",
    requestId: typeof requestId === "string" && requestId ? requestId : `ar_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  } }, options);
  if (typeof value?.requestId !== "string" || typeof value?.status !== "string")
    throw new RoomClientError(200, "invalid_response", "Room returned an invalid access request");
  return value;
}
// roomId is the idempotency key. The identity secret travels only in the header.
export async function previewSharedInvite(origin, linkToken, options = {}) {
  const value = await discoveryRequest(origin, "/api/share-links/preview", { method: "POST", sameOrigin: true, body: { linkToken } }, options);
  if (!validId(value?.room?.id) || !Number.isSafeInteger(value?.link?.expiresAt)) throw new RoomClientError(200, "invalid_response", "Invalid invitation preview");
  return { roomId: value.room.id, title: value.room.title, permissions: [], expiresAt: value.link.expiresAt, remainingJoins: value.link.remainingJoins };
}
export async function joinSharedInvite(origin, linkToken, displayName, options = {}) {
  requireIdentitySecret(options.identitySecret);
  const value = await discoveryRequest(origin, "/api/share-links/join-agent", { method: "POST", sameOrigin: true, token: options.identitySecret, body: { linkToken, displayName } }, options);
  if (!validId(value?.roomId) || !validId(value?.identityId) || !validId(value?.memberId) || !Array.isArray(value?.permissions))
    throw new RoomClientError(200, "invalid_response", "Invalid joined invitation");
  return value;
}
export async function createAgentRoom(origin, identitySecret, { roomId, title, purpose, kind, displayName } = {}, options = {}) {
  requireIdentitySecret(identitySecret);
  const value = await discoveryRequest(origin, "/api/agent-rooms", { method: "POST", token: identitySecret,
    body: { roomId, title, purpose, kind, displayName } }, options);
  if (typeof value?.roomId !== "string" || typeof value?.ownerMemberId !== "string")
    throw new RoomClientError(200, "invalid_response", "Room returned an invalid created room");
  return value;
}
// Follow nextCursor even on an empty page: removed memberships are filtered out.
export async function listAgentRooms(origin, identitySecret, { after = "", ...options } = {}) {
  requireIdentitySecret(identitySecret);
  const value = await discoveryRequest(origin, `/api/agent-rooms?after=${encodeURIComponent(after)}`, { token: identitySecret }, options);
  if (typeof value?.identityId !== "string" || !Array.isArray(value?.rooms)
    || !value.rooms.every(room => typeof room?.roomId === "string" && typeof room?.memberId === "string" && typeof room?.title === "string"
      && (room.archivedAt === null || typeof room.archivedAt === "string"))
    || !(value.nextCursor === null || typeof value.nextCursor === "string"))
    throw new RoomClientError(200, "invalid_response", "Room returned an invalid room list");
  return value;
}
export class RoomAgentClient {
  #origin;
  #roomId;
  #token;
  #fetch;
  #memberId;
  constructor({ origin, roomId, token, memberId, fetchImpl = globalThis.fetch }) {
    assertServiceOrigin(origin);
    if (!validId(roomId) || typeof token !== "string" || !/^(?:[A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43}|pri_[A-Za-z0-9_-]{43,128})$/.test(token)) throw new Error("A valid Room and access key are required");
    if (memberId !== undefined && !validId(memberId)) throw new Error("Choose a valid expected agent member");
    this.#origin = origin; this.#roomId = roomId; this.#token = token; this.#fetch = fetchImpl;
    this.#memberId = memberId;
  }
  // Every service request shares one fetch posture: redirects are errors (a
  // redirect could carry the bearer elsewhere), no ambient credentials, and a
  // 15s deadline that a caller-supplied signal narrows but never removes.
  #fetchRaw(path, { method = "GET", headers = {}, body, signal } = {}) {
    return this.#fetch(`${this.#origin}${edgeDoorApiPath(this.#origin, path)}`, {
      method, redirect: "error", credentials: "omit", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.#token}`, ...headers },
      ...(body === undefined ? {} : { body })
    });
  }
  // Maps a non-2xx service response to a RoomClientError, keeping the
  // service's own error code and Retry-After when present.
  #requestError(response, value, fallback = "Room request failed") {
    const retry = response.headers?.get("retry-after");
    const parsed = retry == null ? NaN : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    return new RoomClientError(response.status, value?.error?.code ?? "request_failed", value?.error?.message ?? fallback, Number.isFinite(parsed) ? Math.max(0, parsed) : null, {
      status: value?.status, reason: value?.reason, hint: value?.hint, next: value?.next
    });
  }
  async #fetchPath(path, body, signal, helpContext = false, offerContext = false) {
    const response = await this.#fetchRaw(path, {
      method: body === undefined ? "GET" : "POST", signal,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(helpContext ? { "X-Project-Room-Help-Context": "1" } : {}),
        ...(offerContext ? { "X-Project-Room-Offer-Context": "1" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let value;
    try { value = await response.json(); } catch (error) {
      if (response.ok && (error instanceof TypeError || ["AbortError", "TimeoutError"].includes(error.name))) throw error;
      if (response.ok) throw new RoomClientError(response.status, "invalid_response", "Invalid Room response");
    }
    if (!response.ok) throw this.#requestError(response, value);
    return value;
  }
  async #deletePath(path, body, signal) {
    const response = await this.#fetchRaw(path, { method: "DELETE", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let value;
    try { value = await response.json(); } catch { value = null; }
    if (!response.ok) throw this.#requestError(response, value);
    return value;
  }
  async #request(suffix = "", body, signal, helpContext = false, offerContext = false) {
    // Saved configurations pin an agent. Recheck before each operation; a check
    // is never a cached grant. The service still authorizes the operation itself.
    if (this.#memberId) await this.checkConnection({ signal });
    const value = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, body, signal, helpContext, offerContext);
    const snapshotRead = suffix === "" || suffix === "?view=work";
    if (this.#memberId && (snapshotRead || suffix === "/charter" || suffix.startsWith("/charter?") || suffix.startsWith("/work-context?") || suffix.startsWith("/work-discussion?") || suffix.startsWith("/work-result?") || suffix.startsWith("/return-brief?") || /^\/reply-(requests|context|history)\?/.test(suffix))) {
      if (value?.roomId !== this.#roomId || value.viewerId !== this.#memberId || value.viewerAccountId !== null
        || value.viewerAuthEpoch !== null || value.viewerSessionBinding !== null || value.viewerSessionRevision !== null) {
        throw new RoomClientError(200, "identity_mismatch", "Room response does not match the configured agent");
      }
      const member = snapshotRead ? value.state?.members?.[this.#memberId] : suffix.startsWith("/work-context?") ? value.viewer : null;
      if ((snapshotRead || suffix.startsWith("/work-context?")) && (member?.id !== this.#memberId || member.kind !== "agent" || member.active !== true)) {
        throw new RoomClientError(200, "identity_mismatch", "Room response does not match the configured agent");
      }
    }
    return value;
  }
  async checkConnection({ signal } = {}) {
    if (!this.#memberId) throw new RoomClientError(0, "member_required", "Configure the expected agent member before checking access");
    // Round-2 #101: identity secrets are room-scoped at use, so /api/session
    // (which has no room) cannot resolve them. Check against the room path.
    if (this.#token.startsWith("pri_")) return this.#checkIdentityConnection({ signal });
    const value = await this.#fetchPath("/api/session", undefined, signal), member = value?.member;
    // Round-2 #101: identity secrets do not expire (credentialKind "identity",
    // expiresAt null); room keys still require a real expiry.
    const identityAuth = value?.credentialKind === "identity";
    const expiryOk = value != null && (identityAuth ? value.expiresAt === null
      : Number.isSafeInteger(value.expiresAt) && Number.isFinite(new Date(value.expiresAt).getTime()));
    if (!value || Array.isArray(value) || value.authMode !== "room" || !validId(value.roomId)
      || !member || !validId(member.id) || !["agent", "human"].includes(member.kind) || typeof member.active !== "boolean"
      || !Number.isSafeInteger(member.revision) || member.revision < 0 || !Array.isArray(member.permissions)
      || member.permissions.some(permission => !PERMISSIONS.includes(permission)) || new Set(member.permissions).size !== member.permissions.length
      || !expiryOk) {
      throw new RoomClientError(200, "invalid_response", "Room returned incomplete connection metadata");
    }
    if (value.roomId !== this.#roomId || member.id !== this.#memberId || member.kind !== "agent"
      || member.active !== true || ["account", "csrf", "sessionBinding", "sessionRevision"].some(field => value[field] !== null)
      || member.permissions.some(permission => ["manage_members", "decide"].includes(permission))) {
      throw new RoomClientError(200, "identity_mismatch", "Access does not match the configured agent");
    }
    const now = Date.now();
    if (!identityAuth && value.expiresAt <= now) throw new RoomClientError(200, "expiry_unconfirmed", "Check the local clock and agent key expiry");
    return { contractVersion: 1, type: "agent_connection_check", status: "credential_accepted", origin: this.#origin,
      roomId: this.#roomId, memberId: this.#memberId, kind: "agent", permissions: [...member.permissions],
      checkedAt: new Date(now).toISOString(), expiresAt: value.expiresAt, scope: "room", externalExecution: false };
  }
  async #checkIdentityConnection({ signal } = {}) {
    const snapshot = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}`, undefined, signal);
    const member = snapshot?.state?.members?.[this.#memberId];
    // Agent owners hold manage_members/decide on rooms they created or were
    // appointed to (#593). That is ownership, not a delegated human-admin
    // grant — allow the CLI connect/check ladder when this identity is the
    // room owner. Non-owner agents require the server's explicit owner-grant marker.
    const ownerAgent = member?.kind === "agent" && snapshot?.state?.room?.ownerId === this.#memberId;
    if (!snapshot || Array.isArray(snapshot) || snapshot.roomId !== this.#roomId || snapshot.viewerId !== this.#memberId
      || !member || member.kind !== "agent" || member.active !== true || !Number.isSafeInteger(member.revision)
      || !Array.isArray(member.permissions) || member.permissions.some(permission => !PERMISSIONS.includes(permission))
      || (!ownerAgent && member.delegatedAdmin !== true && member.permissions.some(permission => ["manage_members", "decide"].includes(permission)))) {
      throw new RoomClientError(200, "identity_mismatch", "Identity is not linked to this room as the configured agent");
    }
    return { contractVersion: 1, type: "agent_connection_check", status: "credential_accepted", origin: this.#origin,
      roomId: this.#roomId, memberId: this.#memberId, kind: "agent", permissions: [...member.permissions],
      checkedAt: new Date(Date.now()).toISOString(), expiresAt: null, scope: "room", externalExecution: false };
  }
  // A wake-up hint only. Consumers re-read their authorized queue before acting;
  // no streamed message body is used as executable input or saved as history.
  async waitForChange(after, { signal, timeoutMs = 10000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new Error("Choose a valid stream cursor and timeout");
    const deadline = AbortSignal.timeout(timeoutMs), controller = new AbortController();
    const stop = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
    let reader;
    try {
      await this.checkConnection({ signal: stop });
      const response = await this.#fetchRaw(`/api/rooms/${encodeURIComponent(this.#roomId)}/stream?after=${after}`,
        { signal: stop, headers: { Accept: "text/event-stream" } });
      if (!response.ok) throw this.#requestError(response, null, "Room stream unavailable");
      if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body)
        throw new RoomClientError(200, "invalid_response", "Room returned an invalid event stream");
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const chunk = await reader.read(); if (chunk.done) return { changed: false };
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 262144) throw new RoomClientError(200, "invalid_response", "Room stream frame exceeds its limit");
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const kind = /^event: ?([^\r\n]+)/m.exec(frame)?.[1];
          if (kind === "access-ended") throw new RoomClientError(401, "access_ended", "Room access ended");
          if (kind === "stream_lagging") return { changed: true };
          if (kind !== "room-event") continue;
          const id = /^id: ?([0-9]+)\r?$/m.exec(frame)?.[1], sequence = Number(id);
          if (!id || !Number.isSafeInteger(sequence) || sequence <= after)
            throw new RoomClientError(200, "invalid_response", "Room returned an invalid stream cursor");
          return { changed: true, sequence };
        }
      }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) return { changed: false };
      throw error;
    } finally { controller.abort(); if (reader) await reader.cancel().catch(() => {}); }
  }
  snapshot({ signal } = {}) { return this.#request("", undefined, signal); }
  // Agent inbox: direct @mentions waiting for an answer, DMs, assignments and
  // routed mentions, each with its next step. A read; nothing is marked.
  agentInbox({ limit, signal } = {}) {
    return this.#request(`/agent-inbox${limit === undefined ? "" : `?limit=${limit}`}`, undefined, signal);
  }
  // Room messages after a sequence, in order, as compact records. Other event
  // types are skipped; private messages appear only to their two parties
  // (the service filters them). Follow next while hasMore is true.
  async roomMessages({ after = 0, limit = 50, signal } = {}) {
    const page = await this.#request(`/events?after=${after}&limit=${limit}`, undefined, signal);
    const messages = (page?.events ?? []).filter(({ event }) => event?.type === "message.posted").map(({ sequence, event }) => ({
      sequence, eventId: event.id, messageId: event.data?.messageId ?? event.id, from: event.actorId, at: event.at,
      body: event.data?.body ?? "", replyToId: event.data?.replyToId ?? null, private: Boolean(event.data?.toMemberId),
      ...(event.data?.toMemberId ? { toMemberId: event.data.toMemberId } : {}),
      ...(Array.isArray(event.mentions) && event.mentions.length ? { mentions: event.mentions.map(m => ({ memberId: m.memberId, displayName: m.displayName })) } : {})
    }));
    return { roomId: this.#roomId, messages, next: page?.next ?? after, hasMore: Boolean(page?.hasMore) };
  }
  async replyRead(name, args = {}, { signal } = {}) {
    const route = replyRoute(name);
    if (!route || !validReplyArguments(name, args)) throw new Error("Invalid request read selection");
    const result = await this.#request(route + "?" + new URLSearchParams(args), undefined, signal);
    return validateReplyRead(result, { name, args, roomId: this.#roomId });
  }
  async requestRuns(input, { signal } = {}) {
    const value = await this.#request("/request-runs", input, signal);
    if (value?.contractVersion !== 1 || value.roomId !== this.#roomId || value.viewerId !== this.#memberId)
      throw new Error("Host reservation response has the wrong identity");
    if (input && (value.attemptId !== input.attemptId || value.requestMessageId !== input.requestMessageId
      || value.state !== (input.action === "claim" ? "working" : input.action))) throw new Error("Host reservation is unconfirmed");
    return value;
  }
  replyRequests(options = {}) { const { signal, ...args } = options; return this.replyRead("room_list_requests", args, { signal }); }
  replyContext(requestMessageId, options = {}) {
    const { signal, ...args } = options;
    if (Object.hasOwn(args, "requestMessageId")) throw new Error("Choose the request once");
    return this.replyRead("room_read_request", { ...args, requestMessageId }, { signal });
  }
  replyHistory(options = {}) { const { signal, ...args } = options; return this.replyRead("room_request_history", args, { signal }); }
  replyAction(name, args, options = {}) {
    return submitReplyAction(this, { roomId: this.#roomId, memberId: this.#memberId }, name, args, options);
  }
  async charter({ revision, signal } = {}) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error("Choose an instructions version");
    const value = await this.#request(`/charter${revision === undefined ? "" : `?revision=${revision}`}`, undefined, signal);
    try { return validateCharterRead(value, this.#roomId, revision); }
    catch { throw new RoomClientError(200, "invalid_response", "Room returned invalid instructions metadata"); }
  }
  async workResult(workItemId, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["completionEventId", "draftMessageId", "signal"].includes(key))) throw new Error("Choose a completion or a draft, and optional signal");
    const { completionEventId = null, draftMessageId = null, signal } = options;
    if (!validId(workItemId) || [completionEventId, draftMessageId].some(id => id !== null && !validId(id)) || completionEventId !== null && draftMessageId !== null) throw new Error("Choose one exact result or draft");
    const query = new URLSearchParams({ workItemId });
    if (completionEventId !== null) query.set("completionEventId", completionEventId);
    if (draftMessageId !== null) query.set("draftMessageId", draftMessageId);
    const value = await this.#request(`/work-result?${query}`, undefined, signal);
    try { return await verifyWorkResult(value, { roomId: this.#roomId, workItemId, completionEventId, draftMessageId }); }
    catch { throw new RoomClientError(200, "invalid_response", "Selected result does not match the request"); }
  }
  async workDefinition(workItemId, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "signal")) throw new Error("Use the signal option only");
    return reusableWorkDefinition((await this.workContext(workItemId, { signal: options.signal })).work);
  }
  // The caller reviews/redacts this draft; preparing it neither shares nor certifies it.
  async resultDraft(workItemId, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "signal")) throw new Error("Use the signal option only");
    return resultDraft((await this.workContext(workItemId, { signal: options.signal })).work);
  }
  async workContext(workItemId, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["includeSource", "includeOffers", "signal"].includes(key))) throw new Error("Use includeSource, includeOffers and signal options only");
    const { includeSource = false, includeOffers = false, signal } = options;
    if (!validId(workItemId) || typeof includeSource !== "boolean" || typeof includeOffers !== "boolean") throw new Error("Choose one work ID and boolean context options");
    const query = new URLSearchParams({ workItemId });
    if (includeSource) query.set("includeSource", "true");
    const result = await this.#request(`/work-context?${query}`, undefined, signal, false, includeOffers);
    if (includeOffers && result?.offerContextVersion === undefined && result?.offers === undefined)
      throw new RoomClientError(200, "offer_context_unavailable", "This service does not advertise help offer context");
    if (!includeOffers && (Object.hasOwn(result ?? {}, "offers") || Object.hasOwn(result ?? {}, "offerContextVersion")))
      throw new RoomClientError(200, "invalid_response", "Unrequested help offer context");
    const source = result?.context?.source;
    if (result?.contractVersion !== 1 || result.roomId !== this.#roomId || result.work?.id !== workItemId
      || result.next?.workItemId !== workItemId || result.next?.workRevision !== result.work?.revision
      || !validId(result.viewer?.id) || result.viewerId !== result.viewer.id || !Number.isSafeInteger(result.evaluatedThrough) || result.evaluatedThrough < 0
      || !Number.isSafeInteger(result.work.revision) || result.work.revision < 0 || !Number.isFinite(Date.parse(result.evaluatedAt))
      || (!includeSource && (source?.status !== "not_requested" || source.message !== null))
      || (includeSource && (!source || (result.work.sourceMessageId ? !["included", "unavailable"].includes(source.status) : source.status !== "not_linked")
        || (source.status === "included" ? source.message?.id !== result.work.sourceMessageId || typeof source.message?.body !== "string" : source.message !== null)))) {
      throw new RoomClientError(200, "invalid_response", "Selected work context does not match the request");
    }
    if (Object.hasOwn(result, "resume") && !isDeepStrictEqual(result.resume,
      workResume(result.work, Date.parse(result.evaluatedAt), result.context.roomOwnerId)))
      throw new RoomClientError(200, "invalid_response", "Resume brief does not match selected work");
    if (result.context.charter !== undefined) result.context.charter = checkedCharter(result.context.charter, result.evaluatedThrough);
    if (Object.hasOwn(result, "collaboration")) {
      try {
        const participants = result.context.participants;
        if (!Object.values(WORK_STATES).includes(result.work.state) || !validId(result.work.accountableMemberId)
          || typeof result.work.independentVerificationRequired !== "boolean" || typeof result.viewer.active !== "boolean"
          || !Array.isArray(participants) || participants.length > (includeOffers ? 100 : 10)
          || participants.some(person => !person || !validId(person.id) || person.unavailable !== true && typeof person.active !== "boolean")
          || new Set(participants.map(person => person.id)).size !== participants.length
          || !isDeepStrictEqual(result.collaboration, workCollaboration(result.work, result.viewer, participants))) throw new Error();
      } catch { throw new RoomClientError(200, "invalid_response", "Collaboration guidance does not match selected work"); }
    }
    if (Object.hasOwn(result, "help") || Object.hasOwn(result, "helpContextVersion")) {
      try {
        const participants = result.context.participants;
        if (result.helpContextVersion !== 1 || !validId(result.context.roomOwnerId) || !Array.isArray(participants)
          || participants.length > (includeOffers ? 100 : 10) || new Set(participants.map(person => person?.id)).size !== participants.length) throw new Error();
        for (const person of participants) if (person?.unavailable !== true && (!validId(person?.id)
          || !["human", "agent"].includes(person.kind) || typeof person.active !== "boolean"
          || !Number.isSafeInteger(person.revision) || person.revision < 0 || person.revision > result.evaluatedThrough
          || !Array.isArray(person.permissions) || new Set(person.permissions).size !== person.permissions.length
          || person.permissions.some(permission => !PERMISSIONS.includes(permission)))) throw new Error();
        const members = Object.fromEntries(participants.filter(person => person.unavailable !== true).map(person => [person.id, person]));
        if (!members[result.work.accountableMemberId] || !members[result.context.roomOwnerId] || !members[result.viewer.id]
          || ["id", "kind", "active", "revision", "permissions"].some(key => !isDeepStrictEqual(members[result.viewer.id][key], result.viewer[key]))) throw new Error();
        const expected = workHelpContext({ room: { id: result.roomId, ownerId: result.context.roomOwnerId }, members,
          workItems: { [workItemId]: result.work } }, workItemId, result.viewer.id, result.evaluatedAt);
        if (expected.revision > result.evaluatedThrough || !isDeepStrictEqual(result.help, expected)) throw new Error();
      } catch { throw new RoomClientError(200, "invalid_response", "Help invitation context does not match selected work"); }
    }
    if (includeOffers) {
      if (result.helpContextVersion !== 1) throw new RoomClientError(200, "invalid_response", "Offer context requires current invitation context");
      checkedOffers(result);
    }
    return result;
  }
  async workDiscussion(workItemId, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["since", "cursor", "limit", "signal"].includes(key))) throw new Error("Use discussion checkpoint, cursor, limit and signal only");
    const { since, cursor = null, limit = 20, signal } = options, integer = n => Number.isSafeInteger(n) && n >= 0;
    if (!validId(workItemId) || !integer(limit) || limit < 1 || limit > 50 || (since !== undefined && !integer(since))
      || (cursor !== null && (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor) || since !== undefined))) throw new Error("Choose one task and either a checkpoint or its continuation");
    const query = new URLSearchParams({ workItemId, limit });
    if (cursor !== null) query.set("cursor", cursor);
    if (since !== undefined) query.set("since", since);
    const result = await this.#request(`/work-discussion?${query}`, undefined, signal), page = result?.discussion, current = result?.current;
    const invalid = () => { throw new RoomClientError(200, "invalid_response", "Work discussion does not match the request"); };
    const continuation = token => {
      let value;
      try { value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { invalid(); }
      const keys = ["version", "roomId", "workItemId", "viewerId", "horizon", "anchorId", "since", "after"];
      if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
        || Buffer.from(JSON.stringify(value)).toString("base64url") !== token || value.version !== 1
        || value.roomId !== this.#roomId || value.workItemId !== workItemId || value.viewerId !== result.viewerId || !validId(value.anchorId)
        || !integer(value.horizon) || !integer(value.since) || !integer(value.after) || value.since > value.after || value.after >= value.horizon) invalid();
      return value;
    };
    if (result?.contractVersion !== 1 || result.roomId !== this.#roomId || result.workItemId !== workItemId || !validId(result.viewerId)
      || result.selection?.rule !== "source-linked-descendants-v1" || result.scope?.membership !== "room" || result.scope.targetedMessages !== "room-visible" || result.scope.externalExecution !== false
      || !page || !integer(page.horizon) || !integer(page.since) || !integer(page.after) || page.since > page.after || page.after > page.horizon
      || page.cursor !== cursor || (cursor === null && (page.since !== (since ?? 0) || page.after !== (since ?? 0)))
      || page.limit !== limit || !Array.isArray(page.items) || page.items.length > limit || typeof page.hasMore !== "boolean"
      || !integer(current?.evaluatedThrough) || current.evaluatedThrough < page.horizon || !Number.isFinite(Date.parse(current.evaluatedAt))
      || !integer(current.workRevision) || current.next?.workItemId !== workItemId || current.next.workRevision !== current.workRevision
      || (page.hasMore ? !page.items.length || page.checkpoint !== null || typeof page.nextCursor !== "string" || page.nextCursor.length > 2048
        || !/^[A-Za-z0-9_-]+$/.test(page.nextCursor) || page.nextCursor === cursor : page.nextCursor !== null || page.checkpoint !== page.horizon)) invalid();
    const requested = cursor === null ? null : continuation(cursor);
    if (requested && ["horizon", "since", "after"].some(key => requested[key] !== page[key])) invalid();
    let after = page.after, bytes = 0; const ids = new Set(), events = new Set();
    for (const row of page.items) {
      if (!row || typeof row !== "object" || Array.isArray(row)) invalid();
      const message = row.message, proposal = message?.proposal;
      if (!integer(row.sequence) || row.sequence <= after || row.sequence > page.horizon || !validId(row.eventId) || events.has(row.eventId)
        || !["source", "linked", "reply"].includes(row.relation) || !validId(message?.id) || ids.has(message.id) || !validId(message.authorId)
        || typeof message.body !== "string" || !Number.isFinite(Date.parse(message.createdAt))
        || ["replyToId", "toMemberId", "workItemId"].some(key => message[key] !== null && !validId(message[key]))
        || (row.relation === "source" && message.id !== result.selection.sourceMessageId)
        || (row.relation === "linked" && message.workItemId !== workItemId)
        || (row.relation === "reply" && (!message.replyToId || message.workItemId !== null))
        || (proposal && (!validId(proposal.packetId) || !integer(proposal.basisRevision) || !integer(proposal.submittedAtRevision)
          || proposal.basisRevision > proposal.submittedAtRevision || proposal.attribution !== "manual-unverified"))) invalid();
      after = row.sequence; ids.add(message.id); events.add(row.eventId); bytes += Buffer.byteLength(JSON.stringify(row));
    }
    if (bytes > 65536 || page.rowBytes !== bytes || (page.hasMore && after >= page.horizon)) invalid();
    if (page.hasMore) {
      const next = continuation(page.nextCursor);
      if (next.horizon !== page.horizon || next.since !== page.since || next.after !== after || (requested && requested.anchorId !== next.anchorId)) invalid();
    }
    return result;
  }
  // Personal to this credential's member, never included in shared orientation.
  reminders(request) { return this.#request("/reminders", request); }
  // Work claims (RC-2026-09-18-041): the room's claim registry with leases,
  // delivery modes and review policies. Claim/update/release/reassign are
  // owner-gated server-side; reads need room membership only.
  workClaims({ signal } = {}) { return this.#request("/work-claims", undefined, signal); }
  workClaimCreate({ id, title, reviewPolicy, note } = {}, { signal } = {}) {
    if (typeof id !== "string" || !id) throw new Error("Choose a work claim id");
    return this.#request("/work-claims", { id,
      ...(title === undefined ? {} : { title }),
      ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
      ...(note === undefined ? {} : { note }) }, signal);
  }
  workClaimGet(id, { signal } = {}) { return this.#request(`/work-claims/${encodeURIComponent(id)}`, undefined, signal); }
  claimWorkItem(id, { note, leaseHours, signal } = {}) {
    return this.#request(`/work-claims/${encodeURIComponent(id)}/claim`,
      { ...(note === undefined ? {} : { note }), ...(leaseHours === undefined ? {} : { leaseHours }) }, signal);
  }
  updateWorkItem(id, { state, note, deliveryMode, reviewedBy, signal } = {}) {
    return this.#request(`/work-claims/${encodeURIComponent(id)}/update`,
      { ...(state === undefined ? {} : { state }), ...(note === undefined ? {} : { note }),
        ...(deliveryMode === undefined ? {} : { deliveryMode }),
        ...(reviewedBy === undefined ? {} : { reviewedBy }) }, signal);
  }
  releaseWorkItem(id, { note, signal } = {}) {
    return this.#request(`/work-claims/${encodeURIComponent(id)}/release`,
      { ...(note === undefined ? {} : { note }) }, signal);
  }
  reassignWorkItem(id, { newOwner, note, signal } = {}) {
    if (typeof newOwner !== "string" || !newOwner) throw new Error("Choose the new owner");
    return this.#request(`/work-claims/${encodeURIComponent(id)}/reassign`,
      { newOwner, ...(note === undefined ? {} : { note }) }, signal);
  }
  sweepWorkClaims({ signal } = {}) { return this.#request("/work-claims/sweep", {}, signal); }
  // Convenience: claim, creating the item first when it does not exist yet.
  async workClaim(id, { title, note, leaseHours, signal } = {}) {
    try { return await this.claimWorkItem(id, { note, leaseHours, signal }); }
    catch (error) {
      if (!(error instanceof RoomClientError) || error.status !== 404) throw error;
      await this.workClaimCreate({ id, title, note }, { signal });
      return this.claimWorkItem(id, { note, leaseHours, signal });
    }
  }
  async workComplete(id, { deliveryMode, note, reviewedBy, signal } = {}) {
    return this.updateWorkItem(id, { state: "done", note, deliveryMode, reviewedBy, signal });
  }
  async workRelease(id, { note, signal } = {}) { return this.releaseWorkItem(id, { note, signal }); }
  // Selected task only; the normal authenticated snapshot never leaves this client.
  async workPacket(workItemId, options = {}) {
    return workPacket((await this.snapshot()).state, workItemId, options);
  }
  changes(after = 0, limit = 50, { signal } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Use a nonnegative checkpoint and a page size from 1 to 100");
    return this.#request(`/events?after=${after}&limit=${limit}`, undefined, signal);
  }
  activationPack({ signal } = {}) { return this.#request("/activation-pack", undefined, signal); }
  returnBrief({ limit = 50, horizon, after, cursor } = {}) {
    const query = new URLSearchParams({ limit });
    for (const [name, value] of Object.entries({ horizon, after, cursor })) if (value !== undefined) query.set(name, value);
    return this.#request(`/return-brief?${query}`);
  }
  // Caller owns a stable command ID. On an uncertain transport result, reconcile
  // or resend this exact object. Never invent a replacement ID automatically.
  command(command, { signal } = {}) { return this.#request("/commands", command, signal); }
  // Autonomy primitives: who is online and what they hold, who can do what,
  // and structural claims on work sessions. No extra permissions needed
  // beyond room membership for reads; writes follow the room's own gates.
  presence({ signal } = {}) { return this.#request("/presence", undefined, signal); }
  workTemplates() { return WORK_TEMPLATES; }
  workTemplate(id) { return workTemplate(id); }
  roomTemplates() { return ROOM_TEMPLATES; }
  roomTemplate(id) { return roomTemplate(id); }
  // Round-2 #115: apply a room template through the normal command path.
  // Charter needs the Room owner; work items need "steer". Returns a receipt
  // of what landed and what was skipped (with reasons).
  async applyRoomTemplate(id, { accountableMemberId, signal } = {}) {
    const template = roomTemplate(id);
    if (!template) throw new Error(`Unknown room template: ${id}`);
    const receipt = { template: id, charter: null, workItems: [] };
    const charter = await this.charter().catch(() => null);
    try {
      await this.command({ id: randomUUID(), type: "room.charter_updated",
        data: { expectedRevision: charter?.revision ?? 0, ...template.charter } }, { signal });
      receipt.charter = "updated";
    } catch (error) {
      receipt.charter = `skipped: ${error.message}`;
    }
    const accountable = accountableMemberId ?? this.#memberId;
    for (const item of template.workItems) {
      try {
        const result = await this.command({ id: randomUUID(), type: "work.proposed",
          data: { workItemId: randomUUID(), title: item.title, definitionOfDone: item.definitionOfDone,
            mode: item.mode, ...(accountable ? { accountableMemberId: accountable } : {}) } }, { signal });
        receipt.workItems.push({ title: item.title, workItemId: result?.event?.data?.workItemId ?? null });
      } catch (error) {
        receipt.workItems.push({ title: item.title, skipped: error.message });
      }
    }
    return receipt;
  }
  search(query, { kind = "all", signal } = {}) {
    const params = new URLSearchParams({ q: query });
    if (kind !== "all") params.set("kind", kind);
    return this.#request(`/search?${params}`, undefined, signal);
  }
  messageThread(messageId, { signal } = {}) {
    return this.#request(`/messages/${encodeURIComponent(messageId)}/thread`, undefined, signal);
  }
  providerHeartbeats({ signal } = {}) {
    return this.#request("/provider-heartbeats", undefined, signal);
  }
  // Round-2 #101: multi-room agent identities. createAgentIdentity is
  // room-independent (POST /api/agent-identities); the link calls act on the
  // configured room with an owner/manager credential.
  async createAgentIdentity(displayName, { signal } = {}) {
    return createAgentIdentity(this.#origin, displayName, { signal });
  }
  // Owner operations: linking, listing and unlinking identities needs the
  // room owner's membership-administration grant, so these deliberately skip
  // #request's agent-pinning preflight (an owner is not an agent member).
  // The server still enforces manage_members; responses are checked against
  // the configured room.
  async #identityAdmin(suffix, body, { signal } = {}) {
    const value = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, body, signal);
    if (value?.roomId !== this.#roomId) {
      throw new RoomClientError(200, "invalid_response", "Room response does not match the configured room");
    }
    const wellFormed = body === undefined ? Array.isArray(value?.links) : typeof value?.identityId === "string";
    if (!wellFormed) throw new RoomClientError(200, "invalid_response", "Room returned an invalid identity response");
    return value;
  }
  linkIdentity({ identityId, memberId, displayName, permissions }, { signal } = {}) {
    return this.#identityAdmin("/identity-links", { identityId, ...(memberId === undefined ? {} : { memberId }),
      ...(displayName === undefined ? {} : { displayName }), permissions }, { signal });
  }
  identityLinks({ signal } = {}) {
    return this.#identityAdmin("/identity-links", undefined, { signal });
  }
  unlinkIdentity(identityId, { signal } = {}) {
    return this.#deletePath(`/api/rooms/${encodeURIComponent(this.#roomId)}/identity-links`, { identityId }, signal);
  }
  // Self-deactivation: the caller deactivates its own membership.
  // memberId must be the caller's own member id; the server rejects anyone
  // else with 403. The identity link is kept — only the membership goes inactive.
  deactivateMembership({ signal } = {}) {
    if (!this.#memberId) throw new Error("A pinned memberId is required to deactivate your own membership");
    return this.#deletePath(`/api/rooms/${encodeURIComponent(this.#roomId)}/members/${encodeURIComponent(this.#memberId)}`, undefined, signal);
  }
  // One-time agent invite codes. Issuance is owner, manage_members, or
  // invite_member (agents may hold invite_member without manage_members).
  // The raw code is shown once at creation and only its hash is stored.
  // Redemption is unauthenticated (the code is the bearer credential).
  async #inviteAdmin(suffix, body, { signal } = {}) {
    const value = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, body, signal);
    if (value?.roomId !== this.#roomId) {
      throw new RoomClientError(200, "invalid_response", "Room response does not match the configured room");
    }
    return value;
  }
  async createAgentInvite({ permissions, profile, expiresInMinutes, displayName } = {}, { signal } = {}) {
    const attempt = body => this.#inviteAdmin("/agent-invites", body, { signal });
    const options = {
      ...(expiresInMinutes === undefined ? {} : { expiresInMinutes }),
      ...(displayName === undefined ? {} : { displayName }),
    };
    let value;
    if (profile === "collaborate") {
      try {
        value = await attempt({ profile, ...options });
      } catch (error) {
        // Deployments older than the collaborate profile reject it with 422
        // invalid_invite_scope. Fall back to the explicit permission set the
        // profile maps to (AGENT_AUTONOMY_PERMISSIONS); the server still
        // validates the minter's grant, so this widens nothing.
        if (error?.code !== "invalid_invite_scope") throw error;
        value = await attempt({ permissions: [...AGENT_AUTONOMY_PERMISSIONS], ...options });
      }
    } else {
      value = await attempt({
        ...(profile === undefined ? {} : { profile }),
        ...(permissions === undefined ? {} : { permissions }),
        ...options,
      });
    }
    if (typeof value?.code !== "string" || typeof value?.inviteId !== "string") {
      throw new RoomClientError(200, "invalid_response", "Room returned an invalid invite code");
    }
    return value;
  }
  async agentInvites({ signal } = {}) {
    const value = await this.#inviteAdmin("/agent-invites", undefined, { signal });
    if (!Array.isArray(value?.invites)) throw new RoomClientError(200, "invalid_response", "Room returned an invalid invite list");
    return value;
  }
  revokeAgentInvite(inviteId, { signal } = {}) {
    return this.#deletePath(`/api/rooms/${encodeURIComponent(this.#roomId)}/agent-invites`, { inviteId }, signal);
  }
  // Scoped agent API keys (RC-2026-09-18-050). Key management is owner-only:
  // the caller's credential must be the pri_ identity secret — a rak_ key
  // can never mint, rotate, or revoke keys (the server rejects with 403).
  // create/rotate return the secret exactly once; the caller must store it
  // now. list never returns secrets.
  async createAgentKey({ scopes, label, expiresAt } = {}, { signal } = {}) {
    const value = await this.#fetchPath("/api/agent-keys", {
      scopes,
      ...(label === undefined ? {} : { label }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }, signal);
    if (typeof value?.keyId !== "string" || typeof value?.secret !== "string"
      || typeof value?.credential !== "string" || !Array.isArray(value?.scopes)) {
      throw new RoomClientError(200, "invalid_response", "Room returned an invalid API key");
    }
    return value;
  }
  async listAgentKeys({ signal } = {}) {
    const value = await this.#fetchPath("/api/agent-keys", undefined, signal);
    if (!Array.isArray(value?.keys)) throw new RoomClientError(200, "invalid_response", "Room returned an invalid key list");
    return value;
  }
  async rotateAgentKey(keyId, { signal } = {}) {
    const value = await this.#fetchPath(`/api/agent-keys/${encodeURIComponent(keyId)}/rotate`, {}, signal);
    if (typeof value?.keyId !== "string" || typeof value?.secret !== "string"
      || typeof value?.credential !== "string") {
      throw new RoomClientError(200, "invalid_response", "Room returned an invalid rotated key");
    }
    return value;
  }
  async revokeAgentKey(keyId, { signal } = {}) {
    const value = await this.#fetchPath(`/api/agent-keys/${encodeURIComponent(keyId)}/revoke`, {}, signal);
    if (value?.revoked !== true) throw new RoomClientError(200, "invalid_response", "Room returned an invalid revocation");
    return value;
  }
  // Self-serve access requests. Listing and deciding are owner-only (the
  // server enforces manage_members); the request itself is unauthenticated
  // via the standalone requestAccess() below.
  async #accessAdmin(suffix, body, { signal } = {}) {
    const value = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, body, signal);
    if (value?.roomId !== this.#roomId) {
      throw new RoomClientError(200, "invalid_response", "Room response does not match the configured room");
    }
    return value;
  }
  accessRequests({ status } = {}, { signal } = {}) {
    const query = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
    return this.#accessAdmin(`/access-requests${query}`, undefined, { signal });
  }
  decideAccessRequest(requestId, { decision, permissions, note } = {}, { signal } = {}) {
    return this.#accessAdmin(`/access-requests/${encodeURIComponent(requestId)}/decide`,
      { decision, ...(permissions === undefined ? {} : { permissions }), ...(note === undefined ? {} : { note }) }, { signal });
  }
  // Owner-granted membership administration (RC-2026-09-18-038): the owner
  // grants/revokes/lists the delegation; a grant lets the holder's agent
  // identity list and decide access requests. The holder cannot grant
  // further — there is no self-grant path.
  membershipAdministrationGrants({ signal } = {}) {
    return this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}/membership-delegation`, undefined, { signal });
  }
  grantMembershipAdministration(identityId, { signal } = {}) {
    if (typeof identityId !== "string" || !identityId) throw new RoomClientError(0, "invalid_config", "Choose the agent identity to grant membership administration");
    return this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}/membership-delegation/grant`, { identityId }, { signal });
  }
  revokeMembershipAdministration(identityId, { signal } = {}) {
    if (typeof identityId !== "string" || !identityId) throw new RoomClientError(0, "invalid_config", "Choose the agent identity whose membership-administration grant should be revoked");
    return this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}/membership-delegation/revoke`, { identityId }, { signal });
  }
  // Ownership appointment: the current room owner transfers ownership to an
  // existing active member (human or agent). Owner-only; the transfer is
  // reversible and audited in the room's event log.
  transferOwnership(toMemberId, { reason, signal } = {}) {
    if (typeof toMemberId !== "string" || !toMemberId) throw new RoomClientError(0, "invalid_config", "Choose the member to appoint as owner");
    return this.#request("/ownership/transfer",
      { toMemberId, ...(reason === undefined ? {} : { reason }) }, signal);
  }
  // W4-57 M6: sanitized support-export bundle (owner-only). Whitelisted
  // scalar fields only — safe to hand to support without redaction.
  async diagnosticsExport({ signal } = {}) {
    const value = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}/diagnostics-export`, undefined, signal);
    if (value?.format !== "project-room-support-export-v1" || value?.room?.id !== this.#roomId
      || !Array.isArray(value?.diagnostics)) {
      throw new RoomClientError(200, "invalid_response", "Room returned an invalid support export");
    }
    return value;
  }
  setNotificationPreferences(preferences, { signal } = {}) {
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("Preferences must be an object");
    return this.command({ id: randomUUID(), type: "notifications.preferences_set", data: { preferences } }, { signal });
  }
  // Round-2 #106/#107: export returns NDJSON text; import posts it back.
  // These bypass #request because the payloads are NDJSON, not JSON, but
  // share the hardened fetch posture and error mapping of every other path.
  async exportRoom({ signal } = {}) {
    const response = await this.#fetchRaw(`/api/rooms/${encodeURIComponent(this.#roomId)}/export`, { signal });
    if (!response.ok) throw this.#requestError(response, await response.json().catch(() => null), "Room export failed");
    return response.text();
  }
  async importRoom(ndjson, { signal } = {}) {
    if (typeof ndjson !== "string" || !ndjson.trim()) throw new Error("Import needs NDJSON text");
    const response = await this.#fetchRaw(`/api/rooms/${encodeURIComponent(this.#roomId)}/import`, {
      method: "POST", signal, headers: { "Content-Type": "application/x-ndjson" }, body: ndjson
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw this.#requestError(response, value, "Room import failed");
    return value;
  }
  capabilities({ search, signal } = {}) {
    if (search !== undefined && (typeof search !== "string" || !search.trim() || search.length > 80))
      throw new Error("Search is 1 to 80 characters");
    return this.#request(search ? `/capabilities?search=${encodeURIComponent(search)}` : "/capabilities", undefined, signal);
  }
  advertiseCapabilities(capabilities, { signal } = {}) {
    if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 30
      || capabilities.some(cap => typeof cap !== "string" || !cap.trim() || cap.length > 80))
      throw new Error("Advertise 1 to 30 capabilities of 1 to 80 characters");
    return this.command({ id: randomUUID(), type: "capabilities.advertised", data: { capabilities } }, { signal });
  }
  // Round-2 #104: a short "working on X" line shown in the presence roster.
  // memberId optional — the server resolves the caller when omitted.
  setStatus(message, { memberId, signal } = {}) {
    if (typeof message !== "string" || !message.trim() || message.length > 140)
      throw new Error("Status message must be 1 to 140 characters");
    return this.command({ id: randomUUID(), type: "member.status_updated",
      data: { ...(memberId ? { memberId } : {}), message } }, { signal });
  }
  // Post a room message as the connected agent member. With toMemberId the
  // message is a targeted DM (only the sender and the addressed member can
  // read it); without it the message goes to everyone in the room.
  say(body, { toMemberId, signal } = {}) {
    if (typeof body !== "string" || !body.trim() || body.length > 4096)
      throw new Error("Say a message of 1 to 4096 characters");
    if (toMemberId !== undefined && !validId(toMemberId))
      throw new Error("toMemberId must be a member id");
    return this.command({ id: randomUUID(), type: "message.posted",
      data: { messageId: randomUUID(), body, ...(toMemberId ? { toMemberId } : {}) } }, { signal });
  }
  workSessions({ status, signal } = {}) {
    if (status !== undefined && typeof status !== "string") throw new Error("Choose one session status");
    return this.#request(status ? `/work-sessions?status=${encodeURIComponent(status)}` : "/work-sessions", undefined, signal);
  }
  workSessionAction({ requestId, workItemId, expectedRevision, action, status, budget, spendCents, rounds, toolCalls }, { signal } = {}) {
    if (!validId(requestId) || !validId(workItemId)) throw new Error("requestId and workItemId are required");
    if (!["set_status", "request_stop"].includes(action)) throw new Error("action must be set_status or request_stop");
    if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 0)) throw new Error("rounds must be a non-negative integer");
    if (toolCalls !== undefined && (!Number.isSafeInteger(toolCalls) || toolCalls < 0)) throw new Error("toolCalls must be a non-negative integer");
    return this.#request("/work-sessions", { requestId, workItemId, expectedRevision, action,
      ...(status === undefined ? {} : { status }),
      ...(budget === undefined ? {} : { budget }),
      ...(spendCents === undefined ? {} : { spendCents }),
      ...(rounds === undefined ? {} : { rounds }),
      ...(toolCalls === undefined ? {} : { toolCalls }) }, signal);
  }
  // Claim one queued session atomically: reads the card, then drives it to
  // processing with the card's revision. Throws session_claimed when held.
  // A budget declares the run's limits (maxRuntimeMs, maxAttempts,
  // maxConcurrent, maxSpendCents); undeclared quotas stay "unknown".
  async claimSession(workItemId, { budget, signal } = {}) {
    const sessions = await this.workSessions({ signal });
    const card = sessions?.sessions?.find?.(item => item.workItemId === workItemId && item.status === "queued");
    if (!card) throw new Error("No queued session card for that work item");
    return this.workSessionAction({ requestId: randomUUID(), workItemId,
      expectedRevision: card.revision, action: "set_status", status: "processing",
      ...(budget === undefined ? {} : { budget }) }, { signal });
  }
  workAction(name, args, options = {}) {
    return submitWorkAction(this, { roomId: this.#roomId, memberId: this.#memberId }, name, args, options);
  }
  helpAction(name, args, options = {}) {
    return submitHelpAction(this, { roomId: this.#roomId, memberId: this.#memberId }, name, args, options);
  }
  async board({ signal } = {}) {
    const snapshot = await this.snapshot({ signal });
    return { ...projectBoard(snapshot.state, Date.now()), roomId: snapshot.roomId,
      evaluatedThrough: snapshot.sequence, evaluatedAt: new Date().toISOString() };
  }
  async orient({ signal, focus = "all", query } = {}) {
    if (!["all", "needs_me", "help_wanted", "results"].includes(focus)) throw new RoomClientError(0, "invalid_focus", "Choose all work, work needing you, help invitations, or results");
    if (query !== undefined && !validWorkSearchQuery(query)) throw new RoomClientError(0, "invalid_query", "Use a nonblank work query of at most 200 UTF-16 code units");
    const snapshot = focus !== "all" || query !== undefined
      ? checkedWorkSnapshot(await this.#request("?view=work", undefined, signal, focus === "help_wanted"), this.#roomId)
      : await this.snapshot({ signal });
    const member = snapshot.state.members[snapshot.viewerId];
    const charter = snapshot.charter === undefined ? null : checkedCharter(snapshot.charter, snapshot.sequence);
    try {
      if (charter === null ? snapshot.state.room.charter !== undefined : JSON.stringify(charter) !== JSON.stringify(charterContext(snapshot.state.room))) throw new Error();
    } catch { throw new RoomClientError(200, "invalid_response", "Room instructions do not match the snapshot"); }
    if (focus === "help_wanted" && snapshot.helpContextVersion !== 1) throw new RoomClientError(200, "help_context_unavailable", "This service does not advertise explicit help invitations");
    const now = focus === "help_wanted" ? Date.parse(snapshot.evaluatedAt) : Date.now(), items = Object.values(snapshot.state.workItems);
    const helpFor = item => workHelpContext(snapshot.state, item.id, member.id, snapshot.evaluatedAt);
    if (focus !== "all" || query !== undefined) {
      const candidates = focus === "results" ? completedResults(snapshot.state) : focus === "all" ? items : items.filter(item => {
        if (focus === "help_wanted") return helpFor(item).canOffer;
        const next = nextWorkStep(item, now);
        return member.active && next.memberId === member.id && next.needsAttention;
      });
      const matches = query === undefined ? null : searchWork({ members: snapshot.state.members,
        workItems: Object.fromEntries(candidates.map(item => [item.id, item])) }, query);
      const work = (matches?.work ?? candidates.map(item => ({ item }))).map(({ item, excerpt }) => {
        return { id: item.id, title: item.title, state: item.state, revision: item.revision, mode: item.mode, next: nextWorkStep(item, now),
          ...(excerpt === undefined ? {} : { excerpt }),
          ...(focus === "help_wanted" ? { help: helpFor(item) } : {}),
          ...(focus === "results" ? { result: currentResult(item),
            nextResultRead: item.receipt.nativeText ? { tool: "room_read_result", arguments: { workItemId: item.id, completionEventId: item.receipt.eventId } } : null } : {}),
          availableRoomActions: workActions(item, member, now).map(([action, label]) => ({ action, label })),
          nextRead: { tool: "room_read_work", arguments: { workItemId: item.id, ...(focus === "help_wanted" ? { includeOffers: true } : {}) } } };
      });
      return { contractVersion: 1, roomId: snapshot.roomId, evaluatedThrough: snapshot.sequence,
        evaluatedAt: new Date(now).toISOString(), clockSource: focus === "help_wanted" ? "service" : "client", focus, charter, member,
        errors: AGENT_ERRORS,
        scope: { kind: "room", permissions: member.permissions, externalExecution: false },
        selection: matches ? { totalWork: items.length, eligibleWork: candidates.length, query: query.trim(),
          matches: matches.total, shown: work.length, limit: 25, hasMore: matches.total > work.length,
          guidance: "Current work fields only; no message bodies, evidence files or history. Focus is applied before matching and the 25-hit limit; refine the query if truncated. Compact excerpts omit full task context. Read selected work before acting. A hit is not an assignment, suitability judgment or execution grant; empty does not mean the room is done."
            + (focus === "help_wanted" ? " Read selected work with includeOffers=true for current queue capacity and selection, then inspect scope and discussion. Invitation discovery alone is not offer eligibility. No automatic offer or dispatch." : "") }
          : focus === "results" ? { totalWork: items.length, results: work.length,
          guidance: "Current completed results with required review and decision gates satisfied. Approval is not execution or reuse permission. Native results have exact read pointers; read work for external evidence links. Reopened, superseded and awaiting-review work are excluded. No external content fetched." }
          : focus === "help_wanted" ? { totalWork: items.length, helpWanted: work.length,
          guidance: "Explicit current invitations, not assignments, queue eligibility or permission to execute. All matching invitations in this bounded Room are included. Follow nextRead to inspect current offer capacity and selection; review scope and discussion before contributing. Unsupported offer reads fail explicitly. No automatic offer or dispatch." }
          : { totalWork: items.length, needsMe: work.length,
          guidance: "Current next steps addressed to you, including those missing a Room permission. Not all your ongoing work or reply requests. Read selected work before acting; available actions are descriptions, not execution grants. Empty does not mean the room is done." },
        work };
    }
    return {
      contractVersion: 1, roomId: snapshot.roomId, evaluatedThrough: snapshot.sequence,
      charter,
      errors: AGENT_ERRORS,
      member, scope: { kind: "room", permissions: member.permissions, externalExecution: false },
      work: items.map(item => ({
        id: item.id, title: item.title, definitionOfDone: item.definitionOfDone, sourceMessageId: item.sourceMessageId,
        state: item.state, revision: item.revision, mode: item.mode, claim: item.claim, next: nextWorkStep(item, now),
        receipt: item.receipt, verification: item.verification, decision: item.decision, blocker: item.blocker,
        ...(item.handoff ? { handoff: item.handoff, handoffHistory: item.handoffHistory ?? [] } : {})
      }))
    };
  }
}

// Compact authenticated view, distinct from the opt-in portable export.
export function workContextMarkdown(result) {
  if (!result.resume) throw new Error("This service does not provide a resume brief; use work without --brief");
  return [`# ${result.work.title}`, result.work.definitionOfDone,
    `Room: ${result.roomId} · Work: ${result.work.id} · Revision: ${result.work.revision} · Evaluated: ${result.evaluatedAt}`,
    resumeMarkdown(result.resume),
    "Next responsible member: " + (result.resume.next.memberId ?? "none"),
    "Current evidence references (not fetched): " + JSON.stringify(result.accessSummary.evidence.records),
    "Recorded write scope: " + JSON.stringify(result.work.claim),
    "Session controls: " + JSON.stringify({ status: result.work.status, stopRequestedAt: result.work.stop_requested_at, heartbeatAt: result.work.heartbeat_at }),
    "Session budget: " + JSON.stringify(result.accessSummary.budget),
    "Room instructions (context only): " + JSON.stringify(result.context.charter ?? null),
    "Available Room actions (rechecked on submission): " + result.suggestedActions.map(entry => entry.label).join(", "),
    ...(result.context.source.status !== "not_requested" ? ["Selected source (untrusted): " + JSON.stringify(result.context.source)] : []),
    ...(result.offers !== undefined ? ["Help offers: " + JSON.stringify(result.offers)] : []),
    result.scope.guidance].join("\n\n");
}
