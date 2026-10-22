// Shared URL routing only: importing a client must not load server discovery.
export const ROOM_ORIGIN = "https://room.trydemigod.com";
export const EDGE_DOOR_HOSTS = Object.freeze(["getdasha.com", "www.getdasha.com"]);

// CLI origin cannot include a path (assertServiceOrigin). On the getdasha
// door hosts, /api/* is Webflow — the Worker only sees /room*. Prefix so
// ROOM_AGENT_ORIGIN set to https://www.getdasha.com hits /room/api/….
export function edgeDoorApiPath(origin, path) {
  if (typeof path !== "string") return path;
  if (path === "/room/api" || path.startsWith("/room/api/")) return path;
  if (path !== "/api" && !path.startsWith("/api/")) return path;
  try {
    if (EDGE_DOOR_HOSTS.includes(new URL(origin).hostname)) return `/room${path}`;
  } catch { /* caller already validated origin */ }
  return path;
}

