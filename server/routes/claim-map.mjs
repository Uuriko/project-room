// Dibs read side (Room Everywhere D1/R1): two read-only views over the
// room's work claims, for agents that check before they write.
//   GET /api/rooms/{roomId}/claim-map   path -> live lease holder
//   GET /api/rooms/{roomId}/work-ready  unclaimed work with no open deps
// Both reuse the work-claims room read guard and the claims registry; they
// never write. Route-table rows (batch RT), not the legacy chain.
import { isLeaseExpired } from "../work-claims.mjs";
import { readyClaims } from "../claim-coordination.mjs";
import { authenticateRoomRead } from "./room-read-guard.mjs";
import { markIfOther, withContentTrust } from "../content-trust.mjs";

const LIVE_STATES = new Set(["claimed", "in_progress", "blocked", "delivered"]);
const MAX_READY = 100;
// A room may hold up to 1000 open claims of up to 64 paths (512 chars each),
// so an unbounded map can run to megabytes. Cap the claims; claimsTotal says
// when the map was cut, and a cut map is not proof that a path is free.
export const MAX_MAP_CLAIMS = 200;

// Titles and paths are member-written. Mark them the way the work-claims list
// does (stampClaim in server/content-trust.mjs): the creator is the "created"
// history entry's agent, and a row whose creator is not the viewer, or is
// unknown, is untrusted data.
const creatorOf = item => {
  const history = Array.isArray(item.history) ? item.history : [];
  return history[0]?.action === "created" && !(item.historyOmitted > 0) ? history[0].agentId ?? null : null;
};
const mark = (row, item, viewerId) => markIfOther(row, viewerId, creatorOf(item));

const timeOf = now => (typeof now === "number" ? now : Date.parse(now));

export function buildClaimMap(items, now, { viewerId = null, limit = MAX_MAP_CLAIMS } = {}) {
  // A Map, not a plain object: a claimed path named "constructor",
  // "toString" or "__proto__" would otherwise resolve to an inherited
  // property and throw, failing the whole route for every member.
  const paths = new Map();
  const claims = [];
  let total = 0;
  for (const item of items) {
    if (!item || !LIVE_STATES.has(item.state) || !item.owner) continue;
    if (item.leaseExpiresAt && isLeaseExpired(item, timeOf(now))) continue;
    total += 1;
    if (claims.length >= limit) continue;
    const files = Array.isArray(item.files) ? item.files : [];
    claims.push(mark({ claimId: item.id, title: item.title ?? null, owner: item.owner, state: item.state,
      leaseExpiresAt: item.leaseExpiresAt ?? null, files }, item, viewerId));
    for (const path of files) {
      if (!paths.has(path)) paths.set(path, []);
      paths.get(path).push({ claimId: item.id, owner: item.owner, leaseExpiresAt: item.leaseExpiresAt ?? null });
    }
  }
  return withContentTrust({ schema: "project-room-claim-map/1", paths: Object.fromEntries(paths), claims,
    ...(total > claims.length ? { claimsTotal: total } : {}) });
}

export function buildWorkReady(items, limit = MAX_READY, { viewerId = null } = {}) {
  // Same rule as GET /work-claims-read?queue=ready (readyClaims): unheld and
  // every dependency done. A closed dependency was retired without delivery,
  // so it does not unblock its dependents (docs/WORK-CLAIMS.md "ready").
  const all = readyClaims(items);
  const ready = all.slice(0, limit).map(item => mark({ claimId: item.id, title: item.title ?? null,
    files: Array.isArray(item.files) ? item.files : [], tags: Array.isArray(item.tags) ? item.tags : [],
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [] }, item, viewerId));
  return withContentTrust({ schema: "project-room-work-ready/1", ready, ...(all.length > ready.length ? { readyTotal: all.length } : {}) });
}

function claimsFor(ctx) {
  const { roomId, auth } = authenticateRoomRead(ctx);
  const items = ctx.store.workClaims.list(roomId);
  return { items: Array.isArray(items) ? items : [], viewerId: auth.member.id };
}

export async function getClaimMap(ctx) {
  const now = typeof ctx.store.now === "function" ? ctx.store.now() : Date.now();
  const { items, viewerId } = claimsFor(ctx);
  return ctx.json(ctx.res, 200, buildClaimMap(items, now, { viewerId }));
}

export async function getWorkReady(ctx) {
  const { items, viewerId } = claimsFor(ctx);
  return ctx.json(ctx.res, 200, buildWorkReady(items, MAX_READY, { viewerId }));
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
