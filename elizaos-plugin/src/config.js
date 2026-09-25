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
  };
}

/** Names of the settings the plugin declares to ElizaOS (docs for operators). */
export const SETTING_NAMES = [
  "ROOM_URL",
  "ROOM_ID",
  "ROOM_AGENT_SECRET",
  "ROOM_INVITE_CODE",
  "ROOM_AGENT_NAME",
];
