// Self-wake (Amp-style "check again in 15 min").
//
// GET  /api/rooms/{roomId}/self-wake  the caller's next check: { nextCheckAt, label, note }
// POST /api/rooms/{roomId}/self-wake  { requestId, in, note? } schedules or moves it
//
// Rides the durable wake queue (server/wake-queue.mjs) under one queue key per
// member, so a new time replaces the old one instead of stacking wakes. The
// wake queue's own auth applies (guests cannot queue). Route-table row: the
// legacy chain only shrinks, so the route lives here.
import { SELF_WAKE_QUEUE_KEY, nextCheckLabel, parseWakeIn } from "../../src/self-wake.js";

const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function selfWakeView(store, current) {
  const wake = current.pending.find(w => w.queueKey === SELF_WAKE_QUEUE_KEY) ?? null;
  return { roomId: current.roomId, memberId: current.memberId, nextCheckAt: wake?.dueAt ?? null,
    label: wake ? nextCheckLabel(wake.dueAt, store.now()) : null, note: wake?.intent?.note ?? null };
}

function context(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (write) {
    if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    }
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  return { roomId, selected, fence };
}

export async function readSelfWake(ctx) {
  const { roomId, selected, fence } = context(ctx, false);
  return ctx.json(ctx.res, 200, selfWakeView(ctx.store, ctx.store.wakeQueue.list(selected.token, roomId, fence)));
}

export async function scheduleSelfWake(ctx) {
  const { roomId, selected, fence } = context(ctx, true);
  const data = await ctx.body(ctx.req);
  if (!exact(data, Object.hasOwn(data ?? {}, "note") ? ["requestId", "in", "note"] : ["requestId", "in"])) ctx.reject(422, "invalid_self_wake", "Supply requestId, in (for example 15m) and optional note");
  const ms = parseWakeIn(data.in);
  if (ms === null) ctx.reject(422, "invalid_self_wake", "in must be a duration up to 7 days, for example 15m or 2h");
  if (data.note !== undefined && data.note !== null && (typeof data.note !== "string" || data.note.length > 200)) ctx.reject(422, "invalid_self_wake", "note is at most 200 characters");
  const { store } = ctx;
  const current = store.wakeQueue.list(selected.token, roomId, fence);
  // One pending row per member: close the earlier one (unless this is a retry
  // of the same request) so the queue's coalescing cannot keep its time.
  const retry = typeof data.requestId === "string" && store.db.prepare("SELECT 1 FROM wake_queue_commands WHERE room_id=? AND member_id=? AND request_id=?")
    .get(roomId, current.memberId, data.requestId);
  if (!retry) store.db.prepare("UPDATE wake_queue SET state='done',updated_at=? WHERE room_id=? AND member_id=? AND queue_key=? AND state='pending'")
    .run(store.now(), roomId, current.memberId, SELF_WAKE_QUEUE_KEY);
  store.wakeQueue.enqueue(selected.token, roomId, { requestId: data.requestId, queueKey: SELF_WAKE_QUEUE_KEY,
    intent: { kind: "self-wake", note: data.note ?? null }, dueAt: store.now() + ms, maxAttempts: 1 }, fence);
  return ctx.json(ctx.res, 201, selfWakeView(store, store.wakeQueue.list(selected.token, roomId, fence)));
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });

export const SELF_WAKE_ROUTES = Object.freeze([
  Object.freeze({ id: "self-wake-read", method: "GET", path: "/api/rooms/{roomId}/self-wake",
    auth: "room", capability: null, scope: "room", handler: readSelfWake, parity: "exempt:CLI-first (room wake-me); an MCP tool can follow once the room view lands",
    schema: { params: parameters, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "self-wake-schedule", method: "POST", path: "/api/rooms/{roomId}/self-wake",
    auth: "room", capability: null, scope: "room", handler: scheduleSelfWake, parity: "exempt:CLI-first (room wake-me); an MCP tool can follow once the room view lands",
    schema: { params: parameters, response: { type: "object" } }, events: [] }),
]);
