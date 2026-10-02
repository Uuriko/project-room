import { randomUUID } from "node:crypto";
import { redact } from "./redact.mjs";

export const BOT_HOST_ID = "room-machine";

async function call(origin, path, { token, method = "GET", body, signal } = {}) {
  try {
    const headers = { accept: "application/json", origin };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(path, origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let value = null;
    if (text) {
      try { value = JSON.parse(text); } catch { value = null; }
    }
    return { ok: response.ok, status: response.status, value };
  } catch {
    return { ok: false, status: 0, value: null };
  }
}

export function createRoomApi({ origin, secret, signal }) {
  const auth = { token: secret, signal };
  return {
    async heartbeat() {
      return call(origin, "/api/agent-heartbeats", {
        ...auth,
        method: "POST",
        body: { hostId: BOT_HOST_ID, mode: "wakeable", cadenceSeconds: 300, workWakes: true },
      });
    },
    async poll(waitMs) {
      const wait = Number.isInteger(waitMs) && waitMs >= 0 ? waitMs : 0;
      return call(origin, `/api/agent-wakes/poll?hostId=${encodeURIComponent(BOT_HOST_ID)}&waitMs=${wait}`, auth);
    },
    async ack(signalIds) {
      if (!Array.isArray(signalIds) || signalIds.length === 0) return { ok: true, value: { acknowledged: [] } };
      return call(origin, "/api/agent-heartbeats/ack", { ...auth, method: "POST", body: { signalIds } });
    },
    async conversation(roomId, { messageId, limit } = {}) {
      const query = messageId
        ? `messageId=${encodeURIComponent(messageId)}`
        : `limit=${limit ?? 40}`;
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/conversation?${query}`, auth);
    },
    async post(roomId, body, { replyToId = null, secrets = [] } = {}) {
      const id = randomUUID();
      const clean = redact(body, secrets);
      const data = { messageId: id, body: clean };
      if (replyToId) data.replyToId = replyToId;
      const posted = await call(origin, `/api/rooms/${encodeURIComponent(roomId)}/commands`, {
        ...auth,
        method: "POST",
        body: { id, type: "message.posted", data },
      });
      return { ...posted, messageId: id };
    },
    async claims(roomId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims?limit=200`, auth);
    },
    async claim(roomId, claimId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}`, auth);
    },
    async createClaim(roomId, body) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims`, { ...auth, method: "POST", body });
    },
    async takeClaim(roomId, claimId, body) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/claim`, {
        ...auth, method: "POST", body,
      });
    },
    async updateClaim(roomId, claimId, body) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/update`, {
        ...auth, method: "POST", body,
      });
    },
    async pause(roomId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/agent-pause`, auth);
    },
    async tier(roomId, memberId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/operator/agents/${encodeURIComponent(memberId)}`, auth);
    },
  };
}
