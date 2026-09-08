import { validId } from "../src/events.js";
import { nextWorkStep } from "../src/workflow.js";
import { workPacket } from "../src/work-packet.js";

export class RoomClientError extends Error {
  constructor(status, code, message, retryAfterMs = null) { super(message); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
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
  async #request(suffix = "", body, signal) {
    const response = await this.#fetch(`${this.#origin}/api/rooms/${encodeURIComponent(this.#roomId)}${suffix}`, {
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
  snapshot({ signal } = {}) { return this.#request("", undefined, signal); }
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
  command(command) { return this.#request("/commands", command); }
  async orient() {
    const snapshot = await this.snapshot();
    const member = snapshot.state.members[snapshot.viewerId];
    return {
      contractVersion: 1, roomId: snapshot.roomId, evaluatedThrough: snapshot.sequence,
      member, scope: { kind: "room", permissions: member.permissions, externalExecution: false },
      work: Object.values(snapshot.state.workItems).map(item => ({
        id: item.id, title: item.title, definitionOfDone: item.definitionOfDone, sourceMessageId: item.sourceMessageId,
        state: item.state, revision: item.revision, mode: item.mode, claim: item.claim, next: nextWorkStep(item),
        receipt: item.receipt, verification: item.verification, decision: item.decision, blocker: item.blocker
      }))
    };
  }
}
