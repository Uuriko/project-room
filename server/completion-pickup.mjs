import { createHash } from "node:crypto";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { atomicPrivateJson, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";
import { listRoomWork } from "./mcp-room-profile.mjs";

const investigation = "Room investigation pass.";
const routeKey = ({ roomId, requesterId, recipientId, workItemId }) =>
  JSON.stringify([roomId, requesterId, recipientId, workItemId]);

export function dispatchCompletionPickup(store, route, secret, event, sequence) {
  const { roomId, requesterId, recipientId, workItemId, firstLine } = route;
  const requestMessageId = event.data?.responseToRequestId;
  if (event.type !== "message.posted" || event.actorId !== recipientId
      || event.data.responseOutcome !== "answered" || event.data.workItemId !== workItemId
      || !validId(requestMessageId)) return "unrelated";
  if (store.authenticate(secret, roomId).member.id !== requesterId) throw Error("Pickup requester identity changed");
  const exact = store.replyRequests.selected(secret, roomId, requestMessageId, { view: "compact" });
  const { request, page } = exact;
  if (request.requesterId !== requesterId || request.recipientId !== recipientId || request.workItemId !== workItemId
      || request.terminalEventId !== event.id || request.status !== "answered") return "not_current";
  const opened = page.items.find(item => item.kind === "opened");
  if (!opened?.message?.body || opened.message.body.includes(investigation)) return "no_successor";
  // Share the operation key with the supervised pickup to make migration and
  // replay of the same settlement harmless in either direction.
  const requestId = "investigate-" + createHash("sha256").update(roomId + "/" + event.id).digest("hex").slice(0, 32);
  if (store.operationReceipt(secret, roomId, requestId).status === "recorded") return "replayed";
  if (store.wakeQueue.pauseStatus(roomId, recipientId)) return "paused";
  const requests = store.replyRequests.list(secret, roomId, { direction: "outgoing", status: "open", states: true });
  if (requests.page?.hasMore || requests.requests.some(item => item.recipientId === recipientId
      && item.workItemId === workItemId && item.lifecycle?.state !== "stale")) return "ready_or_unknown";
  const offers = listRoomWork(store, secret, { roomId, focus: "help_wanted", limit: 1 });
  if (offers.selection?.available === false || offers.work.length || offers.page?.hasMore
      || offers.evaluatedThrough !== requests.evaluatedThrough) return "ready_or_unknown";
  const command = buildReplyCommand({ roomId, memberId: requesterId }, "room_request_reply", {
    requestId, workItemId, toMemberId: recipientId,
    body: [
      ...(firstLine === undefined ? [`@(${recipientId}) ${investigation}`] : [firstLine, investigation]),
      `The authorized QA request ${requestMessageId} settled at room sequence ${sequence}.`,
      "Check your actionable pickup first, excluding this request itself. If a different actionable assignment exists, report it and stop this investigation.",
      "Otherwise take one bounded evidence lead from pickup, or use your last result to investigate a distinct, currently observable problem within the same scope.",
      "Return your exact source or revision, one observed result, and one checkable next action with an intended recipient. A clean check is useful. Read-only QA; keep evidence within its authorized audience."
    ].join("\n")
  });
  return store.command(secret, roomId, command).duplicate ? "replayed" : "posted";
}

// The Node app owns this subscriber. The only trigger is a committed event
// (including catch-up on restart); the SQLite operation receipt owns deduplication.
export function startCompletionPickup(store, configPath, log = console.warn) {
  if (!configPath) return () => {};
  const { routes, checkpointPath } = readPrivateJson(configPath);
  if (!Array.isArray(routes) || !routes.length || routes.length > 50 || typeof checkpointPath !== "string")
    throw Error("Invalid completion pickup configuration");
  const bindings = new Map();
  for (const route of routes) {
    const { roomId, requesterId, recipientId, workItemId, credentialPath, after, firstLine } = route;
    if (![roomId, requesterId, recipientId, workItemId].every(validId) || requesterId === recipientId
        || typeof credentialPath !== "string" || !Number.isSafeInteger(after) || after < 0
        || firstLine !== undefined && (typeof firstLine !== "string" || !firstLine.length || firstLine.length > 120
          || firstLine.trim() !== firstLine || /[\r\n\u2028\u2029]/.test(firstLine))
        || bindings.has(routeKey(route))) throw Error("Invalid completion pickup route");
    const credential = readPrivateJson(credentialPath);
    const secret = credential.identitySecret ?? credential.token;
    if (store.authenticate(secret, roomId).member.id !== requesterId) throw Error("Invalid completion pickup requester");
    bindings.set(routeKey(route), { route, secret });
  }
  let checkpoints;
  try { checkpoints = readPrivateJson(checkpointPath); }
  catch (error) { if (error.code !== "ENOENT") throw error; checkpoints = {}; }
  const rooms = new Map();
  for (const { route } of bindings.values()) {
    const saved = checkpoints[route.roomId];
    const start = Number.isSafeInteger(saved) ? Math.max(route.after, saved) : route.after;
    rooms.set(route.roomId, Math.min(start, rooms.get(route.roomId) ?? start));
  }
  const pending = new Set();
  let stopped = false;
  function wake(roomId) {
    if (stopped || !rooms.has(roomId) || pending.has(roomId)) return;
    pending.add(roomId);
    setImmediate(() => {
      pending.delete(roomId);
      if (stopped) return;
      try {
        const rows = store.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 64")
          .all(roomId, rooms.get(roomId));
        for (const row of rows) {
          const event = JSON.parse(row.body);
          const { toMemberId, workItemId, responseOutcome } = event.data ?? {};
          if (event.type !== "message.posted" || responseOutcome !== "answered") continue;
          const binding = bindings.get(routeKey({ roomId, requesterId: toMemberId, recipientId: event.actorId, workItemId }));
          if (binding && row.sequence > binding.route.after) {
            const status = dispatchCompletionPickup(store, binding.route, binding.secret, event, row.sequence);
            if (status === "posted") log(JSON.stringify({ event: "completion_pickup.posted", roomId, settlement: row.sequence }));
          }
        }
        if (rows.length) {
          const through = rows.at(-1).sequence;
          const next = { ...checkpoints, [roomId]: through };
          atomicPrivateJson(checkpointPath, next);
          checkpoints = next;
          rooms.set(roomId, through);
        }
        if (rows.length === 64) wake(roomId);
      } catch (error) {
        log(JSON.stringify({ event: "completion_pickup.deferred", roomId, code: error.code ?? "pickup_failed" }));
      }
    });
  }
  const unsubscribe = store.onEventAppended(wake);
  for (const roomId of rooms.keys()) wake(roomId);
  return () => { stopped = true; unsubscribe(); };
}
