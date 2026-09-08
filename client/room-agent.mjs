import { validId, PERMISSIONS } from "../src/events.js";
import { nextWorkStep, workActions, reusableWorkDefinition } from "../src/workflow.js";
import { workPacket, resultDraft, verifyWorkResult } from "../src/work-packet.js";
import { submitWorkAction } from "./work-actions.mjs";
import { replyRoute, validReplyArguments, validateReplyRead, submitReplyAction } from "./reply-actions.mjs";
import { charterContext, validateCharterContext, validateCharterRead } from "../src/room-charter.js";

export class RoomClientError extends Error {
  constructor(status, code, message, retryAfterMs = null) { super(message); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
}
function checkedCharter(value, horizon) {
  try {
    const result = validateCharterContext(value);
    if (!Number.isSafeInteger(horizon) || result.revision > horizon) throw new Error();
    return result;
  } catch { throw new RoomClientError(200, "invalid_response", "Room returned invalid instructions metadata"); }
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
    if (!validId(roomId) || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("A valid Room and access key are required");
    if (memberId !== undefined && !validId(memberId)) throw new Error("Choose a valid expected agent member");
    this.#origin = origin; this.#roomId = roomId; this.#token = token; this.#fetch = fetchImpl;
    this.#memberId = memberId;
  }
  async #fetchPath(path, body, signal) {
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
      throw new RoomClientError(response.status, value?.error?.code ?? "request_failed", value?.error?.message ?? "Room request failed", Number.isFinite(parsed) ? Math.max(0, parsed) : null);
    }
    return value;
  }
  async #request(suffix = "", body, signal) {
    // Saved configurations pin an agent. Recheck before each operation; a check
    // is never a cached grant. The service still authorizes the operation itself.
    if (this.#memberId) await this.checkConnection({ signal });
    const value = await this.#fetchPath(`/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, body, signal);
    if (this.#memberId && (suffix === "" || suffix === "/charter" || suffix.startsWith("/charter?") || suffix.startsWith("/work-context?") || suffix.startsWith("/work-discussion?") || suffix.startsWith("/work-result?") || suffix.startsWith("/return-brief?") || /^\/reply-(requests|context|history)\?/.test(suffix))) {
      if (value?.roomId !== this.#roomId || value.viewerId !== this.#memberId || value.viewerAccountId !== null
        || value.viewerAuthEpoch !== null || value.viewerSessionBinding !== null || value.viewerSessionRevision !== null) {
        throw new RoomClientError(200, "identity_mismatch", "Room response does not match the configured agent");
      }
      const member = suffix === "" ? value.state?.members?.[this.#memberId] : suffix.startsWith("/work-context?") ? value.viewer : null;
      if ((suffix === "" || suffix.startsWith("/work-context?")) && (member?.id !== this.#memberId || member.kind !== "agent" || member.active !== true)) {
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
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["includeSource", "signal"].includes(key))) throw new Error("Use includeSource and signal options only");
    const { includeSource = false, signal } = options;
    if (!validId(workItemId) || typeof includeSource !== "boolean") throw new Error("Choose one work ID and a boolean includeSource option");
    const query = new URLSearchParams({ workItemId });
    if (includeSource) query.set("includeSource", "true");
    const result = await this.#request(`/work-context?${query}`, undefined, signal);
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
  workAction(name, args, options = {}) {
    return submitWorkAction(this, { roomId: this.#roomId, memberId: this.#memberId }, name, args, options);
  }
  async orient({ signal, focus = "all" } = {}) {
    if (!["all", "needs_me"].includes(focus)) throw new RoomClientError(0, "invalid_focus", "Choose all work or work needing you");
    const snapshot = await this.snapshot({ signal });
    const member = snapshot.state.members[snapshot.viewerId];
    const charter = snapshot.charter === undefined ? null : checkedCharter(snapshot.charter, snapshot.sequence);
    try {
      if (charter === null ? snapshot.state.room.charter !== undefined : JSON.stringify(charter) !== JSON.stringify(charterContext(snapshot.state.room))) throw new Error();
    } catch { throw new RoomClientError(200, "invalid_response", "Room instructions do not match the snapshot"); }
    const now = Date.now(), items = Object.values(snapshot.state.workItems);
    if (focus === "needs_me") {
      const work = items.flatMap(item => {
        const next = nextWorkStep(item, now);
        if (!member.active || next.memberId !== member.id || !next.needsAttention) return [];
        return [{ id: item.id, title: item.title, state: item.state, revision: item.revision, mode: item.mode, next,
          availableRoomActions: workActions(item, member, now).map(([action, label]) => ({ action, label })),
          nextRead: { tool: "room_read_work", arguments: { workItemId: item.id } } }];
      });
      return { contractVersion: 1, roomId: snapshot.roomId, evaluatedThrough: snapshot.sequence,
        evaluatedAt: new Date(now).toISOString(), clockSource: "client", focus, charter, member,
        scope: { kind: "room", permissions: member.permissions, externalExecution: false },
        selection: { totalWork: items.length, needsMe: work.length,
          guidance: "Current next steps addressed to you, including those missing a Room permission. Not all your ongoing work or reply requests. Read selected work before acting; available actions are descriptions, not execution grants. Empty does not mean the room is done." },
        work };
    }
    return {
      contractVersion: 1, roomId: snapshot.roomId, evaluatedThrough: snapshot.sequence,
      charter,
      member, scope: { kind: "room", permissions: member.permissions, externalExecution: false },
      work: items.map(item => ({
        id: item.id, title: item.title, definitionOfDone: item.definitionOfDone, sourceMessageId: item.sourceMessageId,
        state: item.state, revision: item.revision, mode: item.mode, claim: item.claim, next: nextWorkStep(item, now),
        receipt: item.receipt, verification: item.verification, decision: item.decision, blocker: item.blocker
      }))
    };
  }
}
