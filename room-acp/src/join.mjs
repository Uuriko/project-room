// `room-acp <invite link>`: redeem once, save the credential privately.
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { parseInvite } from "./link.mjs";
import { RoomClient } from "./room.mjs";
import { saveConnection } from "./credentials.mjs";
import { registerSecret } from "./redact.mjs";

export function defaultHostId() {
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "host";
  return `room-acp-${host}-${randomBytes(3).toString("hex")}`;
}

export async function join({ link, displayName, agent = null, origin, env = process.env, fetchImpl = fetch }) {
  const { apiBase, code } = parseInvite(link, origin ? { origin } : {});
  registerSecret(code);
  const room = new RoomClient({ apiBase, fetchImpl });
  const joined = await room.redeem({ code, displayName });
  registerSecret(joined.credential); registerSecret(joined.identitySecret);
  const connection = { version: 1, apiBase, ...joined, hostId: defaultHostId(), agent, joinedAt: new Date().toISOString() };
  saveConnection(connection, env);
  return connection;
}
