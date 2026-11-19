import { MAC_CHECK_KINDS, validMacChecks } from "../src/mac-checks.js";
import { ownMember, validId } from "../src/events.js";

export const MAC_CAPABILITY_TTL_MS = 20_000;
const registry = new WeakMap();
const maxLeases = 256;
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const session = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const iso = value => new Date(value).toISOString();

export function reportMacCapability(store, roomId, memberId, input) {
  const fields = input?.state === "ready"
    ? ["sessionId", "state", "workItemId", "head", "base", "requesters", ...(Object.hasOwn(input, "checks") ? ["checks"] : [])]
    : ["sessionId", "state"];
  if (!input || Array.isArray(input) || Object.keys(input).length !== fields.length
    || !fields.every(field => Object.hasOwn(input, field)) || !session(input.sessionId)
    || !["ready", "unavailable", "stopped"].includes(input.state)
    || input.state === "ready" && (!validId(input.workItemId) || !sha(input.head) || !sha(input.base)
      || Object.hasOwn(input, "checks") && !validMacChecks(input.checks)
      || !Array.isArray(input.requesters) || input.requesters.length < 1 || input.requesters.length > 20
      || !input.requesters.every(validId) || new Set(input.requesters).size !== input.requesters.length)) {
    return { error: "invalid_mac_capability", status: 422 };
  }

  const now = new Date(store.now()).getTime();
  let leases = registry.get(store);
  if (!leases) registry.set(store, leases = new Map());
  for (const [key, lease] of leases) if (lease.expiresAt <= now) leases.delete(key);
  const key = JSON.stringify([roomId, memberId]), prior = leases.get(key);
  if (prior && ((prior.sessionId !== input.sessionId && prior.state !== "stopped")
    || (prior.sessionId === input.sessionId && prior.state === "stopped" && input.state !== "stopped"))) {
    return { error: "mac_capability_session_changed", status: 409 };
  }
  if (input.state === "ready" && prior?.sessionId === input.sessionId
    && ["workItemId", "head", "base", "requesters", "checks"].some(key => JSON.stringify(prior[key]) !== JSON.stringify(input[key]))) {
    return { error: "mac_capability_binding_changed", status: 409 };
  }
  if (input.state !== "ready" && prior?.sessionId !== input.sessionId) return { state: input.state };
  if (!prior && leases.size >= maxLeases) return { error: "mac_capability_capacity", status: 429 };

  const expiresAt = now + MAC_CAPABILITY_TTL_MS;
  leases.set(key, { ...(prior?.sessionId === input.sessionId ? prior : {}), ...input, roomId, memberId, observedAt: now, expiresAt });
  return { state: input.state, ...(input.state === "ready" ? { expiresAt: iso(expiresAt) } : {}) };
}

export function readMacCapabilities(store, { roomId, viewerId, members, items, now }) {
  const leases = registry.get(store);
  if (!leases) return [];
  const time = new Date(now).getTime();
  const visibleWork = new Set(items.filter(item => item.title != null && item.state !== "superseded" && !item.supersededBy).map(item => item.id));
  return [...leases.values()].filter(lease => {
    if (lease.roomId !== roomId || lease.state !== "ready" || lease.expiresAt <= time
      || !lease.requesters.includes(viewerId) || !visibleWork.has(lease.workItemId)) return false;
    const member = ownMember(members, lease.memberId);
    return member?.kind === "agent" && member.active === true;
  }).flatMap(({ sessionId, memberId, workItemId, head, base, observedAt, expiresAt, checks = ["affected"] }) =>
    checks.map(check => ({
      kind: MAC_CHECK_KINDS[check], state: "ready", source: "runner_report",
      capabilityId: check === "affected" ? sessionId : `${sessionId}-${check}`,
      head, base, observedAt: iso(observedAt), expiresAt: iso(expiresAt),
      request: { tool: "room_request_reply", arguments: { roomId, toMemberId: memberId, workItemId, body: `mac ${check} ${head}` } }
    }))).slice(0, 3);
}
