import { uiText } from "./strings.js";
// #3342 Owner Cockpit slice 1 — the account-home shell for the cross-room
// Decisions queue + Exceptions feed served by GET /api/owner/overview.
// The server merges and sorts; this module only renders what it is given
// and executes the #662 decide actions verbatim against the existing
// per-room decide endpoint (account-mode room credentials). No client-side
// currency math exists here because the document never mixes currencies.

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
  access_request: "Join request",
  verification: "Verify",
  decision: "Decision",
  dispute: "Dispute",
  claim_lease: "Claim lease",
  spend: "Spend",
  board_review: "Board review",
  bounty_review: "Bounty review",
  bounty_challenge: "Bounty challenge",
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

// The stakes line renders the item's own currency field verbatim — the
// document never mixes currencies, so neither does the rendering: no
// conversion, no shared total.
export function formatStakes(item) {
  if (typeof item?.amountMillis === "number") return `${item.amountMillis} milli-credits at stake`;
  if (typeof item?.amountCents === "number") return `${item.amountCents} cents at stake`;
  return "";
}

export function formatCountdown(timeToConsequenceMs) {
  if (typeof timeToConsequenceMs !== "number" || !Number.isFinite(timeToConsequenceMs)) return "";
  if (timeToConsequenceMs <= 0) return "deadline passed";
  const minutes = Math.floor(timeToConsequenceMs / 60000);
  if (minutes < 60) return `deadline in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `deadline in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `deadline in ${days}d ${hours % 24}h`;
}

// Only approve/deny POST templates are one-tap decisions the cockpit
// executes inline. Any other POST (e.g. spend's adjust, which needs an
// amount) renders as a link — a button labelled Deny that posts a body
// it cannot succeed with is worse than a link (fig-06 G7).
const DECIDE_ACTIONS = new Set(["approve", "deny"]);

export function cockpitItemHtml(item) {
  const label = KIND_LABEL[item.kind] ?? item.kind;
  const age = formatAge(item.ageMs);
  const stakes = formatStakes(item);
  const countdown = formatCountdown(item.timeToConsequenceMs);
  const actions = (item.actions ?? []).map(action => {
    if (action.method === "POST" && DECIDE_ACTIONS.has(action.action)) {
      return `<button type="button" class="button ${action.action === "approve" ? "primary" : "ghost"}" data-cockpit-decide="${esc(action.action)}" data-item-id="${esc(item.id)}">${esc(action.action === "approve" ? "Approve" : "Deny")}</button>`;
    }
    return `<a class="text-button" href="./?room=${encodeURIComponent(item.roomId)}">Review in room</a>`;
  }).join(" ");
  return `<article class="cockpit-item" data-kind="${esc(item.kind)}">
    <header><strong>${esc(label)}</strong> <span>${esc(item.title)}</span></header>
    <p class="form-hint">${esc(item.roomName ?? item.roomId)}${age ? ` · ${esc(age)}` : ""}${stakes ? ` · ${esc(stakes)}` : ""}${countdown ? ` · ${esc(countdown)}` : ""}</p>
    ${item.consequence ? `<p class="form-hint">${esc(item.consequence)}</p>` : ""}
    <div class="cockpit-actions">${actions}</div>
  </article>`;
}

export function createOwnerCockpit({ accountClient, section, decide }) {
  const summary = section.querySelector("#cockpit-summary");
  const decisionsBox = section.querySelector("#cockpit-decisions");
  const exceptionsBox = section.querySelector("#cockpit-exceptions");
  const stubsBox = section.querySelector("#cockpit-room-stubs");
  let epoch = 0, busy = false;

  function renderException(item) {
    const where = item.roomName ?? item.roomId ?? "Deployment";
    return `<article class="cockpit-item" data-kind="${esc(item.kind)}" data-severity="${esc(item.severity)}">
      <header><strong>${esc(SEVERITY_LABEL[item.severity] ?? item.severity)}</strong> <span>${esc(item.detail)}</span></header>
      <p class="form-hint">${esc(where)}</p>
    </article>`;
  }

  function render(doc) {
    const { decisions, exceptions, rooms } = doc;
    const notesOpen = exceptionsBox.querySelector("details")?.open;
    const notices = exceptions.items.filter(item => item.severity === "info");
    const actionable = exceptions.items.filter(item => item.severity !== "info");
    section.hidden = decisions.total === 0 && exceptions.total === 0 && !(doc.roomErrors?.length);
    const heading = section.querySelector("h3");
    if (heading) heading.hidden = !decisions.total && !actionable.length && !doc.roomErrors?.length;
    section.setAttribute("aria-labelledby", heading?.hidden ? "cockpit-notes-title" : "owner-cockpit-title");
    const parts = [`${decisions.waiting} waiting`];
    if (decisions.oldestAgeMs > 0) parts.push(`oldest ${formatAge(decisions.oldestAgeMs).replace("waiting ", "")}`);
    if (decisions.overdue > 0) parts.push(`${decisions.overdue} overdue`);
    if (rooms.label) parts.push(`across ${rooms.label}`);
    summary.textContent = decisions.total ? parts.join(" · ") : "";
    decisionsBox.innerHTML = decisions.total === 0
      ? ""
      : decisions.items.map(cockpitItemHtml).join("");
    exceptionsBox.innerHTML = exceptions.total === 0
      ? ""
      : (actionable.length ? `<h4>Exceptions</h4>` + actionable.map(renderException).join("") : "")
        + (notices.length ? uiText("human.roomNotesHtml", { open: notesOpen ? "open" : "", content: notices.map(renderException).join("") }) : "");
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
        const heading = section.querySelector("h3");
        if (heading) heading.hidden = false;
        section.setAttribute("aria-labelledby", "owner-cockpit-title");
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
