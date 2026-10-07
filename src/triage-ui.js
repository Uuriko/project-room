// src/triage-ui.js — the #pr-view/triage ("Triage") view (B7, herdr redesign).
//
// D4 (phase2/design-docs/inbox-wiring.md): the view owns the DOM list, the
// keyboard state machine (§3), focus + focus-implies-seen, the countdown
// display, sheets (snooze picker / confirm / draft editor / help), honesty
// badges and reason lines, deep links. It NEVER calls fetch directly — every
// server round-trip goes through the B17 data-layer interface below.
//
// B17 dependency (D4 §5): src/supervision-client.js exposes `triageData` with
//   mount/unmount, subscribe, setFocus/getFocus,
//   markSeen/pick/retract/confirm/dismiss/snooze/refetch.
// It has NOT landed as of 2026-10-06, so the flag gate below stays off until
// it does: triageAvailable() returns false, the nav entry stays hidden, the
// hash route no-ops — zero impact on the existing UI.
//
// B17 gap (flag gate): D4 §5 defines no herdr-session query. The conditional
// render needs triageData.hasHerdrSessions(roomId, operatorId) -> bool.
// Until B17 exposes it, the flag is off by construction.
//
// Security: all pane-derived text renders through escapeHtml (see
// triage-state.js cardHtml). There is no "view raw" toggle (D1 requirement).

import {
  createViewMachine,
  cardHtml,
  escapeHtml,
} from "./triage-state.js";

let dataLayerPromise = null;
function loadDataLayer() {
  if (!dataLayerPromise) {
    dataLayerPromise = import("./supervision-client.js")
      .then(m => m.triageData ?? m.default ?? null)
      .catch(() => null);
  }
  return dataLayerPromise;
}

function operatorIds(getRoom, getSession) {
  const room = getRoom?.();
  const session = getSession?.();
  const roomId = room?.room?.id ?? session?.roomId ?? null;
  const operatorId = session?.member?.id ?? null;
  return roomId && operatorId ? { roomId, operatorId } : null;
}

// Conditional render: true only when herdr sessions exist for this operator.
// Flag off (including "B17 not landed") → the view stays hidden.
export async function triageAvailable({ getRoom, getSession } = {}) {
  const data = await loadDataLayer();
  if (!data) return false;
  const ids = operatorIds(getRoom, getSession);
  if (!ids) return false;
  if (typeof data.hasHerdrSessions === "function") {
    try { return Boolean(await data.hasHerdrSessions(ids.roomId, ids.operatorId)); }
    catch { return false; }
  }
  return false;
}

const SNOOZE_PRESETS = [
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "tomorrow", label: "tomorrow" },
];

function isTextField(el) {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// Map the D4 §5 error contract to operator-facing copy. None are silent.
function describeError(err) {
  const code = err?.code ?? err?.name ?? "";
  switch (code) {
    case "NotFound": return "That card left the list — refreshing.";
    case "RetractExpired": return "The undo window lapsed — the action already fired.";
    case "ConfirmRequired": return "This action needs the confirm sheet.";
    case "StaleCard": return "Resolved elsewhere — the card retired as stale.";
    case "RateLimited": return "Slow down — retry in a moment.";
    default: return err?.message ? String(err.message) : "Something went wrong.";
  }
}

function helpHtml() {
  const rows = [
    ["J / K", "move between cards (landing on a new card marks it seen)"],
    ["E", "dismiss the focused card"],
    ["1 / 2", "pick a suggested action"],
    ["S", "snooze the focused card"],
    ["U / Esc", "retract a pending dispatch before it fires"],
    ["R", "re-fetch live state for the focused card"],
    ["Enter", "open the card's thread / claim / board link"],
    ["?", "this help"],
    ["Esc", "close sheet, help, or the triage view"],
  ];
  return `<div class="triage-sheet-card triage-help-card" role="dialog" aria-label="Triage keyboard help">
    <h3>Keyboard</h3>
    <dl class="triage-help-list">${rows.map(([k, d]) =>
      `<div><dt><kbd>${escapeHtml(k)}</kbd></dt><dd>${escapeHtml(d)}</dd></div>`).join("")}</dl>
    <p class="triage-hint">Shortcuts are dead while typing, and while a sheet is open.</p>
    <button type="button" data-sheet-cancel>Close (Esc)</button>
  </div>`;
}

export function installTriage({ getRoom, getSession, notice = () => {}, onOpenDeepLink = link => { location.hash = link; } } = {}) {
  let machine = createViewMachine();
  let data = null, unsubscribe = null, mounted = false, available = false;
  let snap = { order: [], cards: new Map(), focusedId: null, lastFetchAt: 0, pendingUndo: null };
  let dialog = null, listEl = null, sheetEl = null, headLineEl = null;
  let countdownRaf = 0;
  let pendingConfirm = null;             // { cardId, sheet } while confirm_sheet open
  const draftOverrides = new Map();     // cardId -> edited draft text
  const lastChecked = new Map();        // cardId -> epoch ms of last R refetch

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "triage-dialog";
    dialog.className = "triage-dialog";
    dialog.setAttribute("aria-label", "Triage");
    dialog.tabIndex = -1; // showModal traps focus inside; keep the shell focusable
    dialog.innerHTML = `
      <div class="triage-head">
        <div>
          <h2>Triage</h2>
          <p class="triage-sub" data-headline></p>
        </div>
        <button type="button" class="triage-close" data-close aria-label="Close triage">✕ <kbd>Esc</kbd></button>
      </div>
      <div class="triage-list" data-list role="list" aria-label="triage cards"></div>
      <div class="triage-sheet-wrap" data-sheet hidden></div>
      <footer class="triage-keys">
        <span><kbd>J</kbd>/<kbd>K</kbd> move</span><span><kbd>1</kbd>/<kbd>2</kbd> pick</span>
        <span><kbd>E</kbd> dismiss</span><span><kbd>S</kbd> snooze</span>
        <span><kbd>U</kbd>/<kbd>Esc</kbd> undo</span><span><kbd>R</kbd> re-fetch</span>
        <span><kbd>Enter</kbd> open</span><span><kbd>?</kbd> help</span>
      </footer>`;
    document.body.appendChild(dialog);
    listEl = dialog.querySelector("[data-list]");
    sheetEl = dialog.querySelector("[data-sheet]");
    headLineEl = dialog.querySelector("[data-headline]");
    dialog.addEventListener("cancel", e => e.preventDefault()); // Esc is routed through the machine
    dialog.addEventListener("keydown", onKeyDown);
    dialog.addEventListener("click", onClick);
  }

  function destroyDialog() {
    stopCountdown();
    dialog?.close();
    dialog?.remove();
    dialog = null; listEl = null; sheetEl = null; headLineEl = null;
  }

  // ----- snapshot plumbing -----

  function onSnapshot(next) {
    snap = next ?? snap;
    const { focusedId, moved } = machine.applySnapshot(snap.order ?? []);
    if (moved && data) {
      try { data.setFocus(focusedId); } catch { /* focus is local; a store miss is harmless */ }
    }
    render();
    syncCountdown();
  }

  function render() {
    if (!dialog) return;
    const order = snap.order ?? [];
    const cards = snap.cards ?? new Map();
    if (headLineEl) {
      const n = order.length;
      const updated = snap.lastFetchAt ? ` · updated ${new Date(snap.lastFetchAt).toLocaleTimeString()}` : "";
      headLineEl.textContent = n ? `${n} card${n === 1 ? "" : "s"} needing you${updated}` : `nothing needing you${updated}`;
    }
    listEl.innerHTML = order.length
      ? order.map(id => {
          const c = cards.get(id);
          return c ? cardHtml(c, { focused: c.id === machine.focusedId() }) : "";
        }).join("")
      : `<div class="triage-empty"><div class="triage-empty-big">triage clear.</div>
         <div>no cards need you right now. new review requests, blocked lanes and receipts land here.</div></div>`;
    // "checked just now" lines from R refetches (view-local, per D4 key table).
    for (const [id, at] of lastChecked) {
      const el = listEl.querySelector(`[data-card-id="${CSS.escape(id)}"] .triage-seq`);
      if (el && !el.querySelector("[data-checked]")) {
        const s = document.createElement("span");
        s.dataset.checked = "1";
        s.className = "triage-checked";
        s.textContent = ` · checked just now (${new Date(at).toLocaleTimeString()})`;
        el.appendChild(s);
      }
    }
    renderSheet();
  }

  function renderSheet() {
    if (!sheetEl) return;
    const mode = machine.mode();
    if (mode === "help") {
      sheetEl.hidden = false;
      sheetEl.innerHTML = helpHtml();
      return;
    }
    if (mode !== "sheet") {
      sheetEl.hidden = true;
      sheetEl.innerHTML = "";
      pendingConfirm = null;
      return;
    }
    const kind = machine.sheetKind();
    sheetEl.hidden = false;
    if (kind === "snooze_picker") {
      sheetEl.innerHTML = `<div class="triage-sheet-card" role="dialog" aria-label="Snooze card">
        <h3>Snooze this card</h3>
        <div class="triage-snooze-options">${SNOOZE_PRESETS.map(p =>
          `<button type="button" data-snooze="${escapeHtml(p.value)}">${escapeHtml(p.label)}</button>`).join("")}
        </div>
        <label class="triage-custom-snooze">Custom
          <input type="datetime-local" data-snooze-custom aria-label="Custom snooze time"></label>
        <div class="triage-sheet-actions">
          <button type="button" data-snooze-apply>Apply</button>
          <button type="button" data-sheet-cancel>Cancel (Esc)</button>
        </div></div>`;
    } else if (kind === "confirm_sheet" && pendingConfirm) {
      const sh = pendingConfirm.sheet ?? {};
      sheetEl.innerHTML = `<div class="triage-sheet-card triage-confirm" role="alertdialog" aria-label="Confirm action">
        <h3>${escapeHtml(sh.title ?? "Confirm")}</h3>
        ${sh.consequence ? `<p class="triage-confirm-consequence">${escapeHtml(sh.consequence)}</p>` : ""}
        ${sh.costLine ? `<p class="triage-confirm-cost">${escapeHtml(sh.costLine)}</p>` : ""}
        <p class="triage-confirm-irreversible">⚠ This cannot be taken back. Money, merges, deploys and
          membership changes never get an undo window.</p>
        <div class="triage-sheet-actions">
          <button type="button" class="triage-confirm-yes" data-confirm-yes>Confirm — cannot be undone</button>
          <button type="button" data-sheet-cancel>Cancel (Esc)</button>
        </div></div>`;
    } else if (kind === "draft_editor") {
      const cardId = pendingConfirm?.cardId;
      const card = cardId ? snap.cards.get(cardId) : null;
      const sug = card?.suggested?.find(s => typeof s?.draft === "string");
      const current = draftOverrides.get(cardId) ?? sug?.draft ?? "";
      sheetEl.innerHTML = `<div class="triage-sheet-card" role="dialog" aria-label="Edit draft">
        <h3>Edit draft</h3>
        <textarea data-draft-text rows="4" maxlength="2000" aria-label="Draft text">${escapeHtml(current)}</textarea>
        <div class="triage-sheet-actions">
          <button type="button" data-draft-save>Save draft</button>
          <button type="button" data-sheet-cancel>Cancel (Esc)</button>
        </div>
        <p class="triage-hint">Ctrl+Enter saves · Esc cancels. The draft is sent only if you pick the action.</p>
      </div>`;
      const ta = sheetEl.querySelector("[data-draft-text]");
      ta?.focus();
    } else {
      sheetEl.hidden = true;
      sheetEl.innerHTML = "";
    }
  }

  function closeSheetUI() {
    // D4 §3.2: Esc on a sheet closes it with no state change. The parenthetical
    // "confirm sheet cancel → card back to `seen` via dataLayer" names a path
    // D4 §5 does not define (no acting→seen call); the next poll reconciles.
    pendingConfirm = null;
    machine.closeSheet();
    renderSheet();
  }

  function scrollFocusedIntoView() {
    const id = machine.focusedId();
    if (!id || !listEl) return;
    listEl.querySelector(`[data-card-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ----- countdown (view-local display; the server's undoDeadline is authoritative) -----

  function stopCountdown() {
    if (countdownRaf) cancelAnimationFrame(countdownRaf);
    countdownRaf = 0;
  }

  function syncCountdown() {
    stopCountdown();
    const p = snap.pendingUndo;
    if (!p?.cardId || !p?.undoDeadline || !listEl) return;
    const total = Math.max(1, p.undoDeadline - Date.now());
    const tick = () => {
      countdownRaf = 0;
      const cardEl = listEl.querySelector(`[data-card-id="${CSS.escape(p.cardId)}"]`);
      const secsEl = cardEl?.querySelector("[data-countdown-secs]");
      const fillEl = cardEl?.querySelector("[data-countdown-fill]");
      const hintEl = cardEl?.querySelector("[data-countdown] .triage-countdown-hint");
      const remain = p.undoDeadline - Date.now();
      if (!cardEl || !secsEl) return; // card left the list; snapshot governs
      if (remain <= 0) {
        secsEl.textContent = "0.0";
        if (fillEl) fillEl.style.width = "0%";
        if (hintEl) hintEl.textContent = "window lapsed — waiting for the receipt…";
        return; // stop; the data layer's poll shows dispatched + receipt (D4 §3.4)
      }
      secsEl.textContent = (remain / 1000).toFixed(1);
      if (fillEl) fillEl.style.width = `${(remain / total) * 100}%`;
      countdownRaf = requestAnimationFrame(tick);
    };
    countdownRaf = requestAnimationFrame(tick);
  }

  // ----- intent execution (the view never calls fetch; only triageData.*) -----

  function fail(err) {
    notice(describeError(err), true);
  }

  function journalSeen(cardId) {
    if (!data || machine.hasJournaledSeen(cardId)) return;
    machine.markSeenJournaled(cardId);
    data.markSeen(cardId).catch(() => machine.unmarkSeenJournaled(cardId));
  }

  async function doPick(cardId, rank) {
    if (!data) return;
    if (snap.pendingUndo) {
      notice("A dispatch is already pending — retract it first (U / Esc).", true);
      return;
    }
    try {
      const updated = await data.pick(cardId, rank, draftOverrides.get(cardId));
      // Reversible → snapshot shows pending_undo (countdown starts on next
      // snapshot). Confirm-only → the pick arms a confirm sheet, never a timer:
      // money / merges / deploys / membership NEVER get an undo window.
      if (updated?.confirmSheet) {
        machine.openSheet("confirm_sheet", cardId);
        pendingConfirm = { cardId, sheet: updated.confirmSheet };
        renderSheet();
      }
    } catch (err) { fail(err); }
  }

  async function doConfirm() {
    const pc = pendingConfirm;
    if (!pc || !data) return;
    try {
      await data.confirm(pc.cardId);
      draftOverrides.delete(pc.cardId);
      closeSheetUI();
    } catch (err) { fail(err); }
  }

  async function doSnooze(cardId, until) {
    if (!data) return;
    try {
      await data.snooze(cardId, until);
      closeSheetUI();
    } catch (err) { fail(err); }
  }

  function applyCustomSnooze() {
    const input = sheetEl?.querySelector("[data-snooze-custom]");
    const cardId = machine.focusedId();
    const ms = input?.value ? Date.parse(input.value) : NaN;
    if (!cardId || !Number.isFinite(ms)) {
      notice("Pick a valid date and time for the custom snooze.", true);
      return;
    }
    void doSnooze(cardId, ms);
  }

  async function executeIntent(intent) {
    if (!intent || intent.type === "noop") return;
    switch (intent.type) {
      case "focus":
        if (data && intent.cardId) {
          try { data.setFocus(intent.cardId); } catch { /* focus is local */ }
          if (intent.journalSeen) journalSeen(intent.cardId);
        }
        render();
        scrollFocusedIntoView();
        return;
      case "dismiss":
        try { await data.dismiss(intent.cardId); }
        catch (err) { fail(err); }
        return;
      case "pick":
        await doPick(intent.cardId, intent.rank);
        return;
      case "snooze-sheet":
        renderSheet(); // machine already opened the sheet
        sheetEl?.querySelector("button")?.focus();
        return;
      case "retract":
        try { await data.retract(intent.cardId); }
        catch (err) { fail(err); } // RetractExpired → "already fired", rendered not silent
        return;
      case "close-sheet":
        closeSheetUI();
        return;
      case "refetch": {
        try {
          const updated = await data.refetch(intent.cardId);
          lastChecked.set(intent.cardId, Date.now());
          if (updated?.state === "stale") {
            // The snapshot drops the card from order; neighbor fallover in onSnapshot.
            notice(`Card retired as stale: ${updated.staleNote ?? "resolved elsewhere"}.`, false);
          }
          render();
        } catch (err) { fail(err); }
        return;
      }
      case "open-deep-link": {
        const card = snap.cards.get(intent.cardId);
        if (card?.deepLink) onOpenDeepLink(card.deepLink);
        return;
      }
      case "help":
      case "close-help":
        renderSheet();
        return;
      default:
        return;
    }
  }

  function onKeyDown(e) {
    const ae = document.activeElement;
    if (isTextField(ae)) {
      // Type-ahead safety: typing never triggers card shortcuts.
      if (e.key === "Escape") {
        e.preventDefault();
        if (machine.mode() === "sheet") closeSheetUI();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && ae.hasAttribute("data-snooze-custom")) {
        e.preventDefault();
        applyCustomSnooze();
        return;
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ae.hasAttribute("data-draft-text")) {
        e.preventDefault();
        saveDraft();
        return;
      }
      return;
    }
    const intent = machine.handleKey(e.key, {
      order: snap.order ?? [],
      cards: snap.cards ?? new Map(),
      viewFocused: dialog?.open ?? false,
      textFieldFocused: false,
    });
    if (intent.type === "noop") {
      // Esc with an open list and nothing retractable dismisses the view itself.
      if (e.key === "Escape" && machine.mode() === "list") {
        const fc = machine.focusedId() ? (snap.cards ?? new Map()).get(machine.focusedId()) : null;
        if (!fc || fc.state !== "pending_undo") {
          e.preventDefault();
          api.close();
        }
      }
      return;
    }
    e.preventDefault();
    void executeIntent(intent);
  }

  function saveDraft() {
    const ta = sheetEl?.querySelector("[data-draft-text]");
    const cardId = pendingConfirm?.cardId;
    if (ta && cardId) draftOverrides.set(cardId, ta.value);
    closeSheetUI();
  }

  function openDraftEditor(cardId) {
    pendingConfirm = { cardId, sheet: null };
    machine.openSheet("draft_editor", cardId);
    renderSheet();
  }

  function onClick(e) {
    const t = e.target;
    if (t.closest("[data-close]")) { api.close(); return; }
    if (t.closest("[data-sheet-cancel]")) { closeSheetUI(); dialog?.focus(); return; }
    if (t.closest("[data-confirm-yes]")) { void doConfirm(); return; }
    if (t.closest("[data-draft-save]")) { saveDraft(); dialog?.focus(); return; }
    const snoozeBtn = t.closest("[data-snooze]");
    if (snoozeBtn) {
      const cardId = machine.focusedId();
      if (cardId) void doSnooze(cardId, snoozeBtn.dataset.snooze);
      return;
    }
    if (t.closest("[data-snooze-apply]")) { applyCustomSnooze(); return; }
    const cardEl = t.closest("[data-card-id]");
    const cardId = cardEl?.dataset.cardId;
    if (t.closest("[data-edit-draft]")) {
      if (cardId) openDraftEditor(cardId);
      return;
    }
    const pickBtn = t.closest("[data-rank]");
    if (pickBtn && cardId) {
      machine.setFocus(cardId, snap.order ?? []);
      void doPick(cardId, Number(pickBtn.dataset.rank));
      return;
    }
    if (cardEl && cardId) {
      // Click focuses without journaling seen — only J/K journal (D4 §3.3).
      machine.setFocus(cardId, snap.order ?? []);
      if (data) { try { data.setFocus(cardId); } catch { /* local */ } }
      render();
    }
  }

  // ----- public API -----

  const api = {
    isAvailable: () => available,

    async open() {
      const ids = operatorIds(getRoom, getSession);
      if (!ids) return;
      const dl = await loadDataLayer();
      if (!dl) return; // B17 not landed: flag off, stay hidden
      available = await triageAvailable({ getRoom, getSession });
      if (!available) return; // no herdr sessions: hidden, zero impact
      data = dl;
      ensureDialog();
      if (dialog.open) return;
      if (!mounted) {
        await data.mount(ids.roomId, ids.operatorId);
        unsubscribe = data.subscribe(onSnapshot);
        mounted = true;
      }
      dialog.showModal();
      dialog.focus();
      render();
    },

    close() {
      stopCountdown();
      if (dialog?.open) dialog.close();
    },

    sync() {
      if (dialog?.open) render();
    },

    // Room switch / sign-out: unmount the data layer (D4 §5: unmount stops
    // the poll and drops the v1 hold timer — safe, journaled inaction).
    reset() {
      try { unsubscribe?.(); } catch { /* noop */ }
      unsubscribe = null;
      try { data?.unmount(); } catch { /* noop */ }
      data = null;
      mounted = false;
      available = false;
      pendingConfirm = null;
      draftOverrides.clear();
      lastChecked.clear();
      machine = createViewMachine();
      snap = { order: [], cards: new Map(), focusedId: null, lastFetchAt: 0, pendingUndo: null };
      destroyDialog();
    },

    hasPending() {
      return !!snap.pendingUndo;
    },
  };
  return api;
}
