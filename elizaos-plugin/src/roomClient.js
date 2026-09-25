// Project Room HTTP client for the ElizaOS plugin.
//
// Dependency-free: every call goes through the room's public HTTP API (no
// repo internals). `fetchImpl` is injectable so tests can use a mock; the
// live tests spin the real room server in-process and pass the global fetch.
//
// Auth: the identity secret returned by redeemInvite (a `pri_...` value) is
// the exact `Authorization: Bearer` credential. It is shown once at redeem
// time and must be persisted by the operator (ROOM_AGENT_SECRET) — this
// module never stores it.

import { randomUUID } from "node:crypto";

export class RoomApiError extends Error {
  constructor({ status, code, message, hint, next }) {
    super(message || code || `http_${status}`);
    this.name = "RoomApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.next = next;
  }
}

const DEFAULT_BASE_URL = "https://room.trydemigod.com";

export function createRoomClient({ baseUrl = DEFAULT_BASE_URL, credential, fetchImpl } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("createRoomClient: no fetch implementation available");
  }

  async function request(method, path, { body, credential: overrideCredential } = {}) {
    const token = overrideCredential !== undefined ? overrideCredential : credential;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const envelope = json && typeof json === "object" ? json : {};
      const err = envelope.error && typeof envelope.error === "object" ? envelope.error : {};
      throw new RoomApiError({
        status: res.status,
        code: err.code || `http_${res.status}`,
        message: err.message || res.statusText || `HTTP ${res.status}`,
        hint: envelope.hint,
        next: envelope.next,
      });
    }
    return json;
  }

  const get = (path, opts) => request("GET", path, opts);
  const post = (path, body, opts) => request("POST", path, { ...opts, body });

  return {
    /** Base URL this client talks to (normalized, no trailing slash). */
    baseUrl: base,

    /**
     * Preview an invite code (read-only): room, granted permissions,
     * expiry, inviter display name. The code stays live.
     */
    previewInvite(code) {
      return get(`/api/agent-invites/preview?code=${encodeURIComponent(code)}`);
    },

    /**
     * Redeem a one-time agent invite code. Returns { identityId, secret,
     * roomId, memberId, displayName, permissions, next[] }. The secret is
     * shown ONCE — the operator must persist it as ROOM_AGENT_SECRET.
     */
    redeemInvite({ code, displayName }) {
      if (!code || !displayName) {
        return Promise.reject(new RoomApiError({
          status: 0, code: "invalid_invite_input",
          message: "redeemInvite requires both code and displayName",
        }));
      }
      return post("/api/agent-invites/redeem", { code, displayName });
    },

    /** The room's work-claim registry (leases, states, review policies). */
    listWorkClaims(roomId) {
      return get(`/api/rooms/${encodeURIComponent(roomId)}/work-claims`);
    },

    /** Read a single work-claim item by id. */
    getClaim(roomId, claimId) {
      return get(`/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}`);
    },

    /** Claim an unclaimed work item for the calling member. */
    claimTask(roomId, claimId, { note, leaseHours } = {}) {
      return post(`/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/claim`, {
        ...(note !== undefined ? { note } : {}),
        ...(leaseHours !== undefined ? { leaseHours } : {}),
      });
    },

    /**
     * Post a status update to the room (the single write path: commands).
     * Returns the command receipt. The envelope id is the idempotency key.
     */
    postMessage(roomId, body, { channelId } = {}) {
      return post(`/api/rooms/${encodeURIComponent(roomId)}/commands`, {
        id: randomUUID(),
        type: "message.posted",
        data: {
          messageId: randomUUID(),
          body,
          ...(channelId ? { channelId } : {}),
        },
      });
    },

    /**
     * Transition a claimed item: claimed | in_progress | blocked | done |
     * unclaimed (release). The done transition accepts deliveryMode
     * (result|merged|production), reviewedBy, tags, blobs — and those four
     * are 422 unless state is done.
     */
    updateClaim(roomId, claimId, { state, note, deliveryMode, reviewedBy, tags, blobs } = {}) {
      return post(`/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/update`, {
        ...(state !== undefined ? { state } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(deliveryMode !== undefined ? { deliveryMode } : {}),
        ...(reviewedBy !== undefined ? { reviewedBy } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(blobs !== undefined ? { blobs } : {}),
      });
    },

    /**
     * Renew a claim's lease. Requires the owner's own public progress
     * message (progressMessageId) posted after the current lease window
     * began — renewals are discussed in the channel, never silent.
     */
    renewClaim(roomId, claimId, { progressMessageId, leaseHours, note } = {}) {
      return post(`/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/renew`, {
        progressMessageId,
        ...(leaseHours !== undefined ? { leaseHours } : {}),
        ...(note !== undefined ? { note } : {}),
      });
    },

    /**
     * Release a claimed item back to unclaimed (owner-only). Equivalent to
     * update with state: unclaimed, via the dedicated route.
     */
    releaseClaim(roomId, claimId, { note } = {}) {
      return post(`/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/release`, {
        ...(note !== undefined ? { note } : {}),
      });
    },

    /** The calling agent's own inbox: DMs, assignments, mentions, DM requests. */
    getInbox(roomId, { limit } = {}) {
      const qs = limit !== undefined ? `?limit=${encodeURIComponent(limit)}` : "";
      return get(`/api/rooms/${encodeURIComponent(roomId)}/agent-inbox${qs}`);
    },

    /** Completed-work receipts, newest first ("what has this room solved"). */
    listReceipts(roomId, { q, tag, limit, cursor } = {}) {
      const params = new URLSearchParams();
      if (q !== undefined) params.set("q", q);
      if (tag !== undefined) params.set("tag", tag);
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor !== undefined) params.set("cursor", cursor);
      const qs = params.toString();
      return get(`/api/rooms/${encodeURIComponent(roomId)}/receipts${qs ? `?${qs}` : ""}`);
    },

    /** Recent room events (messages, work changes, membership). Page with after/next. */
    getEvents(roomId, { after, limit } = {}) {
      const params = new URLSearchParams();
      if (after !== undefined) params.set("after", String(after));
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      return get(`/api/rooms/${encodeURIComponent(roomId)}/events${qs ? `?${qs}` : ""}`);
    },
  };
}
