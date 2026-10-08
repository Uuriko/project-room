// Shared limits and the tool allowlist from machine/PROTOCOL.md.
// Names outside that list are not forwarded. There is no host shell.

export const PROTOCOL_VERSION = 1;
export const MCP_PROTOCOL = "2025-11-25";
export const MCP_PROTOCOLS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);
export const MAX_CALL_BYTES = 1_048_576;
export const MAX_RESULT_BYTES = 4_194_304;
export const MAX_SMALL_BYTES = 65_536;
export const ENROLL_TTL_MS = 15 * 60 * 1000;
export const LEASE_TOKEN_TTL_MS = 15 * 60 * 1000;
export const IDENTITY_CACHE_MS = 5 * 60 * 1000;
export const LOCK_CACHE_MAX_MS = 30 * 1000;
export const CALL_TIMEOUT_MS = 30_000;
export const HEARTBEAT_MS = 30_000;
export const HMAC_SKEW_SEC = 300;
export const SERVER_NAME = "project-room-relay";
export const SERVER_VERSION = "0.1.0";
export const ACTIVE_STATES = new Set(["claimed", "in_progress", "blocked"]);
export const DAEMON_SLOTS = Object.freeze(["desk", "scratch"]);

export const DEFAULT_ALLOW = Object.freeze([
  "machine.status",
  "machine.release",
  "desktop.screenshot",
  "desktop.click",
  "desktop.type",
  "desktop.key",
  "desktop.scroll",
  "desktop.list_apps",
  "shell.vm",
  "files.put",
  "files.get",
  "inference.chat",
]);

const MACHINE_ID = /^mch_[0-9a-f]{16}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INVITE_CODE = /^RM-(?:[0-9A-HJKMNP-TV-Z]{16}|[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})$/;

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

// A pause holds for a real duration only. The daemon ignores 0, negative and
// non-finite minutes (machine/lib/protocol.mjs pauseUntilFromMinutes), so the
// relay refuses them too rather than answering paused:true for a no-op.
export const MAX_PAUSE_MINUTES = 10_080;

export function isPauseMinutes(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAUSE_MINUTES;
}

export function isMachineId(value) {
  return typeof value === "string" && MACHINE_ID.test(value);
}

export function isSlot(value) {
  return typeof value === "string" && DAEMON_SLOTS.includes(value);
}

export function isInviteCode(value) {
  return typeof value === "string" && INVITE_CODE.test(value);
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

// An origin the daemon can join with `new URL(path, origin)`. No userinfo, path, query, or hash.
export function roomOriginOf(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function toolAllowed(name) {
  return typeof name === "string" && DEFAULT_ALLOW.includes(name);
}

export function listedTools() {
  return DEFAULT_ALLOW.map(name => ({
    name,
    description: "",
    inputSchema: { type: "object", properties: {} },
  }));
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

// The control frame a daemon must hear when it links. halt and pause are sent
// only to a linked daemon, so one issued while the machine was offline (asleep,
// rebooting) would otherwise never reach it: its bot and local tools check the
// daemon's own state. Only restrictive state is replayed; a resume issued while
// offline is not, so a daemon never resumes on the relay's say-so at link time.
export function controlFrameOnLink(state, now = Date.now()) {
  if (!state) return null;
  if (state.halted) return { type: "halt", epoch: state.haltEpoch };
  if (typeof state.pausedUntil === "number" && now < state.pausedUntil) {
    return { type: "pause", minutes: Math.max(1, Math.ceil((state.pausedUntil - now) / 60_000)) };
  }
  return null;
}
