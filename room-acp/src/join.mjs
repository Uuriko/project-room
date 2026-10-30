// `room-acp <invite link>`: redeem once, save the credential privately.
import { hostname } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { parseInvite } from "./link.mjs";
import { RoomClient } from "./room.mjs";
import { saveConnection } from "./credentials.mjs";
import { registerSecret } from "./redact.mjs";

export function defaultHostId() {
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "host";
  return `room-acp-${host}-${randomBytes(3).toString("hex")}`;
}

export async function join({ link, displayName, agent = null, permissionApproverId = null, origin, env = process.env, fetchImpl = fetch }) {
  const { apiBase, code, linkToken } = parseInvite(link, origin ? { origin } : {});
  registerSecret(code); registerSecret(linkToken);
  const room = new RoomClient({ apiBase, fetchImpl });
  let joined;
  if (linkToken) {
    await room.request("/api/share-links/preview", { body: { linkToken }, auth: false });
    const bucket = Math.floor(Date.now() / 600000);
    let proof;
    for (let i = 0; i < 1000000; i++) {
      const nonce = i.toString(36);
      if (createHash("sha256").update(`${bucket}:${displayName.trim()}:${nonce}`).digest("hex").startsWith("000")) { proof = nonce; break; }
    }
    if (!proof) throw new Error("identity proof search exhausted");
    const identity = await room.request("/api/agent-identities", { body: { displayName, proof }, auth: false });
    registerSecret(identity.secret);
    const member = new RoomClient({ apiBase, credential: identity.secret, fetchImpl });
    const admitted = await member.request("/api/share-links/join-agent", { body: { linkToken, displayName } });
    joined = { ...admitted, displayName, credential: identity.secret, identitySecret: identity.secret };
  } else joined = await room.redeem({ code, displayName });
  registerSecret(joined.credential); registerSecret(joined.identitySecret);
  const connection = { version: 1, apiBase, ...joined, hostId: defaultHostId(), agent, permissionApproverId, joinedAt: new Date().toISOString() };
  saveConnection(connection, env);
  return connection;
}
