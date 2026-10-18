// #3342 Owner Cockpit slice 1 — the account-home shell for the cross-room
// Decisions queue + Exceptions feed served by GET /api/owner/overview.
// The server merges and sorts; this module only renders what it is given
// and executes the #662 decide actions verbatim against the existing
// per-room decide endpoint (account-mode room credentials). No client-side
// currency math exists here because the document never mixes currencies.
// #3343 slice 2 — the Money snapshot + full views and the Roster render
// the server's money/roster sections the same way: Panel C (cents) and
// Panel R (milli-credits) are separate blocks with separate units, spend
// marked agent-reported, and "unknown" spend rendered as the word, never
// as a zero the server did not send.

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

const cents = value => typeof value === "number" ? `$${(value / 100).toFixed(2)}` : "unknown";
const millis = value => typeof value === "number" ? `${value} mcr` : "unknown";

export function renderMoney(money) {
  if (!money) return "";
  const { cents: panelC, credits: panelR } = money;
  const roomLines = panelC.rooms.map(room => {
    const bar = room.burnFraction === null ? ""
      : ` · ${Math.round(room.burnFraction * 100)}% of allowance used`;
    const headroom = room.headroomCents === null ? "headroom —" : `headroom ${cents(room.headroomCents)}`;
    return `<article class="cockpit-item" data-panel="cents">
      <header><strong>${esc(room.roomName ?? room.roomId)}</strong> <span>committed ${cents(room.committedCents)}</span></header>
      <p class="form-hint">spent ${cents(room.spentCents)} · reserved ${cents(room.reservedCents)} · held ${cents(room.heldCents)} · ${headroom}${bar}</p>
      <p class="form-hint">burn ${cents(room.burnRateCentsPerDay)}/day so far this period</p>
    </article>`;
  }).join("");
  const outcome = panelC.costPerAcceptedOutcome;
  const outcomeLine = outcome.status === "ok"
    ? `<p class="form-hint">${esc(outcome.label)}</p>`
    : `<p class="form-hint">${outcome.status === "unknown" ? "Cost per accepted outcome unknown — no session has reported spend in this window." : "No accepted outcomes in this window."}</p>`;
  const unreported = panelC.totals.unreportedAttempts > 0
    ? `<p class="form-hint">${panelC.totals.unreportedAttempts} attempt${panelC.totals.unreportedAttempts === 1 ? "" : "s"} did not report spend (counted, never zeroed).</p>` : "";
  const taskLines = panelC.tasks.map(task =>
    `<article class="cockpit-item" data-panel="cents-task">
      <header><strong>${esc(task.title)}</strong> <span>${cents(task.spendCents)}</span></header>
      <p class="form-hint">${esc(task.roomName ?? task.roomId)} · ${task.attempts} attempt${task.attempts === 1 ? "" : "s"}</p>
    </article>`).join("");
  const creditLines = panelR.rooms.map(room =>
    `<article class="cockpit-item" data-panel="credits">
      <header><strong>${esc(room.roomName ?? room.roomId)}</strong> <span>${millis(room.lockedMillis)} locked in escrow</span></header>
      <p class="form-hint">pool ${millis(room.poolBalanceMillis)} · disputed ${millis(room.disputedMillis)}</p>
    </article>`).join("");
  return `<h4>Money</h4>
    <section aria-label="Real-money spend in cents"><h5>Cents (agent-reported spend)</h5>${roomLines}${outcomeLine}${unreported}${taskLines}</section>
    <section aria-label="Room credits in milli-credits"><h5>Credits (milli-credits)</h5>${creditLines || `<p class="form-hint">No credit activity in your rooms yet.</p>`}</section>`;
}

export function renderRoster(roster) {
  if (!roster) return "";
  if (roster.total === 0) return `<h4>Roster</h4><p class="form-hint">No agents in your rooms yet.</p>`;
  const counts = roster.counts;
  const summaryLine = `${counts.total} agent${counts.total === 1 ? "" : "s"} · ${counts.working} working · ${counts.stalled} stalled · ${counts.offline} offline`;
  const rows = roster.rows.slice(0, 5).map(row => {
    const receipt = row.lastReceipt
      ? ` · <a href="./?room=${encodeURIComponent(row.roomId)}">last receipt ${esc(String(row.lastReceipt.receiptId).slice(0, 24))}…</a>` : "";
    const work = row.currentWork ? ` — ${esc(row.currentWork.title)}` : "";
    return `<article class="cockpit-item" data-work-state="${esc(row.workState)}">
      <header><strong>${esc(row.displayName)}</strong> <span>${esc(row.workState)}${work}</span></header>
      <p class="form-hint">${esc(row.roomName ?? row.roomId)} · tier ${esc(row.autonomyTier)} · period cost ${cents(row.periodCostCents)}${receipt}</p>
    </article>`;
  }).join("");
  return `<h4>Roster</h4><p class="form-hint">${esc(summaryLine)}</p>${rows}`;
}

export function createOwnerCockpit({ accountClient, section, decide }) {
  const summary = section.querySelector("#cockpit-summary");
  const decisionsBox = section.querySelector("#cockpit-decisions");
  const exceptionsBox = section.querySelector("#cockpit-exceptions");
  const moneyBox = section.querySelector("#cockpit-money");
  const rosterBox = section.querySelector("#cockpit-roster");
  const stubsBox = section.querySelector("#cockpit-room-stubs");
  let epoch = 0, busy = false;

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
    if (moneyBox) moneyBox.innerHTML = renderMoney(doc.money);
    if (rosterBox) rosterBox.innerHTML = renderRoster(doc.roster);
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
        summary.textContent = "Couldn't load what needs you. Refresh to retry.";
        decisionsBox.innerHTML = "";
        exceptionsBox.innerHTML = "";
        if (moneyBox) moneyBox.innerHTML = "";
        if (rosterBox) rosterBox.innerHTML = "";
        stubsBox.innerHTML = "";
      }
      return;
    }
    if (mine !== epoch || !doc) return;
    render(doc);
  }

  return Object.freeze({ refresh });
}
