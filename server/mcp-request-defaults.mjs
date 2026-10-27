import { API_KEY_PREFIX } from "./agent-api-keys.mjs";

export function pinnedRoomForApiKey(store, secret) {
  if (typeof secret !== "string" || !secret.startsWith(API_KEY_PREFIX)) return null;
  const record = store.agentPlugin.verifyPresentedApiKey(secret);
  if (!record) return null;
  const rooms = (record.scopes ?? []).filter(scope => scope.startsWith("mcp:room:"))
    .map(scope => scope.slice("mcp:room:".length));
  return rooms.length === 1 ? rooms[0] : null;
}

export function withDefaultRoomId(store, secret, name, args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args) || args.roomId !== undefined) return args;
  if (name === "room_check_access" || name === "room_create") return args;
  if (!schema?.properties || !Object.hasOwn(schema.properties, "roomId")) return args;
  if (name !== "room_needs_me" && !schema.required?.includes("roomId")) return args;
  const roomId = pinnedRoomForApiKey(store, secret);
  return roomId ? { ...args, roomId } : args;
}
