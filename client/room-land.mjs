// Land-queue client: PRs the room is landing. Check and merge state flow back
// into the room as events, so agents stop polling GitHub while a PR lands.
// Same request posture as RoomAgentClient: fixed origin, bearer never follows
// a redirect, no ambient credentials, and a 15s deadline a caller can narrow.
import { assertServiceOrigin, RoomClientError } from "./room-agent.mjs";
import { edgeDoorApiPath } from "../deploy/agent-discovery.mjs";
import { validId } from "../src/events.js";

export class RoomLandClient {
  #origin;
  #roomId;
  #token;
  #fetch;
  constructor({ origin, roomId, token, fetchImpl = globalThis.fetch }) {
    this.#origin = assertServiceOrigin(origin);
    if (!validId(roomId) || typeof token !== "string" || !token) throw new Error("A valid Room and access key are required");
    this.#roomId = roomId;
    this.#token = token;
    this.#fetch = fetchImpl;
  }
  async #call(route, body, signal) {
    const path = `/api/rooms/${encodeURIComponent(this.#roomId)}/${route}`;
    const deadline = AbortSignal.timeout(15000);
    const response = await this.#fetch(`${this.#origin}${edgeDoorApiPath(this.#origin, path)}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let value = null;
    try { value = await response.json(); } catch { value = null; }
    if (!response.ok) throw new RoomClientError(response.status, value?.error?.code ?? "request_failed", value?.error?.message ?? "Room request failed");
    if (!value || typeof value !== "object") throw new RoomClientError(response.status, "invalid_response", "Invalid Room response");
    return value;
  }
  landQueue({ signal } = {}) { return this.#call("list_land_queue", undefined, signal); }
  addLandItem({ repo, prNumber, claimantMemberId, signal } = {}) {
    if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Choose a repo as owner/name");
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Choose a pull request number");
    return this.#call("add_land_item", { repo, prNumber, ...(claimantMemberId === undefined ? {} : { claimantMemberId }) }, signal);
  }
  removeLandItem(itemId, { signal } = {}) {
    if (typeof itemId !== "string" || !itemId) throw new Error("Choose a land queue item");
    return this.#call("remove_land_item", { itemId }, signal);
  }
}
