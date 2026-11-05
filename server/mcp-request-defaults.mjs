import { isIdentitySecret } from "./agent-identities.mjs";
import { PUBLIC_LOBBY_ROOM_ID } from "./current-public-face.mjs";
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
  // A destination-free join means the published welcome lobby, never a private
  // maintainer room. Explicit invitations, pairing and scoped grants keep their paths.
  if (name === "room_join" && isIdentitySecret(secret)
    && ["linkToken", "inviteCode", "pairId", "publicKey", "keyProof"].every(key => args[key] === undefined))
    return { ...args, roomId: PUBLIC_LOBBY_ROOM_ID };
  if (name === "room_check_access" || name === "room_create") return args;
  if (!schema?.properties || !Object.hasOwn(schema.properties, "roomId")) return args;
  if (name !== "room_needs_me" && !schema.required?.includes("roomId")) return args;
  const roomId = pinnedRoomForApiKey(store, secret);
  return roomId ? { ...args, roomId } : args;
}
