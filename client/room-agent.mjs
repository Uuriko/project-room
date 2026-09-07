import { validId } from "../src/events.js";
import { nextWorkStep } from "../src/workflow.js";

export class RoomClientError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Minimal, explicit client for a single configured service and Room. It neither
// dispatches agents nor follows evidence links. Keep the token in operator memory.
export class RoomAgentClient {
  #origin;
  #roomId;
  #token;
  #fetch;
  constructor({ origin, roomId, token, fetchImpl = globalThis.fetch }) {
    const url = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Use a fixed HTTPS origin or an isolated loopback development origin");
    if (!validId(roomId) || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("A valid Room and access key are required");
    this.#origin = origin; this.#roomId = roomId; this.#token = token; this.#fetch = fetchImpl;
  }
  async #request(suffix = "", body) {
    const response = await this.#fetch(`${this.#origin}/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (!response.ok) throw new RoomClientError(response.status, value.error?.code ?? "request_failed", value.error?.message ?? "Room request failed");
    return value;
  }
  snapshot() { return this.#request(); }
  changes(after = 0, limit = 50) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Use a nonnegative checkpoint and a page size from 1 to 100");
    return this.#request(`/events?after=${after}&limit=${limit}`);
  }
  returnBrief({ limit = 50, horizon, after, cursor } = {}) {
    const query = new URLSearchParams({ limit });
    for (const [name, value] of Object.entries({ horizon, after, cursor })) if (value !== undefined) query.set(name, value);
    return this.#request(`/return-brief?${query}`);
  }
  // Caller owns a stable command ID. On an uncertain transport result, reconcile
  // or resend this exact object. Never invent a replacement ID automatically.
  command(command) { return this.#request("/commands", command); }
  async orient() {
    const snapshot = await this.snapshot();
    const member = snapshot.state.members[snapshot.viewerId];
    return {
      contractVersion: 1, roomId: snapshot.roomId, evaluatedThrough: snapshot.sequence,
      member, scope: { kind: "room", permissions: member.permissions, externalExecution: false },
      work: Object.values(snapshot.state.workItems).map(item => ({
        id: item.id, title: item.title, definitionOfDone: item.definitionOfDone, sourceMessageId: item.sourceMessageId,
        state: item.state, revision: item.revision, next: nextWorkStep(item),
        receipt: item.receipt, verification: item.verification, decision: item.decision, blocker: item.blocker
      }))
    };
  }
}
