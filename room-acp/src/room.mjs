// Thin client for the Room HTTP APIs the bridge uses. Every call carries the
// room-scoped credential from the invite. Only explicit redemption recovery
// uses its private identity secret; responses never reach logs raw.
import { randomUUID } from "node:crypto";

export class RoomError extends Error {
  constructor(status, code, message, retryAfterMs = null) { super(message); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
}

export class RoomClient {
  #token; #fetch; #identitySecret;
  constructor({ apiBase, roomId = null, memberId = null, credential = null, identitySecret = null, fetchImpl = fetch }) {
    this.apiBase = apiBase; this.roomId = roomId; this.memberId = memberId; this.#token = credential; this.#identitySecret = identitySecret; this.#fetch = fetchImpl;
  }

  async request(path, { body, timeoutMs = 15000, auth = true, signal, listenerToken } = {}) {
    let response;
    try {
      response = await this.#fetch(this.apiBase + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "room-acp", ...(listenerToken === undefined ? {} : { "x-room-listener-token": listenerToken }), ...(auth && this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json", origin: new URL(this.apiBase).origin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new RoomError(0, error?.name === "TimeoutError" ? "timeout" : "network", "Room not reachable");
    }
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      throw new RoomError(response.status, value?.error?.code ?? "http_error", value?.error?.message ?? `HTTP ${response.status}`, Number.isFinite(retry) && retry > 0 ? retry * 1000 : null);
    }
    return value;
  }

  async redeem({ code, displayName, requestId = randomUUID(), saveRecovery = async () => {} }) {
    const identity=this.#identitySecret ? new RoomClient({apiBase:this.apiBase,credential:this.#identitySecret,fetchImpl:this.#fetch}) : null;
    const value = await (identity ?? this).request("/api/agent-invites/redeem", { body: { code, displayName, requestId }, auth: Boolean(identity) });
    const identitySecret=value?.identitySecret ?? this.#identitySecret;
    if (!value?.mcpToken?.credential) {
      if(value?.duplicate!==true || typeof identitySecret!=='string' || !identitySecret.startsWith('pri_')
        || !Array.isArray(value.next) || !value.next.some(step=>step?.action==='rotate'))
        throw new RoomError(200,"no_credential","The Room did not return a recoverable connection for this invite");
      const recovery={roomId:value.roomId,memberId:value.memberId,identityId:value.identityId,displayName:value.displayName,
        permissions:value.permissions ?? [],identitySecret};
      await saveRecovery(recovery); // Before rotation: a lost rotate response must not lose identity.
      return this.recoverRedemption(recovery);
    }
    return this.#redeemed({...value,identitySecret},value.mcpToken);
  }
  #redeemed(value,token) {
    if(typeof value.roomId!=='string' || typeof value.memberId!=='string' || typeof value.identityId!=='string'
      || typeof token?.credential!=='string' || !token.credential.startsWith('rak_'))
      throw new RoomError(200,'invalid_response','Room returned an invalid connection');
    this.roomId=value.roomId;this.memberId=value.memberId;this.#token=token.credential;this.#identitySecret=value.identitySecret ?? null;
    return {roomId:value.roomId,memberId:value.memberId,identityId:value.identityId,displayName:value.displayName,
      permissions:value.permissions ?? [],credential:token.credential,credentialExpiresAt:token.expiresAt ?? null,identitySecret:value.identitySecret ?? null};
  }
  async recoverRedemption(recovery) {
    const identity=new RoomClient({apiBase:this.apiBase,credential:recovery.identitySecret,fetchImpl:this.#fetch});
    const rotated=await identity.request(`/api/agent-rooms/${encodeURIComponent(recovery.roomId)}/token/rotate`,{body:{}});
    if(rotated?.roomId!==recovery.roomId)throw new RoomError(200,'identity_mismatch','Recovery returned another room');
    return this.#redeemed(recovery,rotated.mcpToken);
  }

  async checkConnection() {
    const access=await this.request(`/api/rooms/${encodeURIComponent(this.roomId)}?view=identity`);
    if(access?.snapshotView!=='identity' || access?.snapshotVersion!==1 || access?.viewerId!==this.memberId
      || access?.roomId!==this.roomId || access?.state?.members?.[this.memberId]?.id!==this.memberId
      || access.state.members[this.memberId].kind!=='agent' || access.state.members[this.memberId].active!==true)
      throw new RoomError(200,'identity_mismatch','Saved connection no longer matches active membership');
    return access;
  }

  disconnect({ hostId, fencingToken = null }) {
    return this.request("/api/agent-heartbeats", { body: { hostId, disconnect: fencingToken ? { fencingToken } : true, listenerLease: { roomId: this.roomId } } });
  }

  heartbeat({ hostId, cadenceSeconds = 30 }) {
    return this.request("/api/agent-heartbeats", { body: { hostId, mode: "wakeable", cadenceSeconds, listenerLease: { roomId: this.roomId } } });
  }
  async poll({ hostId, waitMs = 25000, signal, cursor = null }) {
    const roomId = this.roomId;
    // Match the server poll route's validId + 64-character bound without
    // importing server modules into the independently distributed ACP client.
    if (typeof roomId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(roomId)
      || ["constructor", "prototype", "__proto__"].includes(roomId))
      throw new RoomError(409, "wake_scope_unavailable", "The saved room ID is invalid; check the saved room before restarting. No wake request was sent.");
    const page = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const value = await this.request(`/api/agent-wakes/poll?hostId=${encodeURIComponent(hostId)}&waitMs=${waitMs}&roomId=${encodeURIComponent(roomId)}${page}`, { timeoutMs: waitMs + 15000, signal });
    if (value?.roomId !== roomId
      || !Array.isArray(value.pendingWakes) || value.pendingWakes.some(wake => wake?.roomId !== roomId))
      throw new RoomError(409, "wake_scope_unavailable", "Room did not confirm the selected wake scope; upgrade the server and check the saved room before restarting. No foreign wakes were handled.");
    return value;
  }
  ack({ signalIds, fencingToken }) {
    return this.request("/api/agent-heartbeats/ack", { body: { signalIds, ...(fencingToken ? { fencingToken } : {}) } });
  }
  checkListener(fencingToken) {
    return this.request(`/api/agent-heartbeats?roomId=${encodeURIComponent(this.roomId)}`, { listenerToken: fencingToken });
  }
  async room({ authorityFor = null } = {}) {
    const path = `/api/rooms/${encodeURIComponent(this.roomId)}`;
    if (authorityFor === null) return this.request(path);
    const unavailable = () => {
      throw new RoomError(409, 'selected_authority_unavailable', 'Room does not provide complete selected authority; no full-snapshot fallback is allowed');
    };
    if (!Array.isArray(authorityFor)) unavailable();
    const requested = [...new Set(authorityFor)].sort();
    if (requested.length > 64 || requested.some(id => typeof id !== 'string' || !id || id.length > 128)) unavailable();
    const query = new URLSearchParams({ view: 'authority' });
    for (const id of requested) query.append('memberId', id);
    let value;
    try { value = await this.request(path + '?' + query); }
    catch (error) {
      if (error instanceof RoomError && error.status === 422 && error.code === 'invalid_snapshot_view') unavailable();
      throw error;
    }
    const selection = value?.authoritySelection, members = value?.state?.members, ownerId = value?.state?.room?.ownerId;
    if (value?.snapshotView !== 'authority' || value.snapshotVersion !== 1 || value.roomId !== this.roomId || value.viewerId !== this.memberId
        || selection?.complete !== true || JSON.stringify(selection.requestedMemberIds) !== JSON.stringify(requested)
        || !Array.isArray(selection.unresolvedMemberIds) || !members || Array.isArray(members) || typeof ownerId !== 'string'
        || !Object.hasOwn(members, ownerId) || !Object.hasOwn(members, this.memberId)
        || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) unavailable();
    const included = [...new Set([this.memberId, ownerId, ...requested])].sort();
    const unresolved = new Set(selection.unresolvedMemberIds);
    if (unresolved.size !== selection.unresolvedMemberIds.length
        || [...unresolved].some(id => !included.includes(id) || Object.hasOwn(members, id))
        || Object.keys(members).some(id => !included.includes(id) || members[id]?.id !== id)
        || included.some(id => !Object.hasOwn(members, id) && !unresolved.has(id))) unavailable();
    return value;
  }
  claim(claimId) { return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/work-claims/${encodeURIComponent(claimId)}`); }
  // A claim note lands in the claim's history and its work_claim.updated
  // event, so it shows in the claim thread (GET work-claims/{id}/thread).
  claimNote(claimId, note, requestId = randomUUID(), listenerToken = this.listenerToken) {
    return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/work-claims/${encodeURIComponent(claimId)}/update`, { body: { note, requestId }, listenerToken });
  }
  thread(messageId, {selected = false} = {}) {
    return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(messageId)}/thread${selected ? '?view=message' : ''}`).then(value => {
      if (selected && (value?.messageContextVersion !== 1 || value.roomId !== this.roomId || value.thread?.id !== messageId))
        throw new RoomError(409, 'selected_message_context_unavailable', 'Room does not provide the addressed message context required by this listener');
      return value;
    });
  }
  requestContext(requestMessageId, cursor = null) {
    return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/reply-context?requestMessageId=${encodeURIComponent(requestMessageId)}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
  }
  async post({ body, replyToId = null, toMemberId: directTo = null, messageId = `acp-${randomUUID()}`, requestId = randomUUID(), listenerToken = this.listenerToken }) {
    const parent = replyToId ? (await this.thread(replyToId, {selected:true})).thread : null;
    const toMemberId = !parent && directTo ? directTo : parent?.toMemberId ? (parent.authorId === this.memberId ? parent.toMemberId : parent.authorId) : null;
    return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/commands`, { body: { id: requestId, type: "message.posted", data: { messageId, body, ...(replyToId ? { replyToId } : {}), ...(toMemberId ? { toMemberId } : {}) } }, listenerToken })
      .then(() => ({ messageId }));
  }
}
