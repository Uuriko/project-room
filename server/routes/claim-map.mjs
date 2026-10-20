// Dibs read side (Room Everywhere D1/R1): two read-only views over the
// room's work claims, for agents that check before they write.
//   GET /api/rooms/{roomId}/claim-map   path -> live lease holder
//   GET /api/rooms/{roomId}/work-ready  unclaimed work with no open deps
// Both reuse the work-claims room read guard and the claims registry; they
// never write. Route-table rows (batch RT), not the legacy chain.
import { isLeaseExpired } from "../work-claims.mjs";
import { authenticateRoomRead } from "./room-read-guard.mjs";

const LIVE_STATES = new Set(["claimed", "in_progress", "blocked", "delivered"]);
const TERMINAL = new Set(["done", "closed"]);
const MAX_READY = 100;

const timeOf = now => (typeof now === "number" ? now : Date.parse(now));

export function buildClaimMap(items, now) {
  const paths = {};
  const claims = [];
  for (const item of items) {
    if (!item || !LIVE_STATES.has(item.state) || !item.owner) continue;
    if (item.leaseExpiresAt && isLeaseExpired(item, timeOf(now))) continue;
    const files = Array.isArray(item.files) ? item.files : [];
    claims.push({ claimId: item.id, title: item.title ?? null, owner: item.owner, state: item.state,
      leaseExpiresAt: item.leaseExpiresAt ?? null, files });
    for (const path of files) {
      (paths[path] ??= []).push({ claimId: item.id, owner: item.owner, leaseExpiresAt: item.leaseExpiresAt ?? null });
    }
  }
  return { schema: "project-room-claim-map/1", paths, claims };
}

export function buildWorkReady(items, limit = MAX_READY) {
  const byId = new Map(items.filter(Boolean).map(item => [item.id, item]));
  const ready = [];
  for (const item of items) {
    if (!item || item.state !== "unclaimed") continue;
    const deps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
    const open = deps.filter(id => !TERMINAL.has(byId.get(id)?.state));
    if (open.length) continue;
    ready.push({ claimId: item.id, title: item.title ?? null, files: Array.isArray(item.files) ? item.files : [],
      tags: Array.isArray(item.tags) ? item.tags : [], dependsOn: deps });
    if (ready.length >= limit) break;
  }
  return { schema: "project-room-work-ready/1", ready };
}

function claimsFor(ctx) {
  const { roomId } = authenticateRoomRead(ctx);
  const items = ctx.store.workClaims.list(roomId);
  return Array.isArray(items) ? items : [];
}

export async function getClaimMap(ctx) {
  const now = typeof ctx.store.now === "function" ? ctx.store.now() : Date.now();
  return ctx.json(ctx.res, 200, buildClaimMap(claimsFor(ctx), now));
}

export async function getWorkReady(ctx) {
  return ctx.json(ctx.res, 200, buildWorkReady(claimsFor(ctx)));
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });

export const CLAIM_MAP_ROUTES = Object.freeze([
  Object.freeze({ id: "claim-map", method: "GET", path: "/api/rooms/{roomId}/claim-map",
    auth: "room", capability: null, scope: "room", handler: getClaimMap,
    parity: "exempt:read-only view derived from room_list_work_claims records, keyed by file path for pre-write checks",
    schema: { params: parameters, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "work-ready", method: "GET", path: "/api/rooms/{roomId}/work-ready",
    auth: "room", capability: null, scope: "room", handler: getWorkReady,
    parity: "exempt:read-only view derived from room_list_work_claims records, unclaimed items whose dependencies are done",
    schema: { params: parameters, response: { type: "object" } }, events: [] }),
]);
