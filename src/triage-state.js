// src/triage-state.js — pure view-state machine for the #pr-view/triage ("Triage") view (B7).
//
// D4 (phase2/design-docs/inbox-wiring.md §3): the view owns one machine.
// Inputs: keys, snapshot changes from the data layer, timer ticks. This module
// is pure — no DOM, no fetch, no timers. The DOM layer (src/triage-ui.js)
// executes the intents this machine returns through the B17 data-layer
// interface (triageData.* in src/supervision-client.js, D4 §5).
//
// View modes: list (roving focus) | sheet (snooze_picker | confirm_sheet |
// draft_editor) | help. The card's server state (new/seen/…/stale) is
// independent of view focus: focus is local, never synced, never journaled.
//
// Security: every pane-derived string rendered by cardHtml() passes through
// escapeHtml(). There is deliberately no "view raw" toggle (D1 requirement).

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Pre-dispatch hold (D4 §2.2): client-held in v1. Default 6s, operator-
// configurable 0–10s (0 disables the window — the action fires immediately).
// The server returns the effective undoDeadline per pick; this config only
// shapes local display text. The data layer / server own the real setting.
export const DEFAULT_GRACE_SECONDS = 6;
export const MAX_GRACE_SECONDS = 10;
export function clampGraceSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_GRACE_SECONDS;
  return Math.min(MAX_GRACE_SECONDS, Math.max(0, n));
}

const KIND_LABELS = {
  review_request: "Review request",
  blocked_lane: "Blocked lane",
  done_receipt: "Done receipt",
  needs_input: "Needs input",
};
export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? escapeHtml(kind);
}

const STATE_LABELS = {
  new: "new",
  seen: "seen",
  acting: "acting",
  pending_undo: "pending undo",
  dispatched: "dispatched",
  resolved: "resolved",
  dismissed: "dismissed",
  snoozed: "snoozed",
  stale: "stale",
};
export function stateLabel(state) {
  return STATE_LABELS[state] ?? escapeHtml(state);
}

// Card states the operator may act on with E (dismiss), 1/2 (pick), S (snooze).
// pending_undo/acting/dispatched/dismissed/resolved/stale are mid-flight or
// terminal — keying an action there would orphan a dispatch or double-fire.
const DISMISSABLE = new Set(["new", "seen"]);
const PICKABLE = new Set(["new", "seen"]);
const SNOOZABLE = new Set(["new", "seen"]);

// Shorten a canonical https://github.com/{owner}/{repo}/pull/{n} ref for the chip.
function shortPrRef(prRef) {
  const m = /\/pull\/(\d+)\s*$/.exec(String(prRef ?? ""));
  return m ? `PR #${m[1]}` : null;
}

function gateClass(gate) {
  return gate === "confirm" ? "triage-gate-confirm" : "triage-gate-retractable";
}

// Render one card as an escaped HTML string. Everything pane-derived goes
// through escapeHtml — there is no raw-render path.
export function cardHtml(card, { focused = false, countdownMs = null } = {}) {
  const c = card ?? {};
  const id = escapeHtml(c.id ?? "");
  const state = String(c.state ?? "unknown");
  const stateCls = `triage-state-${state.replace(/[^a-z0-9_-]/gi, "") || "unknown"}`;
  const urgent = c.urgent
    ? `<span class="triage-urgent" title="interrupt-class card">⚡ interrupt</span>` : "";
  const priority = Number.isFinite(Number(c.priority)) ? Number(c.priority) : null;

  const metaChips = [];
  if (c.claimId) metaChips.push(`<span class="triage-meta-chip">claim ${escapeHtml(c.claimId)}</span>`);
  if (c.prRef) {
    const short = shortPrRef(c.prRef);
    metaChips.push(
      `<span class="triage-meta-chip" title="${escapeHtml(c.prRef)}">${escapeHtml(short ?? c.prRef)}</span>`);
  }
  if (c.headSha) metaChips.push(`<span class="triage-meta-chip">head ${escapeHtml(String(c.headSha).slice(0, 12))}</span>`);
  if (c.sourceType) metaChips.push(`<span class="triage-meta-chip">${escapeHtml(c.sourceType)}</span>`);

  const whyChips = Array.isArray(c.priorityWhy) && c.priorityWhy.length
    ? `<div class="triage-why" aria-label="why this priority">${
        c.priorityWhy.map(w => `<span class="triage-why-chip">${escapeHtml(w)}</span>`).join("")
      }</div>`
    : "";

  const seq = Number.isFinite(Number(c.sourceSeq)) ? Number(c.sourceSeq) : null;
  const deepLink = c.deepLink
    ? `<a class="triage-deeplink" href="${escapeHtml(c.deepLink)}">open thread</a>` : "";
  const seqBanner = seq !== null
    ? `<div class="triage-seq">as of seq ${seq} · ${deepLink} · re-fetch before acting (<kbd>R</kbd>)</div>`
    : (deepLink ? `<div class="triage-seq">${deepLink}</div>` : "");

  const staleBanner = c.staleNote
    ? `<div class="triage-stale" role="status">stale — ${escapeHtml(c.staleNote)}</div>` : "";

  const receipt = c.receipt
    ? `<div class="triage-receipt">✓ ${escapeHtml(c.receipt)}</div>` : "";

  const countdown = state === "pending_undo"
    ? `<div class="triage-countdown" data-countdown>
         <div class="triage-countdown-line"><span class="triage-countdown-k">sending</span>
           <span data-countdown-label>${escapeHtml(c.pickedAction?.label ?? "action")}</span></div>
         <div class="triage-countdown-bar"><div class="triage-countdown-fill" data-countdown-fill></div></div>
         <div class="triage-countdown-hint"><kbd>U</kbd> / <kbd>Esc</kbd> undo before delivery ·
           <span data-countdown-secs></span>s left</div>
       </div>`
    : "";

  const suggestions = Array.isArray(c.suggested) && c.suggested.length && PICKABLE.has(state)
    ? `<div class="triage-suggestions">${c.suggested.map(s => {
        const rank = Number(s?.rank) || 0;
        const gateNote = s?.gateNote ?? (s?.gate === "confirm"
          ? "⚠ confirm — cannot be undone" : "↩ retractable — take back with U/Esc");
        return `<div class="triage-suggestion">
          <button type="button" class="triage-pick" data-rank="${rank}" data-gate="${escapeHtml(s?.gate ?? "")}">
            <kbd>${rank}</kbd>
            <span class="triage-sug-label">${escapeHtml(s?.label ?? "")}</span>
            <span class="triage-gate ${gateClass(s?.gate)}">${escapeHtml(gateNote)}</span>
          </button>
          ${s?.reason ? `<p class="triage-reason">${escapeHtml(s.reason)}</p>` : ""}
          ${s?.draft ? `<p class="triage-draft">draft: ${escapeHtml(s.draft)}
            <button type="button" class="triage-draft-edit" data-edit-draft="1">edit draft</button></p>` : ""}
        </div>`;
      }).join("")}</div>`
    : "";

  return `<article class="triage-card ${stateCls}${focused ? " triage-card-focused" : ""}"
      data-card-id="${id}"${focused ? ' aria-current="true"' : ""}>
    <div class="triage-card-top">
      <span class="triage-kind">${escapeHtml(kindLabel(c.kind))}</span>
      ${urgent}
      <span class="triage-state-chip ${stateCls}">${escapeHtml(stateLabel(state))}</span>
      ${priority !== null ? `<span class="triage-priority" title="priority 0–100">▲ ${priority}</span>` : ""}
    </div>
    <h3 class="triage-summary">${escapeHtml(c.summary ?? "")}</h3>
    ${c.actorLabel ? `<p class="triage-actor">from ${escapeHtml(c.actorLabel)}</p>` : ""}
    ${metaChips.length ? `<div class="triage-meta">${metaChips.join("")}</div>` : ""}
    ${whyChips}
    ${seqBanner}
    ${staleBanner}
    ${receipt}
    ${countdown}
    ${suggestions}
  </article>`;
}

// ---------------------------------------------------------------------------
// The keyboard state machine (D4 §3.2 key table).
//
// handleKey returns an intent the DOM layer executes; intents:
//   focus {cardId, journalSeen} · dismiss {cardId} · pick {cardId, rank} ·
//   snooze-sheet {cardId} · retract {cardId} · close-sheet {cardId, kind} ·
//   refetch {cardId} · open-deep-link {cardId} · help · close-help · noop
//
// ctx: { order: string[], cards: Map<id, card>, viewFocused: bool,
//        textFieldFocused: bool }
// ---------------------------------------------------------------------------
const noop = () => ({ type: "noop" });

export function createViewMachine() {
  let mode = "list";            // "list" | "sheet" | "help"
  let sheetKind = null;         // snooze_picker | confirm_sheet | draft_editor
  let sheetCardId = null;
  let focusedId = null;
  let focusIndex = 0;
  const seenJournaled = new Set();  // card ids for which POST …/seen was issued

  function setFocusInternal(cardId, order) {
    focusedId = cardId;
    const i = order.indexOf(cardId);
    focusIndex = i >= 0 ? i : 0;
  }

  const machine = {
    mode: () => mode,
    sheetKind: () => sheetKind,
    focusedId: () => focusedId,
    focusIndex: () => focusIndex,
    hasJournaledSeen: id => seenJournaled.has(id),
    markSeenJournaled(id) { seenJournaled.add(id); },
    // Failure path for journalSeen: unmark so a later re-landing retries the
    // POST …/seen. The data layer dedupes, so a double issue is harmless.
    unmarkSeenJournaled(id) { seenJournaled.delete(id); },

    openSheet(kind, cardId) {
      mode = "sheet";
      sheetKind = kind;
      sheetCardId = cardId;
    },
    closeSheet() {
      mode = "list";
      sheetKind = null;
      sheetCardId = null;
    },
    openHelp() { mode = "help"; },
    closeHelp() { mode = "list"; },

    setFocus(cardId, order = []) {
      setFocusInternal(cardId, order);
      return true;
    },

    // Neighbor-fallover (D4 §3.3): the previously focused card keeps focus if
    // still in order; otherwise focus falls to the same index, else index−1.
    // Inserts above the focus never move it — focus is keyed by card id.
    applySnapshot(order = []) {
      if (!order.length) {
        const changed = focusedId !== null;
        focusedId = null;
        focusIndex = 0;
        return { focusedId: null, moved: changed };
      }
      if (focusedId !== null && order.includes(focusedId)) {
        focusIndex = order.indexOf(focusedId);
        return { focusedId, moved: false };
      }
      const prev = focusedId;
      const idx = Math.max(0, Math.min(focusIndex, order.length - 1));
      focusedId = order[idx];
      focusIndex = idx;
      return { focusedId, moved: prev !== focusedId };
    },

    handleKey(rawKey, ctx = {}) {
      const key = String(rawKey ?? "");
      const { order = [], cards = new Map(), viewFocused = false, textFieldFocused = false } = ctx;

      // Type-ahead safety (D4 §3.2): the handler is dead while typing. The DOM
      // handles Esc inside its own inputs directly; the machine stays silent.
      if (textFieldFocused) return noop();

      if (mode === "help") {
        if (key === "?" || key === "Escape") { machine.closeHelp(); return { type: "close-help" }; }
        return noop();
      }
      if (mode === "sheet") {
        if (key === "Escape") {
          const closed = { type: "close-sheet", cardId: sheetCardId, kind: sheetKind };
          machine.closeSheet();
          return closed;
        }
        return noop();
      }
      if (!viewFocused) return noop();

      const focusedCard = focusedId !== null ? cards.get(focusedId) : undefined;
      const lower = key.toLowerCase();

      const move = dir => {
        if (!order.length) return noop();
        let i = order.indexOf(focusedId);
        i = i < 0 ? (dir > 0 ? 0 : order.length - 1) : (i + dir + order.length) % order.length;
        const cardId = order[i];
        setFocusInternal(cardId, order);
        const card = cards.get(cardId);
        // Focus-implies-seen (D4 §3.3): journal POST …/seen exactly once per
        // card, only on J/K landing on a `new` card.
        const journalSeen = !!card && card.state === "new" && !seenJournaled.has(cardId);
        return { type: "focus", cardId, journalSeen };
      };

      switch (lower) {
        case "j":
        case "arrowdown":
          return move(1);
        case "k":
        case "arrowup":
          return move(-1);
        case "e":
          if (!focusedCard || !DISMISSABLE.has(focusedCard.state)) return noop();
          return { type: "dismiss", cardId: focusedId };
        case "enter":
          if (!focusedCard || !focusedCard.deepLink) return noop();
          return { type: "open-deep-link", cardId: focusedId };
        case "1":
        case "2": {
          if (!focusedCard || !PICKABLE.has(focusedCard.state)) return noop();
          const rank = Number(lower);
          const sug = Array.isArray(focusedCard.suggested) ? focusedCard.suggested : [];
          if (!sug.some(s => Number(s?.rank) === rank)) return noop();
          return { type: "pick", cardId: focusedId, rank };
        }
        case "s":
          if (!focusedCard || !SNOOZABLE.has(focusedCard.state)) return noop();
          machine.openSheet("snooze_picker", focusedId);
          return { type: "snooze-sheet", cardId: focusedId };
        case "u":
          // U / Esc on a focused pending_undo card retracts before delivery
          // (D4 §2.2). Retract covers only the operator's own message.
          if (!focusedCard || focusedCard.state !== "pending_undo") return noop();
          return { type: "retract", cardId: focusedId };
        case "escape":
          if (focusedCard && focusedCard.state === "pending_undo") {
            return { type: "retract", cardId: focusedId };
          }
          return noop();
        case "r":
          if (!focusedCard) return noop();
          return { type: "refetch", cardId: focusedId };
        case "?":
          machine.openHelp();
          return { type: "help" };
        default:
          return noop();
      }
    },
  };
  return machine;
}
