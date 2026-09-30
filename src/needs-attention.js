// #662 — "Needs your attention" owner card. Owner-gated rollup of pending
// access requests, work awaiting verification/decision, spend-allowance
// headroom and expiring claim leases. Access requests clear inline with
// approve/deny; everything else deep-links to its review surface.

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
  access_request: "Join request",
  verification: "Verify",
  decision: "Decision",
  spend: "Spend",
  claim_lease: "Claim lease",
};

export function createNeedsAttentionCard({ client, section }) {
  const list = section.querySelector("#attention-list");
  const count = section.querySelector("#attention-count");
  const status = section.querySelector("#attention-status");
  const refreshButton = section.querySelector("#attention-refresh");
  const pages = section.querySelector("#attention-pages");
  const range = section.querySelector("#attention-range");
  const previous = section.querySelector("#attention-previous");
  const next = section.querySelector("#attention-next");
  let currentReport = null, epoch = 0, busy = false;
  // E-H1: retry state for failed fetches. The section starts hidden and the
  // Refresh button lives inside it, so a failed first fetch would otherwise
  // be invisible and unretryable for the whole session.
  let retryTimer = null;
  const RETRY_DELAY_MS = 30000;

  function owns(ticket, session, generation) {
    return ticket === epoch && session === client.session && generation === client.generation;
  }
  function clearRetry() {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }
  function scheduleRetry() {
    clearRetry();
    const retryTicket = ++epoch, retrySession = client.session, retryGeneration = client.generation;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (owns(retryTicket, retrySession, retryGeneration) && client.session) refresh();
    }, RETRY_DELAY_MS);
  }
  function setBusy(value) {
    busy = value;
    refreshButton.disabled = value;
    previous.disabled = value || !currentReport?.previousCursor;
    next.disabled = value || !currentReport?.nextCursor;
    list.querySelectorAll(".attention-decide").forEach(button => { button.disabled = value; });
  }
  function hide() {
    epoch++;
    clearRetry();
    currentReport = null;
    section.hidden = true;
    list.innerHTML = "";
    count.textContent = "";
    range.textContent = "";
    pages.hidden = true;
    setStatus("");
    setBusy(false);
  }

  function setStatus(message) { status.textContent = message || ""; status.classList.toggle("visible", Boolean(message)); }

  function actionControls(item) {
    return item.actions.map((action, index) => {
      if (action.method === "GET" && item.kind !== "spend") {
        // Deep-link into the work view: app.js's delegated click handler
        // revealWork()s any [data-open-work] link.
        return `<a class="button ghost" href="#pr-record/work/${esc(encodeURIComponent(item.id))}" data-open-work="${esc(item.id)}">Review</a>`;
      }
      if (action.method === "POST" && action.body) {
        const label = action.action === "approve" ? "Approve" : action.action === "deny" ? "Deny" : action.action;
        const primary = action.action === "approve" ? " primary" : "";
        return `<button type="button" class="button${primary} attention-decide" data-action-index="${index}">${esc(label)}</button>`;
      }
      return action.hint ? `<span class="attention-hint">${esc(action.hint)}</span>` : "";
    }).join("");
  }

  function render(report) {
    const items = report?.items ?? [];
    currentReport = report;
    count.textContent = String(report?.itemCount ?? items.length);
    pages.hidden = !report?.nextCursor && !report?.previousCursor;
    range.textContent = items.length ? `Showing ${report.pageOffset + 1}–${report.pageOffset + items.length} of ${report.itemCount}` : "";
    section.hidden = items.length === 0;
    list.innerHTML = items.map((item, itemIndex) => `
      <li class="attention-item attention-${esc(item.kind)} attention-severity-${esc(item.severity)}" data-item-index="${itemIndex}">
        <div class="attention-body">
          <span class="attention-kind">${esc(KIND_LABEL[item.kind] ?? item.kind)}</span>
          <strong class="attention-title">${esc(item.title)}</strong>
          <p class="attention-detail">${esc(item.detail)}</p>
        </div>
        <div class="attention-actions">${actionControls(item)}</div>
      </li>`).join("");
    list.querySelectorAll(".attention-decide").forEach(button => {
      button.addEventListener("click", () => decide(report, Number(button.closest("li").dataset.itemIndex), Number(button.dataset.actionIndex)));
    });
    setBusy(false);
    setStatus(report?.reset ? "The list changed. Showing the first page." : "");
  }

  async function decide(report, itemIndex, actionIndex) {
    if (busy || report !== currentReport || !client.session) return;
    const item = report?.items?.[itemIndex], action = item?.actions?.[actionIndex];
    if (!action?.path || action.method !== "POST" || !action.body) return;
    const ticket = ++epoch, session = client.session, generation = client.generation;
    setBusy(true);
    setStatus("Working…");
    try {
      await client.request(action.path, { method: "POST", data: action.body });
      if (!owns(ticket, session, generation)) return;
      await refresh();
    } catch (error) {
      if (!owns(ticket, session, generation)) return;
      setBusy(false);
      setStatus(error.code === "already_decided" ? "Already decided — refreshing…" : `Could not decide: ${error.message}`);
      if (error.code === "already_decided") await refresh();
    }
  }

  async function refresh(cursor = null) {
    if (!client.session) { hide(); return; }
    clearRetry();
    const ticket = ++epoch, session = client.session, generation = client.generation;
    const focused = document.activeElement;
    setBusy(true);
    setStatus("Checking…");
    try {
      const report = await client.needsAttention(cursor);
      if (!owns(ticket, session, generation)) return;
      // null = not the owner; never retain the previous owner's queue.
      render(report);
      if (focused === previous || focused === next) {
        // Avoid leaving keyboard focus on a now-disabled paging control.
        (pages.hidden ? refreshButton : focused.disabled ? (focused === next ? previous : next) : focused).focus();
      }
    } catch (error) {
      if (!owns(ticket, session, generation)) return;
      setBusy(false);
      setStatus(`Could not load: ${error.message}`);
      // E-H1: unhide so the owner sees the error and the Refresh button, and
      // schedule an automatic retry so a transient blip doesn't hide join
      // requests and approvals for the whole session.
      section.hidden = false;
      scheduleRetry();
    }
  }

  refreshButton.addEventListener("click", () => refresh());
  previous.addEventListener("click", () => { if (!busy && currentReport?.previousCursor) refresh(currentReport.previousCursor); });
  next.addEventListener("click", () => { if (!busy && currentReport?.nextCursor) refresh(currentReport.nextCursor); });
  return { refresh, hide };
}
