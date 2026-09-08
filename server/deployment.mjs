import { isAbsolute, resolve } from "node:path";
import { isIP } from "node:net";

const loopback = address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

export function deploymentConfig(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Bind only to loopback; use the same-host HTTPS proxy");
  const production = env.NODE_ENV === "production";
  if (env.ROOM_DEPLOYMENT && env.ROOM_DEPLOYMENT !== "invite-only") throw new Error("Unknown deployment mode");
  if (production !== (env.ROOM_DEPLOYMENT === "invite-only")) throw new Error("Production requires explicit ROOM_DEPLOYMENT=invite-only and NODE_ENV=production");
  const origin = env.ROOM_ORIGIN || `http://${host === "::1" ? "[::1]" : host}:${port}`;
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("ROOM_ORIGIN must be an exact HTTP(S) origin");
  if (url.protocol !== "https:" && (production || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Deployment requires an HTTPS origin");
  if (production && (!env.ROOM_DB || !isAbsolute(env.ROOM_DB))) throw new Error("Production requires an absolute persistent ROOM_DB path");
  return { host, port, origin, filename: resolve(env.ROOM_DB || ".data/room.sqlite"), production };
}

// Only the explicitly enabled same-host proxy may supply this header. It must
// overwrite incoming X-Real-IP with its socket peer, not append or trust a chain.
export function clientAddress(req, trustedLocalProxy = false) {
  const peer = req.socket.remoteAddress;
  if (!trustedLocalProxy) return peer;
  if (!loopback(peer)) throw new Error("Unexpected proxy peer");
  const value = req.headers["x-real-ip"];
  if (typeof value !== "string" || !isIP(value)) throw new Error("Missing or invalid proxy client address");
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname : value;
}
