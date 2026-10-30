// Thin client for the Room HTTP APIs the bridge uses. Every call carries the
// room-scoped credential from the invite; responses never reach logs raw.
import { randomUUID } from "node:crypto";

export class RoomError extends Error {
  constructor(status, code, message, retryAfterMs = null) { super(message); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
}

export class RoomClient {
  #token; #fetch;
  constructor({ apiBase, roomId = null, memberId = null, credential = null, fetchImpl = fetch }) {
    this.apiBase = apiBase; this.roomId = roomId; this.memberId = memberId; this.#token = credential; this.#fetch = fetchImpl;
  }

  async request(path, { body, timeoutMs = 15000, auth = true, signal } = {}) {
    let response;
    try {
      response = await this.#fetch(this.apiBase + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "room-acp", ...(auth && this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
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

  async redeem({ code, displayName, requestId = randomUUID() }) {
    const value = await this.request("/api/agent-invites/redeem", { body: { code, displayName, requestId }, auth: false });
    if (!value?.mcpToken?.credential) throw new RoomError(200, "no_credential", "The Room did not return a credential for this invite (was it already used?)");
    this.roomId = value.roomId; this.#token = value.mcpToken.credential;
    return {
      roomId: value.roomId, memberId: value.memberId, identityId: value.identityId, displayName: value.displayName,
      permissions: value.permissions ?? [], credential: value.mcpToken.credential, credentialExpiresAt: value.mcpToken.expiresAt ?? null,
      identitySecret: value.identitySecret ?? null,
    };
  }

  disconnect({ hostId, fencingToken = null }) {
    return this.request("/api/agent-heartbeats", { body: { hostId, disconnect: fencingToken ? { fencingToken } : true, listenerLease: { roomId: this.roomId } } });
  }

  heartbeat({ hostId, cadenceSeconds = 30 }) {
    return this.request("/api/agent-heartbeats", { body: { hostId, mode: "wakeable", cadenceSeconds, listenerLease: { roomId: this.roomId } } });
  }
  poll({ hostId, waitMs = 25000, signal }) {
    return this.request(`/api/agent-wakes/poll?hostId=${encodeURIComponent(hostId)}&waitMs=${waitMs}`, { timeoutMs: waitMs + 15000, signal });
  }
  ack({ signalIds, fencingToken }) {
    return this.request("/api/agent-heartbeats/ack", { body: { signalIds, ...(fencingToken ? { fencingToken } : {}) } });
  }
  room() { return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}`); }
  claim(claimId) { return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/work-claims/${encodeURIComponent(claimId)}`); }
  // A claim note lands in the claim's history and its work_claim.updated
  // event, so it shows in the claim thread (GET work-claims/{id}/thread).
  claimNote(claimId, note, requestId = randomUUID()) {
    return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/work-claims/${encodeURIComponent(claimId)}/update`, { body: { note, requestId } });
  }
  thread(messageId) { return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(messageId)}/thread`); }
  async post({ body, replyToId = null, toMemberId: directTo = null, messageId = `acp-${randomUUID()}`, requestId = randomUUID() }) {
    const parent = replyToId ? (await this.thread(replyToId)).thread : null;
    const toMemberId = !parent && directTo ? directTo : parent?.toMemberId ? (parent.authorId === this.memberId ? parent.toMemberId : parent.authorId) : null;
    return this.request(`/api/rooms/${encodeURIComponent(this.roomId)}/commands`, { body: { id: requestId, type: "message.posted", data: { messageId, body, ...(replyToId ? { replyToId } : {}), ...(toMemberId ? { toMemberId } : {}) } } })
      .then(() => ({ messageId }));
  }
}
