import { ServiceError } from "./service-error.mjs";
import { ownMember, validId } from "../src/events.js";
const registries = new WeakMap(), TTL = 90000;
const fail = (status, code) => { throw new ServiceError(status, code, code.replaceAll("_", " ")); };
export function laptopWorkers(store, roomId, memberId, advertisement, now = Date.now()) {
  let registry = registries.get(store); if (!registry) { registry = new Map(); registries.set(store, registry); }
  const members = store.room(roomId).state.members;
  for (const [key, value] of registry) if (value.expiresAt <= now || (value.roomId === roomId && ownMember(members, value.memberId)?.active !== true)) registry.delete(key);
  if (advertisement !== undefined) {
    const a = advertisement;
    if (!a || a.version !== 1 || !["available", "working", "paused", "needs_attention"].includes(a.state)
      || !Number.isInteger(a.slots) || a.slots < 0 || a.slots > 64
      || !Number.isSafeInteger(a.maxInputBytes) || a.maxInputBytes < 1 || a.maxInputBytes > 64 * 1024 ** 3
      || !Array.isArray(a.requesters) || !a.requesters.length || a.requesters.length > 64 || a.requesters.some(id => !validId(id))
      || !Array.isArray(a.adapters) || a.adapters.length > 16 || a.adapters.some(value => !/^[a-z][a-z0-9-]{0,63}$/.test(value))
      || !Array.isArray(a.recipes) || a.recipes.length > 32 || a.recipes.some(value => !/^[a-z][a-z0-9-]{0,63}$/.test(value))) fail(422, "invalid_worker_advertisement");
    const key = JSON.stringify([roomId, memberId]);
    if (!registry.has(key) && registry.size >= 128) fail(429, "worker_directory_full");
    registry.set(key, { version: 1, roomId, memberId, state: a.state, slots: a.state === "available" ? a.slots : 0,
      maxInputBytes: a.maxInputBytes, adapters: [...a.adapters], recipes: [...a.recipes], requesters: [...a.requesters], observedAt: now, expiresAt: now + TTL });
  }
  return { version: 1, observedAt: now, workers: [...registry.values()].filter(item => item.roomId === roomId
    && (item.memberId === memberId || item.requesters.includes(memberId))).map(({ requesters: _requesters, ...rest }) => rest),
  boundary: "Host-reported capability, not a reservation. The laptop rechecks its local grant." };
}
