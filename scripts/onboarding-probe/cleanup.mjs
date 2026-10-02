// Archive rooms and revoke identities created by a probe run.
// created.json receives ids only. Secrets stay in memory for this call.
import { randomUUID } from "node:crypto";
import { probeFetch } from "./lib.mjs";

function accountHeaders(origin, room) {
  return {
    origin,
    "content-type": "application/json",
    cookie: room.cookie,
    "x-csrf-token": room.csrf,
    "x-session-binding": room.binding,
    "x-project-room-auth": "account",
  };
}

export async function cleanupAll(target, created) {
  const origin = String(target).replace(/\/$/, "");
  for (const room of created?.rooms ?? []) {
    if (!room?.id) continue;
    const body = JSON.stringify({ id: randomUUID(), type: "room.archived", data: {} });
    const headers = room.auth === "account"
      ? accountHeaders(origin, room)
      : { authorization: `Bearer ${room.secret}`, "content-type": "application/json" };
    if (room.auth !== "account" && !room.secret) continue;
    try {
      await probeFetch(`${origin}/api/rooms/${encodeURIComponent(room.id)}/commands`, { method: "POST", headers, body });
    } catch { /* the purge list still names the room */ }
  }
  for (const identity of created?.identities ?? []) {
    if (!identity?.id || !identity?.secret) continue;
    try {
      await probeFetch(`${origin}/api/agent-identities/${encodeURIComponent(identity.id)}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${identity.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
    } catch { /* the purge list still names the identity */ }
  }
}

export function createdIds(created) {
  return {
    rooms: (created?.rooms ?? []).map(room => room.id).filter(Boolean),
    identities: (created?.identities ?? []).map(identity => identity.id).filter(Boolean),
  };
}
