// supervision-client.js — triage data layer for the #pr-view/triage view.
//
// B7 VIEW INTERFACE (this file is the contract B7 builds on):
//
//   import { createSupervisionClient, reduceNav, snoozeUntil, ... } from "./supervision-client.js";
//
//   const supervision = createSupervisionClient({
//     roomId,                                            // room under triage
//     request: (path, opts) =>                           // full API path -> parsed JSON; throws on !ok
//       roomClient.request(path, { method: opts.method, data: opts.data, session }),
//     now: () => Date.now(),                             // injectable clock (tests)
//     schedule: (fn, ms) => setTimeout(fn, ms),          // injectable timers (tests)
//     cancelSchedule: (h) => clearTimeout(h),
//     undoWindowMs: 6000,                                // operator-configurable, clamped to 0–10000
//   });
//
//   await supervision.listCards({ includeSnoozed });      // GET .../supervision/cards
//   await supervision.focusCard(card);                    // focus-implies-seen: POSTs /seen once per card
//   await supervision.pick(cardId, 0 | 1);                // -> { card, hold, needsConfirm, commitPromise }
//   await supervision.retract(cardId);                    // cancel a pending undo (U / Esc)
//   await supervision.confirm(cardId, index);             // confirm-only actions: POST /confirm {confirm:true}
//   await supervision.dismiss(cardId, note?);             // -> dismissed (audit retained, never deleted)
//   await supervision.snooze(cardId, "1h"|"4h"|"tomorrow"|isoString);
//   await supervision.refetch(cardId);                    // re-read live state; may retire the card as stale
//   supervision.getHold(cardId);                          // { cardId, suggestionIndex, undoDeadline, remainingMs } | null
//   supervision.pendingHolds();                           // live holds, for the countdown UI
//
//   // Keyboard is pure: the view owns type-ahead safety (keys act only when the
//   // triage view has focus and no text field / sheet is open) and calls:
//   const { focusedId, intent } = reduceNav(focusedId, event.key, cards);
//   // intent: null | { type:"dismiss"|"pick"|"snooze"|"retract"|"refetch"|"open", cardId, suggestionIndex? }
//   //         | { type:"help" }
//
// ROUTE CONTRACT (coded against inbox-mapping.md §2.7; B6's server/supervision-routes.mjs
// implements the server side — this client only needs the paths and shapes below):
//
//   GET  /api/rooms/{roomId}/supervision/cards[?include=snoozed]   -> { cards: [...] } (priority-sorted)
//   POST /api/rooms/{roomId}/supervision/cards/{id}/seen          -> card
//   POST /api/rooms/{roomId}/supervision/cards/{id}/pick          -> { card, hold? } | { card, needsConfirm: true }
//        body { suggestionIndex: 0|1 }; hold = { cardId, suggestionIndex, undoDeadline,
//        confirmRequired?, dispatch: { method, path, body } | null }
//   POST /api/rooms/{roomId}/supervision/cards/{id}/retract       -> card (back to seen)
//   POST /api/rooms/{roomId}/supervision/cards/{id}/confirm       -> card (dispatched)
//        body { confirm: true, suggestionIndex }
//   POST /api/rooms/{roomId}/supervision/cards/{id}/dismiss       -> card (dismissed)
//        body { note? }
//   POST /api/rooms/{roomId}/supervision/cards/{id}/snooze        -> card (snoozed)
//        body { snoozedUntil: <ISO> }
//   POST /api/rooms/{roomId}/supervision/cards/{id}/refetch       -> card (may be stale)
//
// Card shape (server-owned; client treats it as opaque except id/state/kind):
//   { id, roomId, kind: review_request|blocked_lane|done_receipt|needs_input,
//     state: new|seen|acting|pending_undo|dispatched|resolved|dismissed|snoozed|stale,
//     title, summary, reason, sourceSeq, deepLink, urgency,
//     suggestions: [{ label, reason, gate: "retractable"|"confirm_only" }] }   // ≤2
//
// PRE-DISPATCH HOLD ("undo"), client-held v1 (inbox-mapping §2.3):
//   pick() journals the intent server-side (pending_undo + undoDeadline) but the room
//   write is NOT issued yet. This client arms a timer for the remaining window; on
//   lapse it fires the server-supplied dispatch write, then re-reads the card.
//   retract() (U / Esc / click) cancels the timer and POSTs /retract — nothing ever fired.
//   HONEST LIMITATION: the hold lives in this tab. If the tab closes mid-window the
//   intent never fires (safe default: inaction, journaled server-side by /pick).
//   Confirm-only actions (money, merges, deploys, membership changes) NEVER enter the
//   hold: pick() returns needsConfirm:true and the view must show the confirm sheet.
//
// Naming: supervision-* / card terminology throughout. The existing inbox-* names
// (src/inbox-ui.js, server/inbox-triage.mjs) are a different concept and are untouched.

export const CARD_KINDS = Object.freeze(["review_request", "blocked_lane", "done_receipt", "needs_input"]);
export const CARD_STATES = Object.freeze([
  "new", "seen", "acting", "pending_undo", "dispatched", "resolved", "dismissed", "snoozed", "stale",
]);
export const SNOOZE_PRESETS = Object.freeze(["1h", "4h", "tomorrow"]);
export const DEFAULT_UNDO_WINDOW_MS = 6000;
export const MAX_UNDO_WINDOW_MS = 10000; // operator-configurable 0–10s per inbox-mapping §2.3

// Key map (inbox-mapping §2.2). The view gates these on triage-view focus.
export const KEY_BINDINGS = Object.freeze({
  j: "focus next card",
  k: "focus previous card",
  ArrowDown: "focus next card",
  ArrowUp: "focus previous card",
  e: "dismiss focused card",
  Enter: "open focused card thread",
  o: "open focused card thread",
  1: "pick suggestion 1",
  2: "pick suggestion 2",
  s: "snooze focused card",
  u: "retract pending undo",
  Escape: "retract pending undo",
  r: "re-fetch focused card",
  "?": "help",
});

const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function assertCardId(cardId) {
  if (typeof cardId !== "string" || !CARD_ID_RE.test(cardId)) throw new Error(`invalid card id: ${String(cardId)}`);
}

// ---------------------------------------------------------------------------
// pure: undo window + hold timer semantics
// ---------------------------------------------------------------------------

export function clampUndoWindowMs(windowMs) {
  if (!Number.isFinite(windowMs)) return DEFAULT_UNDO_WINDOW_MS;
  return Math.min(MAX_UNDO_WINDOW_MS, Math.max(0, windowMs));
}

// Absolute deadline (ms epoch) for a freshly picked suggestion.
export function resolveUndoDeadline(windowMs, nowMs) {
  return nowMs + clampUndoWindowMs(windowMs);
}

export function holdExpired(undoDeadline, nowMs) {
  return nowMs >= undoDeadline;
}

export function holdRemainingMs(undoDeadline, nowMs) {
  return Math.max(0, undoDeadline - nowMs);
}

// ---------------------------------------------------------------------------
// pure: snooze presets -> ISO deadline
// ---------------------------------------------------------------------------

export function snoozeUntil(preset, nowMs = Date.now()) {
  if (preset === "1h" || preset === "4h") return new Date(nowMs + (preset === "1h" ? 1 : 4) * 3600_000).toISOString();
  if (preset === "tomorrow") {
    const d = new Date(nowMs);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0); // 09:00 operator-local next day
    return d.toISOString();
  }
  // Custom: any well-formed ISO timestamp passes through; the server validates it.
  if (typeof preset === "string" && preset.length <= 64 && Number.isFinite(Date.parse(preset))) {
    return new Date(Date.parse(preset)).toISOString();
  }
  throw new Error(`unknown snooze preset: ${String(preset)}`);
}

// ---------------------------------------------------------------------------
// pure: suggestion gate badge + focus-implies-seen predicate
// ---------------------------------------------------------------------------

// Every suggestion carries its badge before the pick: retractable (↩ N s to take
// back) vs confirm_only (⚠ confirm — cannot be undone). Money, merges, deploys
// and membership/permission changes are always confirm_only.
export function isConfirmOnly(suggestion) {
  return suggestion?.gate === "confirm_only";
}

export function shouldMarkSeen(card) {
  return card?.state === "new";
}

// ---------------------------------------------------------------------------
// pure: client-side mirror of the server card state machine (axis A)
// ---------------------------------------------------------------------------

const CARD_TRANSITIONS = {
  new: { seen: "seen", dismiss: "dismissed", snooze: "snoozed", stale: "stale" },
  seen: { open: "acting", pick: "pending_undo", dismiss: "dismissed", snooze: "snoozed", stale: "stale" },
  acting: { pick: "pending_undo", seen: "seen", dismiss: "dismissed", snooze: "snoozed", stale: "stale" },
  pending_undo: { retract: "seen", dispatch: "dispatched", dismiss: "dismissed", snooze: "snoozed", stale: "stale" },
  dispatched: { resolve: "resolved", stale: "stale" },
  snoozed: { wake: "seen", stale: "stale" },
  dismissed: { stale: "stale" },
  stale: { stale: "stale" },
  resolved: { stale: "stale" },
};

// Optimistic local transition; the server remains authoritative (refetch after writes).
// Throws on illegal transitions so the view can never render an impossible state.
export function transitionCard(card, event) {
  const next = CARD_TRANSITIONS[card?.state]?.[event];
  if (!next) throw new Error(`illegal transition: ${card?.state} + ${event}`);
  return { ...card, state: next };
}

// ---------------------------------------------------------------------------
// pure: J/K/E keyboard nav state machine
// ---------------------------------------------------------------------------
//
// reduceNav(focusedId, key, cards) -> { focusedId, intent }
//   - focus is keyed by card id, so inserts/removals never steal focus
//   - j/k clamp at the ends (no wrap); ArrowDown/ArrowUp are aliases
//   - a stale focusedId re-anchors to the first card and consumes the keypress
//     (no intent) — safer than acting on the wrong card
//   - intent is null for navigation; otherwise { type, cardId, ... }
//   - the caller owns type-ahead safety: call only when the triage view has
//     focus and no text field / sheet is open. Focus is local, never synced.
export function reduceNav(focusedId, key, cards) {
  const list = Array.isArray(cards) ? cards : [];
  const ids = list.map((c) => c && c.id).filter((id) => typeof id === "string");
  if (key === "?") return { focusedId: ids.includes(focusedId) ? focusedId : null, intent: { type: "help" } };
  if (ids.length === 0) return { focusedId: null, intent: null };
  const focus = ids.includes(focusedId) ? focusedId : ids[0];
  if (focus !== focusedId) return { focusedId: focus, intent: null };
  const at = ids.indexOf(focus);
  const move = (delta) => ({ focusedId: ids[Math.min(ids.length - 1, Math.max(0, at + delta))], intent: null });
  const intentFor = (type, extra) => ({ focusedId: focus, intent: { type, cardId: focus, ...extra } });
  switch (key) {
    case "j":
    case "ArrowDown": return move(1);
    case "k":
    case "ArrowUp": return move(-1);
    case "e": return intentFor("dismiss");
    case "1": return intentFor("pick", { suggestionIndex: 0 });
    case "2": return intentFor("pick", { suggestionIndex: 1 });
    case "s": return intentFor("snooze");
    case "u":
    case "Escape": return intentFor("retract");
    case "r": return intentFor("refetch");
    case "Enter":
    case "o": return intentFor("open");
    default: return { focusedId: focus, intent: null };
  }
}

// ---------------------------------------------------------------------------
// the data-layer client
// ---------------------------------------------------------------------------

export function createSupervisionClient({
  roomId,
  request,
  now,
  schedule,
  cancelSchedule,
  undoWindowMs,
} = {}) {
  if (typeof roomId !== "string" || roomId.length === 0) throw new Error("supervision client requires roomId");
  if (typeof request !== "function") throw new Error("supervision client requires request(path, { method, data })");
  const clock = typeof now === "function" ? now : () => Date.now();
  const setTimer = typeof schedule === "function" ? schedule : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof cancelSchedule === "function" ? cancelSchedule : (h) => clearTimeout(h);
  const windowMs = clampUndoWindowMs(undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS);
  const base = `/api/rooms/${encodeURIComponent(roomId)}/supervision`;

  const holds = new Map(); // cardId -> { cardId, suggestionIndex, undoDeadline, dispatch, timer, commitPromise, resolve, reject }
  const seenJournaled = new Set(); // card ids already journaled as seen this session

  const cardPath = (cardId, action) => {
    assertCardId(cardId);
    return `${base}/cards/${encodeURIComponent(cardId)}/${action}`;
  };

  // Drop a pending hold: cancel the timer. Callers decide the server call.
  function dropHold(cardId) {
    const entry = holds.get(cardId);
    if (!entry) return null;
    holds.delete(cardId);
    if (entry.timer !== null && entry.timer !== undefined) {
      try { clearTimer(entry.timer); } catch { /* a dead timer handle must not break the retract path */ }
    }
    return entry;
  }

  // The hold lapsed: fire the real room write, then re-read the card so the
  // view sees the server-authoritative state (dispatched, or stale).
  async function commitHold(cardId) {
    const entry = holds.get(cardId);
    if (!entry) return;
    holds.delete(cardId);
    try {
      if (entry.dispatch) {
        await request(entry.dispatch.path, { method: entry.dispatch.method || "POST", data: entry.dispatch.body });
      }
      const card = await request(cardPath(cardId, "refetch"), { method: "POST" });
      entry.resolve(card);
    } catch (error) {
      entry.reject(error);
    }
  }

  // Arm the client-held undo timer. One pending hold per card: a new pick
  // supersedes the old one (its timer is cancelled, its intent never fires).
  function armHold(cardId, suggestionIndex, hold) {
    dropHold(cardId);
    let resolve, reject;
    const commitPromise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const remaining = holdRemainingMs(hold.undoDeadline, clock());
    const entry = {
      cardId, suggestionIndex, undoDeadline: hold.undoDeadline,
      dispatch: hold.dispatch ?? null, timer: null, commitPromise, resolve, reject,
    };
    holds.set(cardId, entry);
    if (remaining <= 0) {
      void commitHold(cardId); // window already lapsed (or 0): commit without a timer
    } else {
      entry.timer = setTimer(() => { void commitHold(cardId); }, remaining);
    }
    return entry;
  }

  return {
    roomId,
    undoWindowMs: windowMs,
    base,

    // Priority-sorted by the server. includeSnoozed opts into snoozed cards.
    async listCards({ includeSnoozed = false } = {}) {
      const body = await request(`${base}/cards${includeSnoozed ? "?include=snoozed" : ""}`, { method: "GET" });
      return Array.isArray(body?.cards) ? body.cards : body;
    },

    // Focus-implies-seen: journal new -> seen exactly once per card per session.
    async focusCard(card) {
      if (!card || typeof card.id !== "string") throw new Error("focusCard requires a card with an id");
      assertCardId(card.id);
      if (!shouldMarkSeen(card) || seenJournaled.has(card.id)) return card;
      const seen = await request(cardPath(card.id, "seen"), { method: "POST" });
      seenJournaled.add(card.id);
      return seen;
    },

    // Dismiss = audit, never delete. Supersedes any pending hold on the card.
    async dismiss(cardId, note) {
      dropHold(cardId);
      return request(cardPath(cardId, "dismiss"), { method: "POST", data: note === undefined ? undefined : { note } });
    },

    async snooze(cardId, presetOrUntil) {
      dropHold(cardId);
      const snoozedUntil = snoozeUntil(presetOrUntil, clock());
      return request(cardPath(cardId, "snooze"), { method: "POST", data: { snoozedUntil } });
    },

    // Pick suggestion 0/1. Returns { card, hold, needsConfirm, commitPromise }.
    //   - needsConfirm: confirm-only action (money/merge/deploy/membership): no timer
    //     armed; the view must show the confirm sheet and call confirm().
    //   - hold: client-held undo window armed; commitPromise resolves with the
    //     server card after the real write fires, or { retracted: true } after retract().
    async pick(cardId, suggestionIndex) {
      assertCardId(cardId);
      if (!Number.isSafeInteger(suggestionIndex) || suggestionIndex < 0 || suggestionIndex > 1) {
        throw new Error(`invalid suggestion index: ${suggestionIndex}`);
      }
      const response = await request(cardPath(cardId, "pick"), { method: "POST", data: { suggestionIndex } });
      const card = response?.card ?? response;
      if (response?.needsConfirm === true || response?.hold?.confirmRequired === true) {
        dropHold(cardId);
        return { card, hold: null, needsConfirm: true, commitPromise: Promise.resolve({ confirmed: false }) };
      }
      const hold = response?.hold ?? null;
      if (!hold || typeof hold.undoDeadline !== "number") {
        dropHold(cardId);
        return { card, hold: null, needsConfirm: false, commitPromise: Promise.resolve(card) };
      }
      const armed = armHold(cardId, suggestionIndex, hold);
      return {
        card,
        hold: {
          cardId: armed.cardId,
          suggestionIndex: armed.suggestionIndex,
          undoDeadline: armed.undoDeadline,
          remainingMs: holdRemainingMs(armed.undoDeadline, clock()),
        },
        needsConfirm: false,
        commitPromise: armed.commitPromise,
      };
    },

    // Retract a pending_undo intent before its deadline: the timer is cancelled,
    // so the room write never fires, then the server restores the card to seen.
    async retract(cardId) {
      const entry = dropHold(cardId);
      if (entry) entry.resolve({ retracted: true, cardId });
      return request(cardPath(cardId, "retract"), { method: "POST" });
    },

    // Confirm-only class: explicit { confirm: true }, mirroring the revocation
    // pattern. Never enters the undo window.
    async confirm(cardId, suggestionIndex) {
      assertCardId(cardId);
      dropHold(cardId);
      return request(cardPath(cardId, "confirm"), { method: "POST", data: { confirm: true, suggestionIndex } });
    },

    // Re-read live claim/board state; the server may retire the card as stale
    // ("resolved elsewhere" — the notification≠truth rule).
    async refetch(cardId) {
      return request(cardPath(cardId, "refetch"), { method: "POST" });
    },

    getHold(cardId) {
      const entry = holds.get(cardId);
      if (!entry) return null;
      return {
        cardId: entry.cardId,
        suggestionIndex: entry.suggestionIndex,
        undoDeadline: entry.undoDeadline,
        remainingMs: holdRemainingMs(entry.undoDeadline, clock()),
      };
    },

    pendingHolds() {
      return [...holds.keys()].map((id) => this.getHold(id));
    },
  };
}
