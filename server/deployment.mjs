import { isIP } from "node:net";
export {
  STREAM_INTERVAL_DEFAULT_MS,
  STREAM_INTERVAL_MIN_MS,
  STREAM_INTERVAL_MAX_MS,
  streamIntervalConfig,
  deploymentConfig,
} from "./config.mjs";

const loopback = address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

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
