// Shared limits and the tool allowlist. The daemon may report extra tools;
// the relay only stores and serves names on this list. Host shell is absent
// on purpose: a contributed machine does not expose the owner's account.

export const PROTOCOL = "room-machine/0.1";
export const MCP_PROTOCOL = "2025-11-25";
export const MCP_PROTOCOLS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);
export const MAX_CALL_BYTES = 1_048_576;
export const MAX_SMALL_BYTES = 65_536;
export const ENROLL_TTL_MS = 15 * 60 * 1000;
export const LEASE_TOKEN_TTL_MS = 15 * 60 * 1000;
export const IDENTITY_CACHE_MS = 5 * 60 * 1000;
export const LOCK_CACHE_MAX_MS = 30 * 1000;
export const CALL_TIMEOUT_MS = 30_000;
export const HMAC_SKEW_SEC = 300;
export const SERVER_NAME = "project-room-relay";
export const SERVER_VERSION = "0.1.0";
export const ACTIVE_STATES = new Set(["claimed", "in_progress", "blocked"]);

const MACHINE_ID = /^mch_[0-9a-f]{16}$/;
const SLOT = /^[a-z][a-z0-9_-]{0,63}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ALLOWED_TOOLS = [
  /^desktop\.[a-z][a-z0-9_]*$/,
  /^shell\.vm(?:\.[a-z][a-z0-9_]*)?$/,
  /^files(?:\.[a-z][a-z0-9_]*)?$/,
  /^browser\.[a-z][a-z0-9_]*$/,
  /^xcode\.[a-z][a-z0-9_]*$/,
  /^inference\.[a-z][a-z0-9_]*$/,
  /^machine\.[a-z][a-z0-9_]*$/,
  /^credential\.use(?:\.[a-z][a-z0-9_]*)?$/,
];

const CAP_PATTERNS = new Map([
  ["desktop.gui", /^desktop\.[a-z][a-z0-9_]*$/],
  ["shell.vm", /^shell\.vm(?:\.[a-z][a-z0-9_]*)?$/],
  ["files", /^files(?:\.[a-z][a-z0-9_]*)?$/],
  ["browser.profile", /^browser\.[a-z][a-z0-9_]*$/],
  ["browser.cdp", /^browser\.[a-z][a-z0-9_]*$/],
  ["xcode.simulator", /^xcode\.[a-z][a-z0-9_]*$/],
  ["inference.chat", /^inference\.[a-z][a-z0-9_]*$/],
  ["credential.use", /^credential\.use(?:\.[a-z][a-z0-9_]*)?$/],
  ["machine.status", /^machine\.[a-z][a-z0-9_]*$/],
]);

export function passthroughEnabled(env) {
  return env?.RELAY_PHASE0_PASSTHROUGH === "1";
}

export function lockCacheMs(env) {
  const raw = env?.RELAY_LOCK_CACHE_MS;
  if (raw === undefined || raw === null || raw === "") return LOCK_CACHE_MAX_MS;
  if (!/^[0-9]+$/.test(String(raw))) return LOCK_CACHE_MAX_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return LOCK_CACHE_MAX_MS;
  return Math.min(LOCK_CACHE_MAX_MS, value);
}

export function isMachineId(value) {
  return typeof value === "string" && MACHINE_ID.test(value);
}

export function isSlot(value) {
  return typeof value === "string" && SLOT.test(value);
}

export function isRoomId(value) {
  return typeof value === "string" && ROOM_ID.test(value);
}

export function isMemberId(value) {
  return typeof value === "string" && MEMBER_ID.test(value);
}

export function isResourceId(value) {
  return typeof value === "string" && RESOURCE_ID.test(value);
}

export function isLabel(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function toolAllowed(name) {
  return typeof name === "string" && name.length <= 128 && ALLOWED_TOOLS.some(pattern => pattern.test(name));
}

export function capCovers(cap, tool) {
  if (typeof cap !== "string" || typeof tool !== "string") return false;
  if (tool === cap || tool.startsWith(`${cap}.`)) return true;
  const pattern = CAP_PATTERNS.get(cap);
  return pattern ? pattern.test(tool) : false;
}

export function capsCover(caps, tool) {
  return Array.isArray(caps) && caps.some(cap => capCovers(cap, tool));
}

export function filterTools(tools) {
  if (!Array.isArray(tools)) return [];
  const kept = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    if (!toolAllowed(tool.name)) continue;
    if (kept.some(item => item.name === tool.name)) continue;
    const description = typeof tool.description === "string" ? tool.description.slice(0, 512) : "";
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : { type: "object", properties: {} };
    kept.push({ name: tool.name, description, inputSchema });
    if (kept.length === 64) break;
  }
  return kept;
}

export function resourceLabel(machineId, slot) {
  return `resource/${machineId}/${slot}`;
}

export function missingSecrets(env) {
  const missing = [];
  if (!env?.RELAY_ADMIN_TOKEN) missing.push("RELAY_ADMIN_TOKEN");
  if (!env?.RELAY_LINK_SECRET) missing.push("RELAY_LINK_SECRET");
  if (!env?.ROOM_RESOURCE_LEASE_PUBLIC_JWK) missing.push("ROOM_RESOURCE_LEASE_PUBLIC_JWK");
  return missing;
}

export function challengeHeader(request, machineId) {
  const origin = new URL(request.url).origin;
  const metadata = `${origin}/.well-known/oauth-protected-resource/v0/machines/${machineId}/mcp`;
  return `Bearer realm="project-room-relay", resource_metadata="${metadata}", error="invalid_token"`;
}
