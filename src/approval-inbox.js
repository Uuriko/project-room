// Approval inbox (WAVE-500 guild 10, worker 16/50): one live surface for
// pending HUMAN decisions as cards, replacing the scattered tap list.
//
// Framework-free: inboxHtml produces escaped HTML strings (unit tested);
// createApprovalInbox wires the strings to the server through a fetcher with
// event delegation. Only humans decide — the server enforces the human gate;
// this UI only presents the choice, never issues one itself.
//
// Sibling slice 4 API (feature-detected, never assumed present):
//   GET  /api/rooms/{roomId}/approvals?status=pending
//        -> { approvals: [{ id, kind, title, what, context, options: [{label, consequence}],
//             requestedBy, createdAt, expiresAt, status, receiptId?, receiptUrl? }] }
//   POST /api/rooms/{roomId}/approvals/{id}/decide  { decision: "approve" | "approve-session" | "deny-stop" }
// When the API is absent the inbox shows an honest empty state, never crashes.
//
// Pure helpers exported for tests:
//   escapeHtml, normalizeCard, sortPending, kindsOf, filterByKind,
//   isResolved, cardListHtml, cardDetailHtml, emptyStateHtml, inboxHtml

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const DECISIONS = Object.freeze([
  ["approve", "Approve"],
  ["approve-session", "Approve for this session"],
  ["deny-stop", "Deny and stop"],
]);

export function normalizeCard(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id ?? "").trim();
  if (!id) return null;
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .filter(o => o && typeof o.label === "string")
    .map(o => ({ label: String(o.label), consequence: String(o.consequence ?? "") }));
  return {
    id,
    kind: String(raw.kind ?? "general"),
    title: String(raw.title ?? "Untitled decision"),
    what: String(raw.what ?? ""),
    context: String(raw.context ?? ""),
    options,
    requestedBy: String(raw.requestedBy ?? raw.byAgent ?? "unknown"),
    createdAt: String(raw.createdAt ?? ""),
    expiresAt: String(raw.expiresAt ?? ""),
    status: String(raw.status ?? "pending"),
    receiptId: raw.receiptId != null ? String(raw.receiptId)
      : (raw.receipt && raw.receipt.id != null ? String(raw.receipt.id) : ""),
    receiptUrl: typeof raw.receiptUrl === "string" ? raw.receiptUrl
      : (raw.receipt && typeof raw.receipt.url === "string" ? raw.receipt.url : ""),
  };
}

const createdMs = card => {
  const ms = Date.parse(card.createdAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

export function sortPending(cards) {
  return [...cards].sort((a, b) => createdMs(a) - createdMs(b) || String(a.id).localeCompare(String(b.id)));
}

export function kindsOf(cards) {
  return [...new Set(cards.map(c => c.kind))].sort((a, b) => a.localeCompare(b));
}

export function filterByKind(cards, kind) {
  return kind === "all" ? [...cards] : cards.filter(c => c.kind === kind);
}

export function isResolved(card) {
  return card.status !== "pending";
}

const SAFE_URL = /^(\/|https?:\/\/)/i;

function receiptLink(card) {
  if (SAFE_URL.test(card.receiptUrl)) {
    return `<a href="${escapeHtml(card.receiptUrl)}" rel="noreferrer noopener">Receipt${card.receiptId ? ` ${escapeHtml(card.receiptId)}` : ""}</a>`;
  }
  if (card.receiptId) return `<span>Receipt ${escapeHtml(card.receiptId)}</span>`;
  return `<span class="form-hint">No receipt recorded.</span>`;
}

function formatWhen(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return escapeHtml(value);
  return escapeHtml(new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
}

function cardMeta(card) {
  const bits = [`Requested by ${escapeHtml(card.requestedBy)}`];
  if (card.createdAt) bits.push(`Created ${formatWhen(card.createdAt)}`);
  if (card.expiresAt) bits.push(`${Date.parse(card.expiresAt) < Date.now() ? "Expired" : "Expires"} ${formatWhen(card.expiresAt)}`);
  return `<p class="form-hint">${bits.join(" · ")}</p>`;
}

function decideButtons(card, busy) {
  return `<div class="inbox-decide" role="group" aria-label="Decide: ${escapeHtml(card.title)}">` +
    DECISIONS.map(([value, label]) =>
      `<button type="button" class="button${value === "deny-stop" ? " ghost" : ""}" data-inbox-decide="${value}" data-inbox-id="${escapeHtml(card.id)}"${busy ? " disabled" : ""}>${escapeHtml(label)}</button>`
    ).join("") + "</div>";
}

export function cardListHtml(cards) {
  if (!cards.length) return emptyStateHtml("empty");
  return `<ul class="inbox-list">` + cards.map(card => `
    <li><article class="inbox-card">
      <span class="inbox-kind">${escapeHtml(card.kind)}</span>
      <h3>${escapeHtml(card.title)}</h3>
      ${cardMeta(card)}
      <button type="button" class="button secondary" data-inbox-open="${escapeHtml(card.id)}">Review</button>
    </article></li>`).join("") + "</ul>";
}

export function cardDetailHtml(card, { busy = false } = {}) {
  const options = card.options.length
    ? `<dl class="inbox-options">` + card.options.map(o =>
      `<div><dt>${escapeHtml(o.label)}</dt><dd>${escapeHtml(o.consequence) || "No stated consequence."}</dd></div>`).join("") + "</dl>"
    : `<p class="form-hint">No options listed.</p>`;
  const outcome = isResolved(card)
    ? `<p class="inbox-outcome">Decision: <strong>${escapeHtml(card.status)}</strong> · ${receiptLink(card)}</p>`
    : decideButtons(card, busy);
  return `<article class="inbox-detail">
    <button type="button" class="button ghost" data-inbox-back>← Back to inbox</button>
    <span class="inbox-kind">${escapeHtml(card.kind)}</span>
    <h3>${escapeHtml(card.title)}</h3>
    ${cardMeta(card)}
    <h4>What changes</h4>
    <p>${escapeHtml(card.what) || "Not described."}</p>
    ${card.context ? `<h4>Context</h4><p>${escapeHtml(card.context)}</p>` : ""}
    <h4>Options</h4>
    ${options}
    ${outcome}
  </article>`;
}

export function emptyStateHtml(reason) {
  if (reason === "loading") return `<p class="inbox-empty">Loading decisions…</p>`;
  if (reason === "unavailable") return `<p class="inbox-empty">The approvals API isn’t available in this room yet — there is nothing to decide here.</p>`;
  if (reason === "error") return `<p class="inbox-empty">Couldn't load decisions.</p><button type="button" class="button secondary" data-inbox-retry>Retry</button>`;
  return `<p class="inbox-empty">No pending decisions.</p><p class="form-hint">New requests from agents will appear here.</p>`;
}

export function inboxHtml({ cards, kind = "all", selectedId = null, phase = "ready", error = "", busyId = null }) {
  const list = sortPending(filterByKind(cards, kind));
  const filters = ["all", ...kindsOf(cards)].map(k =>
    `<button type="button" class="button${k === "all" ? "" : " ghost"}" data-inbox-kind="${escapeHtml(k)}" aria-pressed="${k === kind}">${k === "all" ? "All" : escapeHtml(k)}</button>`).join("");
  let body;
  if (phase === "loading") body = emptyStateHtml("loading");
  else if (phase === "unavailable") body = emptyStateHtml("unavailable");
  else if (phase === "error") body = `<p class="inbox-empty">Couldn't load decisions.</p>${error ? `<p class="form-hint">${escapeHtml(error)}</p>` : ""}<button type="button" class="button secondary" data-inbox-retry>Retry</button>`;
  else if (selectedId) {
    const card = cards.find(c => c.id === selectedId);
    body = card ? cardDetailHtml(card, { busy: busyId === card.id }) : emptyStateHtml("empty");
  } else body = cardListHtml(list);
  return `<section class="inbox" aria-label="Approval inbox">
    <h2>Approval inbox</h2>
    <p class="form-hint">Pending human decisions, oldest first. Only humans can decide — the server rejects agent verdicts.</p>
    <div class="inbox-filters" role="group" aria-label="Filter by kind">${filters}</div>
    <div class="inbox-body">${body}</div>
  </section>`;
}

export function createApprovalInbox({ fetcher = globalThis.fetch, container, roomId, onDecide } = {}) {
  if (!container) throw new Error("approval-inbox: container is required");
  if (!roomId) throw new Error("approval-inbox: roomId is required");
  const base = `/api/rooms/${encodeURIComponent(roomId)}/approvals`;
  const state = { cards: [], kind: "all", selectedId: null, phase: "loading", error: "", busyId: null };

  function render() {
    container.innerHTML = inboxHtml(state);
  }

  async function refresh() {
    state.phase = "loading"; state.error = ""; render();
    try {
      const response = await fetcher(`${base}?status=pending`, { headers: { Accept: "application/json" } });
      if (response.status === 404) { state.phase = "unavailable"; }
      else if (!response.ok) { state.phase = "error"; state.error = `HTTP ${response.status}`; }
      else {
        const body = await response.json();
        const raw = body && (body.approvals ?? body.items);
        state.cards = (Array.isArray(raw) ? raw : []).map(normalizeCard).filter(Boolean);
        state.phase = "ready";
      }
    } catch (error) {
      state.phase = "error";
      state.error = error && error.message ? error.message : "network error";
    }
    render();
  }

  async function decide(id, decision) {
    const card = state.cards.find(c => c.id === id);
    if (!card || isResolved(card) || !DECISIONS.some(([value]) => value === decision)) return;
    state.busyId = id; render();
    try {
      const response = await fetcher(`${base}/${encodeURIComponent(id)}/decide`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      if (!response.ok) throw new Error((body.error && body.error.message) || `HTTP ${response.status}`);
      const updated = normalizeCard(body.approval ?? body.card ?? { ...card, status: decision });
      if (body.receipt && typeof body.receipt === "object") {
        if (body.receipt.id != null) updated.receiptId = String(body.receipt.id);
        if (typeof body.receipt.url === "string") updated.receiptUrl = body.receipt.url;
      }
      const index = state.cards.findIndex(c => c.id === id);
      if (index >= 0) state.cards[index] = updated;
      if (typeof onDecide === "function") onDecide({ id, decision, card: updated });
    } catch (error) {
      state.error = error && error.message ? error.message : "decision failed";
      state.phase = "error";
    } finally {
      state.busyId = null;
      render();
    }
  }

  function onClick(event) {
    const target = event.target;
    const closest = selector => (typeof target.closest === "function" ? target.closest(selector) : null);
    const kindButton = closest("[data-inbox-kind]");
    if (kindButton) { state.kind = kindButton.dataset.inboxKind || "all"; state.selectedId = null; render(); return; }
    const openButton = closest("[data-inbox-open]");
    if (openButton) { state.selectedId = openButton.dataset.inboxOpen; render(); return; }
    if (closest("[data-inbox-back]")) { state.selectedId = null; render(); return; }
    if (closest("[data-inbox-retry]")) { void refresh(); return; }
    const decideButton = closest("[data-inbox-decide]");
    if (decideButton) {
      event.preventDefault?.();
      void decide(decideButton.dataset.inboxId || state.selectedId, decideButton.dataset.inboxDecide);
    }
  }

  function onKeydown(event) {
    if (event.key === "Escape" && state.selectedId) { state.selectedId = null; render(); }
  }

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeydown);
  render();
  return { state, render, refresh, decide };
}
