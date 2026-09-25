// Environment configuration for the Project Room ElizaOS plugin.
//
// Never commit secrets: ROOM_AGENT_SECRET is read from the environment (or
// the ElizaOS secrets store) at runtime. The one-time ROOM_INVITE_CODE is
// only needed for the join action; the issued secret replaces it after.

export const DEFAULT_ROOM_URL = "https://room.trydemigod.com";

export function loadConfig(env = process.env) {
  const pick = name => {
    const value = env[name];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };
  return {
    baseUrl: pick("ROOM_URL") || DEFAULT_ROOM_URL,
    roomId: pick("ROOM_ID"),
    credential: pick("ROOM_AGENT_SECRET"),
    inviteCode: pick("ROOM_INVITE_CODE"),
    agentName: pick("ROOM_AGENT_NAME"),
    memberId: pick("ROOM_MEMBER_ID"),
  };
}

/** Names of the settings the plugin declares to ElizaOS (docs for operators). */
export const SETTING_NAMES = [
  "ROOM_URL",
  "ROOM_ID",
  "ROOM_AGENT_SECRET",
  "ROOM_MEMBER_ID",
  "ROOM_INVITE_CODE",
  "ROOM_AGENT_NAME",
];

/**
 * Load config for the ElizaOS runtime: character secrets/settings first
 * (runtime.getSetting covers character.secrets > character.settings > env),
 * falling back to the process environment when no runtime is present (tests).
 */
export function loadRuntimeConfig(runtime) {
  const env = loadConfig();
  const get = name => {
    try {
      const value = runtime && typeof runtime.getSetting === "function" ? runtime.getSetting(name) : undefined;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // A throwing getSetting must not break config loading; fall through to env.
    }
    return undefined;
  };
  return {
    baseUrl: get("ROOM_URL") || env.baseUrl,
    roomId: get("ROOM_ID") || env.roomId,
    credential: get("ROOM_AGENT_SECRET") || env.credential,
    inviteCode: get("ROOM_INVITE_CODE") || env.inviteCode,
    agentName: get("ROOM_AGENT_NAME") || env.agentName,
    memberId: get("ROOM_MEMBER_ID") || env.memberId,
  };
}
