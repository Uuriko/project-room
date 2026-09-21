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
  let inFlight = null;

  function setStatus(message) { status.textContent = message || ""; }

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
    count.textContent = String(items.length);
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
      button.addEventListener("click", () => decide(Number(button.closest("li").dataset.itemIndex), Number(button.dataset.actionIndex), button));
    });
    setStatus("");
  }

  async function decide(itemIndex, actionIndex, button) {
    const report = inFlight?.report;
    const item = report?.items?.[itemIndex], action = item?.actions?.[actionIndex];
    if (!action?.path || action.method !== "POST" || !action.body) return;
    button.disabled = true;
    setStatus("Working…");
    try {
      await client.request(action.path, { method: "POST", data: action.body });
      await refresh();
    } catch (error) {
      setStatus(error.code === "already_decided" ? "Already decided — refreshing…" : `Could not decide: ${error.message}`);
      button.disabled = false;
      if (error.code === "already_decided") await refresh();
    }
  }

  async function refresh() {
    if (!client.session) { section.hidden = true; return; }
    setStatus("Checking…");
    try {
      const report = await client.needsAttention();
      inFlight = { report };
      // null = not the owner (403 owner_required) — the card simply stays hidden.
      render(report);
    } catch (error) {
      setStatus(`Could not load: ${error.message}`);
    }
  }

  refreshButton.addEventListener("click", refresh);
  return { refresh, hide: () => { section.hidden = true; } };
}
