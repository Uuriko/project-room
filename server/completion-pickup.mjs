import { createHash } from "node:crypto";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { atomicPrivateJson, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";
import { listRoomWork } from "./mcp-room-profile.mjs";
import { capacityHandoff, capacityWorkHandoff, compileCapacityHandoff, compileCapacityWork, compileIdleRefill, idleRefill, investigation } from "./completion-capacity.mjs";

const pickupRetryDelaysMs = [1000, 2000, 4000, 8000, 16000, 32000];
const routeKey = ({ roomId, requesterId, recipientId, workItemId }) =>
  JSON.stringify([roomId, requesterId, recipientId, workItemId]);

function compileContinuation(route) {
  if (route.continuation === undefined) return null;
  const { seedRequestId, steps } = route.continuation ?? {};
  if (!validId(seedRequestId) || !Array.isArray(steps) || !steps.length || steps.length > 32)
    throw Error("Invalid completion continuation");
  const { roomId, requesterId, recipientId, workItemId, firstLine = `@(${route.recipientId})` } = route;
  const command = (requestId, body) => buildReplyCommand({ roomId, memberId: requesterId }, "room_request_reply", {
    requestId, workItemId, toMemberId: recipientId, body,
  });
  const seed = command(seedRequestId, firstLine);
  const ids = new Set([seedRequestId]);
  const requests = [{ command: seed }];
  for (const { requestId, body, afterOutcome = "answered" } of steps) {
    if (!validId(requestId) || ids.has(requestId) || typeof body !== "string" || !body.trim()
        || !["answered", "declined"].includes(afterOutcome))
      throw Error("Invalid completion continuation step");
    ids.add(requestId);
    requests.push({ command: command(requestId, `${firstLine}\n${body.trim()}`), afterOutcome });
  }
  return { requests, position: 0 };
}

function recipientHasOpenRequest(store, secret, { roomId, recipientId }, includeStale = false) {
  let cursor;
  do {
    const open = store.replyRequests.list(secret, roomId, { direction: "outgoing", status: "open", states: true,
      ...(cursor ? { cursor } : {}),
    });
    // Staleness measures time since progress. An acknowledged request may
    // still be executing, even when the receiver has stopped reporting.
    if (open.requests.some(item => item.recipientId === recipientId &&
        (includeStale || item.lifecycle?.state !== "stale" || item.lifecycle.unresponsive !== true))) return true;
    if (!open.page?.hasMore) return false;
    if (!open.page.nextCursor || open.page.nextCursor === cursor) return true;
    cursor = open.page.nextCursor;
  } while (cursor);
}

function advanceContinuation(store, { route, secret, continuation }, receiverServer) {
  const { roomId, requesterId, recipientId, workItemId, after } = route;
  const { requests } = continuation;
  if (continuation.position >= requests.length - 1 || store.wakeQueue.pauseStatus(roomId, recipientId)) return;
  if (store.authenticate(secret, roomId).member.id !== requesterId) throw Error("Pickup requester identity changed");
  // Recover the current step from Room's receipts, including a write that
  // committed just before the subscriber stopped. A changed plan must use new IDs.
  while (continuation.position < requests.length - 1) {
    const current = requests[continuation.position].command;
    const { command: next, afterOutcome } = requests[continuation.position + 1];
    const receipt = store.operationReceipt(secret, roomId, current.id);
    if (receipt.status !== "recorded" || receipt.sequence <= after || receipt.eventType !== "message.posted") return;
    const { request, page } = store.replyRequests.selected(secret, roomId, current.data.messageId, { view: "compact" });
    if (request.requesterId !== requesterId || request.recipientId !== recipientId || request.workItemId !== workItemId
        || request.openingEventId !== receipt.eventId || request.status !== afterOutcome
        || request.terminalActorId !== recipientId) return;
    const openingBody = page.items.find(item => item.kind === "opened")?.message?.body;
    if (continuation.position > 0 && openingBody !== current.data.body) return;
    if (afterOutcome === "answered" && request.contextEventId !== request.openingEventId) return;

    if (store.operationReceipt(secret, roomId, next.id).status === "recorded") {
      continuation.position++;
      continue;
    }
    if (afterOutcome === "declined") {
      const decline = page.items.find(item => item.kind === "declined");
      if (!decline || !openingBody || openingBody.trim() === next.data.body
          || !receiverServer?.hasRecoveryReceiver({ roomId, recipientId, requesterId, workItemId,
            id: next.data.messageId }, decline.sequence, route.allowUnadvertisedReceiver === true)) return;
    }
    if (recipientHasOpenRequest(store, secret, route)) return;
    try {
      const result = store.command(secret, roomId, next);
      continuation.position++;
      return result.duplicate ? undefined : result.sequence;
    } catch (error) {
      if (error.code === "assignment_paused" || error.code === "assignment_waiting_for_recipient") return;
      throw error;
    }
  }
}

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
  try {
    return store.command(secret, roomId, command).duplicate ? "replayed" : "posted";
  } catch (error) {
    if (error.code === "assignment_paused" || error.code === "assignment_waiting_for_recipient") return "recipient_unavailable";
    throw error;
  }
}

function readCompletionPickupPlan(store, configPath) {
  const config = readPrivateJson(configPath);
  const { routes, checkpointPath } = config;
  if (!Array.isArray(routes) || !routes.length || routes.length > 50 || typeof checkpointPath !== "string")
    throw Error("Invalid completion pickup configuration");
  const bindings = new Map();
  for (const route of routes) {
    const { roomId, requesterId, recipientId, workItemId, credentialPath, after, firstLine } = route;
    if (![roomId, requesterId, recipientId, workItemId].every(validId) || requesterId === recipientId
        || typeof credentialPath !== "string" || !Number.isSafeInteger(after) || after < 0
        || route.allowUnadvertisedReceiver !== undefined && typeof route.allowUnadvertisedReceiver !== "boolean"
        || firstLine !== undefined && (typeof firstLine !== "string" || !firstLine.length || firstLine.length > 120
          || firstLine.trim() !== firstLine || /[\r\n\u2028\u2029]/.test(firstLine))
        || route.capacityHandoff !== undefined && route.capacityWork !== undefined
        || bindings.has(routeKey(route))) throw Error("Invalid completion pickup route");
    const credential = readPrivateJson(credentialPath);
    const secret = credential.identitySecret ?? credential.token;
    if (store.authenticate(secret, roomId).member.id !== requesterId) throw Error("Invalid completion pickup requester");
    bindings.set(routeKey(route), {
      route, secret, continuation: compileContinuation(route), capacity: compileCapacityHandoff(route),
      refill: compileIdleRefill(route), workHandoff: compileCapacityWork(route),
      hasOpenRequest: selection => recipientHasOpenRequest(store, secret, selection, true)
    });
  }
  const configDigest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return { bindings, checkpointPath, configDigest };
}

// A declined step waits for a fresh scoped receiver connection. The SQLite
// operation receipt owns deduplication for both settlement paths.
function subscribeCompletionPickup(store, { bindings, checkpointPath }, log, receiverServer) {
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
  const retries = new Map();
  let stopped = false;
  function clearRetry(scope) {
    clearTimeout(retries.get(scope)?.timer);
    retries.delete(scope);
  }
  function defer(scope, roomId, error) {
    log(JSON.stringify({ event: "completion_pickup.deferred", roomId, code: error.code ?? "pickup_failed" }));
    const retry = retries.get(scope) ?? { timer: null, attempts: 0 };
    if (retry.timer || retry.attempts >= pickupRetryDelaysMs.length) return;
    // Track scan and continuation failures separately. An otherwise quiet
    // room may never emit another wake, even for an unrelated healthy lane.
    retry.timer = setTimeout(() => {
      retry.timer = null;
      wake(roomId);
    }, pickupRetryDelaysMs[retry.attempts++]);
    retry.timer.unref();
    retries.set(scope, retry);
  }
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
          if (binding && !binding.continuation && row.sequence > binding.route.after) {
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
        clearRetry(roomId);
        if (rows.length === 64) wake(roomId);
      } catch (error) {
        defer(roomId, roomId, error);
      }
      for (const binding of bindings.values()) {
        if (binding.route.roomId !== roomId || !binding.continuation && !binding.capacity && !binding.refill && !binding.workHandoff) continue;
        try {
          if (binding.capacity || binding.workHandoff) {
            const decision = binding.capacity ? capacityHandoff(store, binding, receiverServer) : capacityWorkHandoff(store, binding, receiverServer);
            if (decision.state !== binding.capacityState || decision.opening !== undefined) {
              log(JSON.stringify({ event: "completion_pickup.capacity", roomId, memberId: binding.route.recipientId, ...decision }));
              binding.capacityState = decision.state;
            }
          }
          const opening = binding.continuation && advanceContinuation(store, binding, receiverServer);
          if (binding.refill) {
            const refill = idleRefill(store, binding, receiverServer);
            if (refill.state !== binding.refillState || refill.opening !== undefined) {
              log(JSON.stringify({ event: "completion_pickup.refill", roomId, memberId: binding.route.recipientId, ...refill }));
              binding.refillState = refill.state;
            }
          }
          if (typeof opening === "number") log(JSON.stringify({ event: "completion_pickup.continued", roomId, opening }));
          clearRetry(binding);
        } catch (error) {
          defer(binding, roomId, error);
        }
      }
    });
  }
  const unsubscribe = store.onEventAppended(wake);
  receiverServer?.on("agentReceiverConnected", wake);
  receiverServer?.on("agentReceiverDisconnected", wake);
  receiverServer?.on("agentCapacityChanged", wake);
  for (const roomId of rooms.keys()) wake(roomId);
  return () => {
    stopped = true;
    for (const scope of retries.keys()) clearRetry(scope);
    unsubscribe();
    receiverServer?.off("agentReceiverConnected", wake);
    receiverServer?.off("agentReceiverDisconnected", wake);
    receiverServer?.off("agentCapacityChanged", wake);
  };
}

export function startCompletionPickup(store, configPath, log = console.warn, receiverServer) {
  if (!configPath) return () => {};
  return subscribeCompletionPickup(store, readCompletionPickupPlan(store, configPath), log, receiverServer);
}

export function startReloadableCompletionPickup(store, configPath, log, receiverServer) {
  let plan = readCompletionPickupPlan(store, configPath);
  let stop = subscribeCompletionPickup(store, plan, log, receiverServer);
  const logPlan = event => log(JSON.stringify({ event, configDigest: plan.configDigest, routes: plan.bindings.size }));
  logPlan("completion_pickup.loaded");

  return {
    reload() {
      if (!stop) return;
      try {
        const candidate = readCompletionPickupPlan(store, configPath);
        if (candidate.checkpointPath !== plan.checkpointPath)
          throw Object.assign(new Error("Changing the completion checkpoint requires a restart"), { code: "checkpoint_path_changed" });
        // The new subscription only queues callbacks. Swap synchronously so
        // none of the old callbacks can run against the same checkpoint.
        const stopCandidate = subscribeCompletionPickup(store, candidate, log, receiverServer);
        stop();
        stop = stopCandidate;
        plan = candidate;
      } catch (error) {
        log(JSON.stringify({ event: "completion_pickup.reload_rejected", configDigest: plan.configDigest,
          code: error.code ?? "invalid_plan" }));
        return;
      }
      logPlan("completion_pickup.reloaded");
    },
    stop() {
      stop?.();
      stop = null;
    }
  };
}
