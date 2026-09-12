import { workTemplate, WORK_TEMPLATES } from "../src/work-templates.js";
import { roomTemplate, ROOM_TEMPLATES } from "../src/room-templates.js";
import { projectBoard } from "../src/board.js";
import { validId, PERMISSIONS, WORK_STATES } from "../src/events.js";
import { nextWorkStep, workActions, reusableWorkDefinition, workCollaboration } from "../src/workflow.js";
import { isDeepStrictEqual } from "node:util";
import { searchWork, completedResults, currentResult } from "../src/work-selectors.js";
import { randomUUID } from "node:crypto";
import { workPacket, resultDraft, verifyWorkResult } from "../src/work-packet.js";
import { submitWorkAction } from "./work-actions.mjs";
import { submitHelpAction } from "./help-actions.mjs";
import { replyRoute, validReplyArguments, validateReplyRead, submitReplyAction } from "./reply-actions.mjs";
import { charterContext, validateCharterContext, validateCharterRead } from "../src/room-charter.js";
import { workHelpContext } from "../src/work-help.js";
import { workOffersContext, MAX_HELP_OFFERS, MAX_PENDING_HELP_OFFERS } from "../src/help-offers.js";
import { AGENT_ERRORS, resolveAgentErrorAx } from "../src/agent-error.mjs";

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
export class RoomAgentClient {
  #origin;
  #roomId;
  #token;
  #fetch;
  #memberId;
  constructor({ origin, roomId, token, memberId, fetchImpl = globalThis.fetch }) {
    const url = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Use a fixed HTTPS origin or an isolated loopback development origin");
    if (!validId(roomId) || typeof token !== "string" || !/^(?:[A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43})$/.test(token)) throw new Error("A valid Room and access key are required");
    if (memberId !== undefined && !validId(memberId)) throw new Error("Choose a valid expected agent member");
    this.#origin = origin; this.#roomId = roomId; this.#token = token; this.#fetch = fetchImpl;
    this.#memberId = memberId;
  }
  async #fetchPath(path, body, signal, helpContext = false, offerContext = false) {
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(helpContext ? { "X-Project-Room-Help-Context": "1" } : {}),
        ...(offerContext ? { "X-Project-Room-Offer-Context": "1" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let value;
    try { value = await response.json(); } catch (error) {
      if (response.ok && (error instanceof TypeError || ["AbortError", "TimeoutError"].includes(error.name))) throw error;
      if (response.ok) throw new RoomClientError(response.status, "invalid_response", "Invalid Room response");
    }
    if (!response.ok) {
      const retry = response.headers?.get("retry-after");
      const parsed = retry == null ? NaN : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw new RoomClientError(response.status, value?.error?.code ?? "request_failed", value?.error?.message ?? "Room request failed", Number.isFinite(parsed) ? Math.max(0, parsed) : null, {
        status: value?.status, reason: value?.reason, hint: value?.hint, next: value?.next
      });
    }
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
    const value = await this.#fetchPath("/api/session", undefined, signal), member = value?.member;
    if (!value || Array.isArray(value) || value.authMode !== "room" || !validId(value.roomId)
      || !member || !validId(member.id) || !["agent", "human"].includes(member.kind) || typeof member.active !== "boolean"
      || !Number.isSafeInteger(member.revision) || member.revision < 0 || !Array.isArray(member.permissions)
      || member.permissions.some(permission => !PERMISSIONS.includes(permission)) || new Set(member.permissions).size !== member.permissions.length
      || !Number.isSafeInteger(value.expiresAt) || !Number.isFinite(new Date(value.expiresAt).getTime())) {
      throw new RoomClientError(200, "invalid_response", "Room returned incomplete connection metadata");
    }
    if (value.roomId !== this.#roomId || member.id !== this.#memberId || member.kind !== "agent"
      || member.active !== true || ["account", "csrf", "sessionBinding", "sessionRevision"].some(field => value[field] !== null)
      || member.permissions.some(permission => ["manage_members", "decide"].includes(permission))) {
      throw new RoomClientError(200, "identity_mismatch", "Access does not match the configured agent");
    }
    const now = Date.now();
    if (value.expiresAt <= now) throw new RoomClientError(200, "expiry_unconfirmed", "Check the local clock and agent key expiry");
    return { contractVersion: 1, type: "agent_connection_check", status: "credential_accepted", origin: this.#origin,
      roomId: this.#roomId, memberId: this.#memberId, kind: "agent", permissions: [...member.permissions],
      checkedAt: new Date(now).toISOString(), expiresAt: value.expiresAt, scope: "room", externalExecution: false };
  }
  snapshot({ signal } = {}) { return this.#request("", undefined, signal); }
  async replyRead(name, args = {}, { signal } = {}) {
    const route = replyRoute(name);
    if (!route || !validReplyArguments(name, args)) throw new Error("Invalid request read selection");
    const result = await this.#request(route + "?" + new URLSearchParams(args), undefined, signal);
    return validateReplyRead(result, { name, args, roomId: this.#roomId });
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
  // Selected task only; the normal authenticated snapshot never leaves this client.
  async workPacket(workItemId, options = {}) {
    return workPacket((await this.snapshot()).state, workItemId, options);
  }
  changes(after = 0, limit = 50, { signal } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Use a nonnegative checkpoint and a page size from 1 to 100");
    return this.#request(`/events?after=${after}&limit=${limit}`, undefined, signal);
  }
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
  setNotificationPreferences(preferences, { signal } = {}) {
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("Preferences must be an object");
    return this.command({ id: randomUUID(), type: "notifications.preferences_set", data: { preferences } }, { signal });
  }
  // Round-2 #106/#107: export returns NDJSON text; import posts it back.
  // These bypass #request because the payloads are NDJSON, not JSON.
  async exportRoom({ signal } = {}) {
    const response = await this.#fetch(`${this.#origin}/api/rooms/${encodeURIComponent(this.#roomId)}/export`, {
      headers: { Authorization: `Bearer ${this.#token}` }, signal: signal ?? AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new RoomClientError(response.status, "request_failed", "Room export failed");
    return response.text();
  }
  async importRoom(ndjson, { signal } = {}) {
    if (typeof ndjson !== "string" || !ndjson.trim()) throw new Error("Import needs NDJSON text");
    const response = await this.#fetch(`${this.#origin}/api/rooms/${encodeURIComponent(this.#roomId)}/import`, {
      method: "POST", headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/x-ndjson" },
      body: ndjson, signal: signal ?? AbortSignal.timeout(15000)
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new RoomClientError(response.status, value?.error?.code ?? "request_failed", value?.error?.message ?? "Room import failed");
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
  workSessions({ status, signal } = {}) {
    if (status !== undefined && typeof status !== "string") throw new Error("Choose one session status");
    return this.#request(status ? `/work-sessions?status=${encodeURIComponent(status)}` : "/work-sessions", undefined, signal);
  }
  workSessionAction({ requestId, workItemId, expectedRevision, action, status }, { signal } = {}) {
    if (!validId(requestId) || !validId(workItemId)) throw new Error("requestId and workItemId are required");
    if (!["set_status", "request_stop"].includes(action)) throw new Error("action must be set_status or request_stop");
    return this.#request("/work-sessions", { requestId, workItemId, expectedRevision, action,
      ...(status === undefined ? {} : { status }) }, signal);
  }
  // Claim one queued session atomically: reads the card, then drives it to
  // processing with the card's revision. Throws session_claimed when held.
  async claimSession(workItemId, { signal } = {}) {
    const sessions = await this.workSessions({ signal });
    const card = sessions?.sessions?.find?.(item => item.workItemId === workItemId && item.status === "queued");
    if (!card) throw new Error("No queued session card for that work item");
    return this.workSessionAction({ requestId: randomUUID(), workItemId,
      expectedRevision: card.revision, action: "set_status", status: "processing" }, { signal });
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
