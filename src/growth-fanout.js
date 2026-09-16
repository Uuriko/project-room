// Track C slice C6 — Growth event fan-out.
//
// Local publish/subscribe over C1 growth-event envelopes. Analytics
// consumers (dashboards, alerts, downstream pipelines) subscribe with a
// type list or a predicate and receive every matching envelope that
// applyEventWithGrowth records.
//
// Pure and dependency-free apart from the C1 contract module used to
// validate envelopes at the door. No network, no storage, no timers.
//
// Failure isolation is the whole point of this module: a throwing
// subscriber handler is caught, counted via getHandlerFailures(), and never
// breaks the other subscribers or the notifier. Handlers receive the same
// frozen envelope reference the collector stored — envelopes from
// growth-events are frozen, so a handler cannot mutate them.

import { validateEvent } from "./growth-events.js";

const isValidEnvelope = envelope => {
  try {
    validateEvent(envelope);
    return true;
  } catch {
    return false;
  }
};

// Normalize a filter to a predicate. Accepts a predicate function or a
// { types: [...] } object whose types are non-empty growth event type
// strings. Throws a clear TypeError for anything else.
const normalizeFilter = filter => {
  if (typeof filter === "function") return filter;
  if (filter && typeof filter === "object" && !Array.isArray(filter)) {
    const { types } = filter;
    if (!Array.isArray(types) || types.length === 0) {
      throw new TypeError('filter object must carry a non-empty "types" array');
    }
    const wanted = new Set();
    for (const type of types) {
      if (typeof type !== "string" || !type) {
        throw new TypeError('filter "types" entries must be non-empty strings');
      }
      wanted.add(type);
    }
    return envelope => wanted.has(envelope?.type);
  }
  throw new TypeError("filter must be a predicate function or { types: [...] }");
};

// Create an independent fan-out hub.
export function createFanout() {
  let nextId = 1;
  const subscribers = new Map(); // subId -> { match, handler }
  let handlerFailures = 0;

  // Subscribe a handler. Returns a subscription id string. Throws a clear
  // Error when the handler is not a function or the filter is invalid.
  function subscribe(filter, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("handler must be a function");
    }
    const match = normalizeFilter(filter);
    const subId = `sub-${nextId}`;
    nextId += 1;
    subscribers.set(subId, { match, handler });
    return subId;
  }

  // Remove a subscription. Returns true when one existed, false otherwise.
  function unsubscribe(subId) {
    return subscribers.delete(subId);
  }

  // Number of live subscriptions.
  function subscriberCount() {
    return subscribers.size;
  }

  // Cumulative count of subscriber invocations that threw (filter or
  // handler), since creation.
  function getHandlerFailures() {
    return handlerFailures;
  }

  // Deliver a growth-event envelope to every matching subscriber. Returns
  // the number of handlers invoked. An invalid envelope is a no-op that
  // returns 0. A throwing filter or handler is caught, counted in
  // handlerFailures, and never breaks the remaining subscribers or the
  // caller. Handlers receive the same frozen envelope reference.
  function notify(envelope) {
    if (!isValidEnvelope(envelope)) return 0;
    let notified = 0;
    for (const { match, handler } of subscribers.values()) {
      try {
        if (!match(envelope)) continue;
      } catch {
        handlerFailures += 1;
        continue;
      }
      notified += 1;
      try {
        handler(envelope);
      } catch {
        handlerFailures += 1;
      }
    }
    return notified;
  }

  return Object.freeze({ subscribe, unsubscribe, subscriberCount, getHandlerFailures, notify });
}
