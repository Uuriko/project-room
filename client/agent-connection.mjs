import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync, fsyncSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { RoomAgentClient, RoomClientError } from "./room-agent.mjs";

const fields = ["version", "origin", "roomId", "memberId", "token"];
const variables = ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"];
const filename = "connection.json", limit = 4096;
export class ConnectionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function validate(value) {
  try {
    if (!value || Array.isArray(value) || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field)) || value.version !== 1 || typeof value.memberId !== "string") throw new Error();
    new RoomAgentClient(value);
    return Object.fromEntries(fields.map(field => [field, value[field]]));
  } catch { throw new ConnectionError("invalid_config"); }
}
export async function readConnectionInput(input = process.stdin) {
  // Pipe from a secret manager/clipboard; never echo a key in an interactive terminal.
  if (input.isTTY) throw new ConnectionError("usage_error");
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > limit) throw new ConnectionError("invalid_config");
      chunks.push(bytes);
    }
    return validate(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { throw new ConnectionError("invalid_config"); }
}
function privateStat(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || (stat.mode & 0o077)
    || !process.getuid || stat.uid !== process.getuid()) throw new ConnectionError("config_not_private");
}
export function readAgentConnection(directory) {
  let fd;
  try {
    if (typeof directory !== "string" || !directory.trim()) throw new ConnectionError("invalid_config");
    const path = resolve(directory);
    privateStat(lstatSync(path), true);
    fd = openSync(join(realpathSync(path), filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); privateStat(stat);
    if (stat.size > limit) throw new ConnectionError("invalid_config");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null))) length += count;
    if (length > limit) throw new ConnectionError("invalid_config");
    return validate(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(error.code === "ENOENT" ? "config_not_found" : error.code === "ELOOP" ? "config_not_private" : "invalid_config");
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Explicit local persistence, never a key issuer or a rotation operation. A new
// dedicated directory is required; an existing connection is never overwritten.
export function saveAgentConnection(directory, value) {
  const config = validate(value);
  const serialized = JSON.stringify(config) + "\n";
  if (Buffer.byteLength(serialized) > limit) throw new ConnectionError("invalid_config");
  let fd;
  try {
    if (typeof directory !== "string" || !directory.trim()) throw new ConnectionError("invalid_config");
    const path = resolve(directory);
    mkdirSync(path, { mode: 0o700 });
    privateStat(lstatSync(path), true);
    fd = openSync(join(realpathSync(path), filename), "wx", 0o600);
    privateStat(fstatSync(fd));
    writeFileSync(fd, serialized); fsyncSync(fd);
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(error.code === "EEXIST" ? "config_exists" : "config_save_failed");
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Choose exactly one source, once per invocation. Never hot-reload credentials
// or mix one source's identity with another source's secret.
export function agentConnectionFromEnvironment(env = process.env) {
  if (env.ROOM_AGENT_CONFIG !== undefined) {
    if (variables.some(name => env[name] !== undefined)) throw new ConnectionError("ambiguous_config");
    return readAgentConnection(env.ROOM_AGENT_CONFIG);
  }
  const config = { origin: env.ROOM_AGENT_ORIGIN, roomId: env.ROOM_AGENT_ROOM, token: env.ROOM_AGENT_TOKEN,
    ...(env.ROOM_AGENT_MEMBER !== undefined ? { memberId: env.ROOM_AGENT_MEMBER } : {}) };
  try { new RoomAgentClient(config); } catch { throw new ConnectionError("invalid_config"); }
  return config; // Existing unpinned environment clients remain supported.
}

const messages = Object.freeze({
  usage_error: "Choose a documented command. Use --help.",
  invalid_config: "Check the service address, room, member and private key configuration.",
  config_not_found: "Saved connection not found. Choose its private directory.",
  config_not_private: "Use an owner-only local directory and regular private file, without links.",
  ambiguous_config: "Choose a saved connection OR environment credentials, not both.",
  config_exists: "That directory already exists. No existing connection was replaced.",
  config_save_failed: "Connection was not confirmed saved. Inspect the new private directory before retrying.",
  member_required: "Set the expected ROOM_AGENT_MEMBER before checking or saving agent access.",
  access_ended: "Access was not accepted. Ask the operator for the correct active agent key.",
  identity_mismatch: "Access does not match the configured room and agent. No identity was adopted.",
  expiry_unconfirmed: "Expiry could not be confirmed. Check the local clock and key expiry.",
  invalid_response: "Room returned an unsupported or incomplete response. No success was confirmed.",
  help_context_unavailable: "This service does not support explicit help discovery yet. Ordinary work reads remain available; missing invitations are not permission to act.",
  offer_context_unavailable: "This service does not support offer context yet. No fallback read or action was made; missing offers are not an empty queue or permission to act.",
  unavailable_route: "This address or deployment does not support the requested read, or the selected work is unavailable.",
  rate_limited: "Room asked you to wait before retrying.",
  request_timeout: "The request timed out. Check the service and retry.",
  cancelled: "The request was cancelled.",
  service_unavailable: "Could not complete the request. Check the service address and retry."
});
export function connectionDiagnostic(error) {
  let code = "service_unavailable";
  if (error instanceof ConnectionError && Object.hasOwn(messages, error.code)) code = error.code;
  else if (error instanceof RoomClientError) {
    code = error.status === 403 && ["host_denied", "origin_denied", "proxy_denied"].includes(error.code) ? "invalid_config"
      : [401, 403].includes(error.status) ? "access_ended" : error.status === 429 ? "rate_limited"
      : error.status === 404 ? "unavailable_route" : ["member_required", "identity_mismatch", "expiry_unconfirmed", "invalid_response", "help_context_unavailable", "offer_context_unavailable"].includes(error.code) ? error.code : code;
  } else if (error?.name === "TimeoutError") code = "request_timeout";
  else if (error?.name === "AbortError") code = "cancelled";
  return { type: "agent_connection_error", code, message: messages[code],
    ...(code === "rate_limited" && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 300000 ? { retryAfterMs: error.retryAfterMs } : {}) };
}
