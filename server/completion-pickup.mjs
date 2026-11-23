import { createHash } from "node:crypto";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { atomicPrivateJson, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";
import { listRoomWork, mcpKeyGrantsScope } from "./mcp-room-profile.mjs";
import { readRoomNext } from "./room-next.mjs";

const investigation = "Room investigation pass.";
const CAPACITY_TTL_MS = 60000;
const routeKey = ({ roomId, requesterId, recipientId, workItemId }) =>
  JSON.stringify([roomId, requesterId, recipientId, workItemId]);
const pickupBody = ({ recipientId, firstLine }, body) =>
  firstLine === undefined ? `@(${recipientId}) ${body}` : `${firstLine}\n${body}`;

export function dispatchCompletionPickup(store, route, secret, event, sequence) {
  const { roomId, requesterId, recipientId, workItemId } = route;
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
    body: pickupBody(route, [
      investigation,
      `The authorized QA request ${requestMessageId} settled at room sequence ${sequence}.`,
      "Check your actionable pickup first, excluding this request itself. If a different actionable assignment exists, report it and stop this investigation.",
      "Otherwise take one bounded evidence lead from pickup, or use your last result to investigate a distinct, currently observable problem within the same scope.",
      "Return your exact source or revision, one observed result, and one checkable next action with an intended recipient. A clean check is useful. Read-only QA; keep evidence within its authorized audience."
    ].join("\n"))
  });
  return store.command(secret, roomId, command).duplicate ? "replayed" : "posted";
}

// Read through the idle agent's own authorization. The configured sender
// carries no selected task details across the two credential scopes.
function dispatchIdlePickup(store, route, senderSecret, receiverSecret, identityId, hostId, origin) {
  const { roomId, requesterId, recipientId, workItemId, after } = route;
  if (store.wakeQueue.pauseStatus(roomId, recipientId)) return "paused";
  const wake = store.agentHeartbeats.pendingWakePage(identityId, { roomId, hostId, limit: 1, observe: false });
  if (wake.signals.length || wake.more) return "wake_pending";
  const pickup = readRoomNext(store, receiverSecret, roomId, { view: "pickup" },
    () => listRoomWork(store, receiverSecret, { roomId, focus: "help_wanted", limit: 1 }),
    { discoveryOrigin: origin, allowPublicReview: true, allowInvestigation: mcpKeyGrantsScope(store, receiverSecret, "rooms:write") });
  if (pickup.requests?.items.length || pickup.nextRead?.tool === "room_read_request") return "request_pending";
  if (pickup.requests?.coverage !== "complete" || pickup.work?.coverage !== "complete") return "unknown";
  const addressed = pickup.work.items.find(item => item.reason === "revise") ?? pickup.work.items[0];
  const ready = addressed ? [addressed.id, addressed.revision, addressed.reason]
    : ["invitation", "public_review"].includes(pickup.ifIdle?.status) || pickup.ifIdle?.discoveryReview
      ? [pickup.ifIdle.status, pickup.ifIdle.nextRead ?? pickup.ifIdle.discoveryReview.nextRead] : null;
  if (ready) return postIdleRequest(store, route, senderSecret, [roomId, recipientId, ...ready], "ready",
    "Room found a next step for you. Read room_next and take the current authorized step. If it changed, use the current action or report the blocker.");

  const lead = pickup.ifIdle?.investigation;
  if (lead) return postIdleRequest(store, route, senderSecret, [roomId, lead.basis], "investigation", [
    investigation, "Use the current investigation in room_next. Check existing work first and follow the selected exact evidence.",
    "Record an observation and the smallest useful next step, or a scoped clean check. Keep restricted evidence within its original audience."
  ].join("\n"));
  if (!["no_invitation", "unavailable"].includes(pickup.ifIdle?.status)) return "unknown";

  const latest = store.db.prepare(`
    SELECT sequence,body FROM events WHERE room_id=? AND sequence>? AND
      json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.actorId')=? AND
      json_extract(body,'$.data.toMemberId')=? AND json_extract(body,'$.data.workItemId')=? AND
      json_extract(body,'$.data.responseOutcome')='answered'
    ORDER BY sequence DESC LIMIT 1`).get(roomId, after, recipientId, requesterId, workItemId);
  if (latest) {
    const result = dispatchCompletionPickup(store, route, senderSecret, JSON.parse(latest.body), latest.sequence);
    return result === "posted" ? "investigation_posted" : result;
  }
  return postIdleRequest(store, route, senderSecret, [roomId, workItemId, after], "investigation", [
    investigation, "Read room_next first. If there is ready work, take that current action.",
    "Otherwise inspect one piece of current evidence in this QA Work Thread. Look for a concrete gap, mismatch or unverified result.",
    "Return the exact evidence, what you checked, and one actionable next step if you found a problem. A clean check is useful. Read-only QA."
  ].join("\n"));
}

function postIdleRequest(store, route, secret, basis, kind, body) {
  const { roomId, requesterId, recipientId, workItemId } = route;
  const requestId = "idle-" + createHash("sha256").update(JSON.stringify([kind, ...basis])).digest("hex").slice(0, 32);
  if (store.operationReceipt(secret, roomId, requestId).status === "recorded") return "replayed";
  if (store.authenticate(secret, roomId).member.id !== requesterId) throw Error("Pickup requester identity changed");
  const command = buildReplyCommand({ roomId, memberId: requesterId }, "room_request_reply", {
    requestId, workItemId, toMemberId: recipientId, body: pickupBody(route, body)
  });
  return store.command(secret, roomId, command).duplicate ? "replayed" : kind + "_posted";
}

// The Node app owns this subscriber. The only trigger is a committed event
// (including catch-up on restart); the SQLite operation receipt owns deduplication.
export function startCompletionPickup(store, configPath, log = console.warn) {
  if (!configPath) return () => {};
  const { routes, checkpointPath } = readPrivateJson(configPath);
  if (!Array.isArray(routes) || !routes.length || routes.length > 50 || typeof checkpointPath !== "string")
    throw Error("Invalid completion pickup configuration");
  const bindings = new Map(), idleBindings = new Map();
  for (const route of routes) {
    const { roomId, requesterId, recipientId, workItemId, credentialPath, after, firstLine } = route;
    if (![roomId, requesterId, recipientId, workItemId].every(validId) || requesterId === recipientId
        || typeof credentialPath !== "string" || !Number.isSafeInteger(after) || after < 0
        || (route.onIdle !== undefined && typeof route.onIdle !== "boolean")
        || (firstLine !== undefined && (typeof firstLine !== "string" || !firstLine.length || firstLine.length > 120
          || firstLine.trim() !== firstLine || /[\r\n\u2028\u2029]/.test(firstLine)))
        || bindings.has(routeKey(route))) throw Error("Invalid completion pickup route");
    const credential = readPrivateJson(credentialPath);
    const secret = credential.identitySecret ?? credential.token;
    if (store.authenticate(secret, roomId).member.id !== requesterId) throw Error("Invalid completion pickup requester");
    const binding = { route, secret };
    bindings.set(routeKey(route), binding);
    if (route.onIdle) {
      const key = JSON.stringify([roomId, recipientId]);
      if (idleBindings.has(key)) throw Error("An idle agent needs one scoped pickup route per room");
      idleBindings.set(key, binding);
    }
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
          if (binding && !binding.route.onIdle && row.sequence > binding.route.after) {
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
  const idleBinding = (roomId, identityId) => {
    const link = store.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
    return idleBindings.get(JSON.stringify([roomId, link?.member_id]));
  };
  const observations = new Map();
  const idle = {
    supports: (roomId, identityId) => idleBindings.size > 0 && Boolean(idleBinding(roomId, identityId)),
    dispatch(roomId, identityId, receiverSecret, hostId, origin) {
      const binding = idleBinding(roomId, identityId);
      if (!binding) return "disabled";
      const { route, secret } = binding;
      return dispatchIdlePickup(store, route, secret, receiverSecret, identityId, hostId, origin);
    },
    observe(roomId, identityId, leaseToken, hostId, status, through) {
      const route = idleBinding(roomId, identityId)?.route;
      if (!route) return;
      const key = routeKey(route);
      observations.delete(key);
      if (["replayed", "no_successor"].includes(status)) {
        observations.set(key, { route, identityId, leaseToken, hostId, through, at:store.agentHeartbeats.now() });
      }
      return status === "paused" ? undefined : CAPACITY_TTL_MS / 2;
    },
    clearObservation(roomId, identityId) {
      const route = idleBinding(roomId, identityId)?.route;
      if (route) observations.delete(routeKey(route));
    },
    availablePeer(roomId, requesterId) {
      const now = store.agentHeartbeats.now();
      const through = store.headSequence(roomId);
      for (const sample of observations.values()) {
        const { route, identityId, leaseToken, hostId, at } = sample;
        if (route.roomId !== roomId || route.requesterId !== requesterId || sample.through !== through
          || now >= at + CAPACITY_TTL_MS || !idleBinding(roomId, identityId)
          || store.wakeQueue.pauseStatus(roomId, route.recipientId)) continue;
        const lease = store.db.prepare("SELECT fencing_token AS token, lease_expires_at AS expires FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?")
          .get(identityId, roomId);
        if (lease?.token !== leaseToken || lease.expires <= now) continue;
        const pending = store.agentHeartbeats.pendingWakePage(identityId, { roomId, hostId, limit:1, observe:false });
        if (pending.signals.length || pending.more) continue;
        return { memberId:route.recipientId, scope:"room_queue", status:"idle", observedAt:at,
          expiresAt:Math.min(lease.expires, at + CAPACITY_TTL_MS),
          nextRead:{ tool:"room_read_work", arguments:{ roomId, workItemId:route.workItemId } } };
      }
      return null;
    }
  };
  if (idleBindings.size) store.idlePickup = idle;
  return () => {
    stopped = true;
    unsubscribe();
    if (store.idlePickup === idle) delete store.idlePickup;
  };
}
