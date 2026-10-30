// Experimental route families stay mounted. The freeze is off unless
// ROOM_FREEZE_EXPERIMENTAL is "1" or "true", so the handlers keep running.
// When it is on, the request ends before the handler.

const EXPERIMENTAL_ROUTE = /\/(?:jev-shadow|matchmaking|spend-[a-z0-9-]+)(?:\/|$)/;

export function experimentalRoutesFrozen(env = globalThis.process?.env ?? {}) {
  const value = env?.ROOM_FREEZE_EXPERIMENTAL;
  return value === "1" || value === "true";
}

export function isExperimentalRoute(pathname) {
  return EXPERIMENTAL_ROUTE.test(String(pathname ?? ""));
}
