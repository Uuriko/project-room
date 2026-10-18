// #3342 Owner Cockpit slice 1 — the account-home shell for the cross-room
// Decisions queue + Exceptions feed served by GET /api/owner/overview.
// The server merges and sorts; this module only renders what it is given
// and executes the #662 decide actions verbatim against the existing
// per-room decide endpoint (account-mode room credentials). No client-side
// currency math exists here because the document never mixes currencies.
//
// #3340 — the account-home Needs Attention badge + per-room deep lines in
// this same shell are fed by that same overview document: the badge count
// is the document's Decisions total verbatim (the one attentionReport-based
// count; nothing here recounts the underlying per-room sources), and the
// per-room lines group the Decisions items the document already carries.

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
  access_request: "Join request",
  verification: "Verify",
  decision: "Decision",
  dispute: "Dispute",
  claim_lease: "Claim lease",
  spend: "Spend",
};

const SEVERITY_LABEL = { critical: "Critical", warn: "Warning", info: "Note" };

export function formatAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return "";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return `waiting ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `waiting ${hours}h`;
  const days = Math.floor(hours / 24);
  return `waiting ${days}d ${hours % 24}h`;
}

// #3340: the badge count is the overview's Decisions total, taken verbatim.
// It is never derived from items.length (the items array is capped by the
// server) and never recomputed from per-room sources — one counting
// implementation (the overview's attentionReport fan-out) feeds every
// surface.
export function attentionBadgeCount(doc) {
  const total = doc?.decisions?.total;
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

// #3340: per-room lines group the Decisions items the overview document
// already carries (each item has roomId + roomName), in the document's
// risk-first order. This is presentation grouping of the served queue, not
// a recount: when the queue is capped, attentionLinesTruncated() says so
// and the rendered lines carry the honest coverage note.
export function perRoomAttention(doc) {
  const lines = [];
  const byRoom = new Map();
  for (const item of doc?.decisions?.items ?? []) {
    if (!item || typeof item.roomId !== "string" || item.roomId.length === 0) continue;
    let line = byRoom.get(item.roomId);
    if (!line) {
      line = { roomId: item.roomId, roomName: item.roomName ?? item.roomId, count: 0 };
      byRoom.set(item.roomId, line);
      lines.push(line);
    }
    line.count++;
  }
  return lines;
}

export function attentionLinesTruncated(doc) {
  const total = doc?.decisions?.total;
  const shown = Array.isArray(doc?.decisions?.items) ? doc.decisions.items.length : 0;
  return Number.isSafeInteger(total) && total > shown;
}

// The account-home deep link into a room — the same "./?room=" target the
// cockpit's "Review in room" actions already use.
export function roomAttentionHref(roomId) {
  return `./?room=${encodeURIComponent(roomId)}`;
}

export function roomAttentionLinesHtml(doc) {
  const lines = perRoomAttention(doc);
  if (lines.length === 0) return "";
  const rows = lines.map(line =>
    `<p class="cockpit-room-line"><a href="${esc(roomAttentionHref(line.roomId))}">${esc(line.roomName)}</a> — ${line.count} ${line.count === 1 ? "needs" : "need"} attention</p>`);
  if (attentionLinesTruncated(doc)) {
    rows.push(`<p class="form-hint">Per-room counts cover the ${doc.decisions.items.length} most urgent decisions shown, of ${doc.decisions.total} total.</p>`);
  }
  return rows.join("");
}

export function createOwnerCockpit({ accountClient, section, decide }) {
  const summary = section.querySelector("#cockpit-summary");
  const badge = section.querySelector("#cockpit-attention-badge");
  const roomLines = section.querySelector("#cockpit-room-lines");
  const decisionsBox = section.querySelector("#cockpit-decisions");
  const exceptionsBox = section.querySelector("#cockpit-exceptions");
  const stubsBox = section.querySelector("#cockpit-room-stubs");
  let epoch = 0, busy = false;

  // #3340 zero-state: no badge and no per-room lines when nothing waits.
  function renderAttentionBadge(doc) {
    if (badge) {
      const count = doc ? attentionBadgeCount(doc) : 0;
      badge.textContent = count > 0 ? String(count) : "";
      badge.hidden = count === 0;
      if (typeof badge.setAttribute === "function") {
        badge.setAttribute("aria-label", count > 0 ? `Needs attention: ${count} waiting` : "Needs attention");
      }
    }
    if (roomLines) roomLines.innerHTML = doc ? roomAttentionLinesHtml(doc) : "";
  }

  function renderItem(item) {
    const label = KIND_LABEL[item.kind] ?? item.kind;
    const age = formatAge(item.ageMs);
    const actions = (item.actions ?? []).map(action => {
      if (action.method === "POST") {
        return `<button type="button" class="button ${action.action === "approve" ? "primary" : "ghost"}" data-cockpit-decide="${esc(action.action)}" data-item-id="${esc(item.id)}">${esc(action.action === "approve" ? "Approve" : "Deny")}</button>`;
      }
      return `<a class="text-button" href="./?room=${encodeURIComponent(item.roomId)}">Review in room</a>`;
    }).join(" ");
    return `<article class="cockpit-item" data-kind="${esc(item.kind)}">
      <header><strong>${esc(label)}</strong> <span>${esc(item.title)}</span></header>
      <p class="form-hint">${esc(item.roomName ?? item.roomId)}${age ? ` · ${esc(age)}` : ""}</p>
      ${item.consequence ? `<p class="form-hint">${esc(item.consequence)}</p>` : ""}
      <div class="cockpit-actions">${actions}</div>
    </article>`;
  }

  function renderException(item) {
    const where = item.roomName ?? item.roomId ?? "Deployment";
    return `<article class="cockpit-item" data-kind="${esc(item.kind)}" data-severity="${esc(item.severity)}">
      <header><strong>${esc(SEVERITY_LABEL[item.severity] ?? item.severity)}</strong> <span>${esc(item.detail)}</span></header>
      <p class="form-hint">${esc(where)}</p>
    </article>`;
  }

  function render(doc) {
    section.hidden = false;
    renderAttentionBadge(doc);
    const { decisions, exceptions, rooms } = doc;
    const parts = [`${decisions.waiting} waiting`];
    if (decisions.oldestAgeMs > 0) parts.push(`oldest ${formatAge(decisions.oldestAgeMs).replace("waiting ", "")}`);
    if (decisions.overdue > 0) parts.push(`${decisions.overdue} overdue`);
    if (rooms.label) parts.push(`across ${rooms.label}`);
    summary.textContent = parts.join(" · ");
    decisionsBox.innerHTML = decisions.total === 0
      ? `<p class="form-hint">Inbox zero — nothing needs you.</p>`
      : decisions.items.map(renderItem).join("");
    exceptionsBox.innerHTML = exceptions.total === 0
      ? `<p class="form-hint">No exceptions in window.</p>`
      : `<h4>Exceptions</h4>` + exceptions.items.map(renderException).join("");
    stubsBox.innerHTML = (doc.roomErrors ?? []).map(stub =>
      `<p class="form-hint">Couldn't read room ${esc(stub.roomId)} (${esc(stub.error)}) — it is excluded from these totals.</p>`).join("");
    for (const button of decisionsBox.querySelectorAll("[data-cockpit-decide]")) {
      button.addEventListener("click", () => onDecide(button, doc));
    }
  }

  async function onDecide(button, doc) {
    if (busy) return;
    const item = doc.decisions.items.find(entry => entry.id === button.dataset.itemId);
    const action = item?.actions?.find(entry => entry.action === button.dataset.cockpitDecide && entry.method === "POST");
    if (!item || !action) return;
    busy = true;
    button.disabled = true;
    try {
      await decide(action);
      await refresh();
    } catch {
      summary.textContent = "That decision didn't go through. Refresh to see the current queue.";
      button.disabled = false;
    } finally { busy = false; }
  }

  async function refresh() {
    const mine = ++epoch;
    let doc;
    try { doc = await accountClient.ownerOverview(); }
    catch (error) {
      if (mine !== epoch) return;
      // A non-owner account simply has no cockpit; the room list below is
      // still their home. Any other failure says so once, quietly.
      section.hidden = error?.code === "owner_required" || error?.status === 403;
      if (!section.hidden) {
        section.hidden = false;
        renderAttentionBadge(null);
        summary.textContent = "Couldn't load what needs you. Refresh to retry.";
        decisionsBox.innerHTML = "";
        exceptionsBox.innerHTML = "";
        stubsBox.innerHTML = "";
      }
      return;
    }
    if (mine !== epoch || !doc) return;
    render(doc);
  }

  return Object.freeze({ refresh });
}
