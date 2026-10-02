// Updates destination. Needs me, Mentions, All activity, and Saved.
// The badge counts actionable items only. Opening a row marks it read.
// Done and Clear are the handled and dismissed marks. Keyboard reachable,
// and the rows stay usable at 390px.

const FILTERS = [
  { id: "needs", label: "Needs me" },
  { id: "mentions", label: "Mentions" },
  { id: "all", label: "All activity" },
  { id: "saved", label: "Saved" }
];
const PALETTE = { "catch-up": "needs", activity: "all", mentions: "mentions", later: "saved" };

function queryFor(filter) {
  if (filter === "mentions") return "state=actionable&kinds=mention";
  if (filter === "all" || filter === "saved") return "state=all";
  return "state=actionable";
}

function visible(items, filter) {
  if (filter === "saved") return items.filter(item => item.state === "read");
  return items;
}

export function mountUpdates({ client, host }) {
  const topbar = host?.querySelector(".topbar-actions") ?? document.querySelector(".topbar-actions");
  const entry = document.createElement("button");
  entry.id = "topbar-updates";
  entry.className = "topbar-button";
  entry.type = "button";
  entry.setAttribute("aria-haspopup", "dialog");
  entry.setAttribute("aria-controls", "updates-dialog");
  const badge = document.createElement("span");
  badge.id = "updates-count";
  badge.className = "count-chip";
  entry.append("Updates ", badge);
  topbar?.prepend(entry);

  const dialog = document.createElement("dialog");
  dialog.id = "updates-dialog";
  dialog.setAttribute("aria-labelledby", "updates-title");
  dialog.innerHTML = `<div class="dialog-head"><h2 id="updates-title">Updates</h2><button id="updates-close" class="button ghost" type="button">Close</button></div><div class="updates-filters" role="tablist" aria-label="Update filters"></div><ol class="updates-list"></ol><p id="updates-status" class="form-hint" role="status"></p>`;
  (host ?? document.body).append(dialog);
  const tabs = dialog.querySelector(".updates-filters");
  const list = dialog.querySelector(".updates-list");
  const status = dialog.querySelector("#updates-status");
  for (const filter of FILTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button ghost";
    button.role = "tab";
    button.dataset.updateFilter = filter.id;
    button.textContent = filter.label;
    button.setAttribute("aria-selected", filter.id === "needs" ? "true" : "false");
    tabs.append(button);
  }
  let filter = "needs";
  let items = [];
  let actionable = 0;
  let ticket = 0;

  function paintBadge() {
    badge.textContent = actionable ? String(actionable) : "";
    badge.hidden = actionable === 0;
    entry.setAttribute("aria-label", actionable ? `Updates, ${actionable} need you` : "Updates");
  }
  function paint() {
    for (const button of tabs.querySelectorAll("[role=tab]")) {
      const on = button.dataset.updateFilter === filter;
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
    }
    list.replaceChildren();
    const rows = visible(items, filter);
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty-note";
      empty.textContent = filter === "needs" ? "Nothing needs you." : "Nothing in this filter.";
      list.append(empty);
      return;
    }
    for (const item of rows) {
      const row = document.createElement("li");
      row.className = "updates-row";
      row.dataset.updateId = item.id;
      const copy = document.createElement("div");
      copy.className = "updates-copy";
      const title = document.createElement("strong");
      title.textContent = item.title || item.kind;
      const meta = document.createElement("p");
      meta.textContent = `${item.kind.replaceAll("_", " ")} · ${item.state}`;
      copy.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "updates-actions";
      for (const [name, label] of [["open", "Open"], ["done", "Done"], ["clear", "Clear"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = name === "open" ? "button secondary" : "button ghost";
        button.dataset.updateAction = name;
        button.textContent = label;
        button.setAttribute("aria-label", `${label} ${item.title || item.kind}`);
        actions.append(button);
      }
      row.append(copy, actions);
      list.append(row);
    }
  }
  async function load(next = filter) {
    filter = next;
    const mine = ++ticket;
    status.textContent = "Loading updates…";
    try {
      const [page, needs] = await Promise.all([
        client.roomRead(`/updates?${queryFor(filter)}&limit=50`),
        filter === "needs" ? null : client.roomRead("/updates?state=actionable&limit=100")
      ]);
      if (mine !== ticket || !page) return;
      items = page.items ?? [];
      const counted = filter === "needs" ? page : needs;
      actionable = (counted?.items ?? []).filter(item => item.state === "unread" || item.state === "read").length;
      paintBadge();
      paint();
      status.textContent = "";
    } catch (error) {
      if (mine !== ticket) return;
      status.textContent = error?.message || "Could not load updates.";
    }
  }
  async function mark(item, action) {
    const requestId = crypto.randomUUID();
    const path = action === "open" ? "read" : action === "done" ? "done" : "clear";
    status.textContent = "";
    await client.roomWrite(`/updates/${encodeURIComponent(item.id)}/${path}`, { requestId });
    if (action === "open") {
      dialog.close();
      const messageId = item.sourceRef?.messageId;
      const row = messageId ? document.querySelector(`[data-message-record-id="${CSS.escape(messageId)}"]`) : null;
      row?.scrollIntoView({ block: "nearest" });
      if (row instanceof HTMLElement) row.focus({ preventScroll: true });
    }
    await load();
    if (action !== "open" && !dialog.open) dialog.showModal();
  }
  function open(next = "needs") {
    if (!dialog.open) dialog.showModal();
    const tab = tabs.querySelector(`[data-update-filter="${next}"]`);
    tab?.focus();
    void load(next);
  }
  entry.addEventListener("click", () => open(filter));
  dialog.querySelector("#updates-close").addEventListener("click", () => dialog.close());
  tabs.addEventListener("click", event => {
    const button = event.target.closest("[data-update-filter]");
    if (button) void load(button.dataset.updateFilter);
  });
  tabs.addEventListener("keydown", event => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...tabs.querySelectorAll("[role=tab]")];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = buttons[(index + step + buttons.length) % buttons.length];
    next.focus();
    void load(next.dataset.updateFilter);
  });
  list.addEventListener("click", event => {
    const button = event.target.closest("[data-update-action]");
    const row = event.target.closest("[data-update-id]");
    if (!button || !row) return;
    const item = items.find(entry => entry.id === row.dataset.updateId);
    if (!item) return;
    void mark(item, button.dataset.updateAction).catch(error => { status.textContent = error?.message || "Could not update that row."; });
  });
  const main = document.querySelector("#main");
  if (main) {
    new MutationObserver(() => { if (!main.hidden) void load(filter); })
      .observe(main, { attributes: true, attributeFilter: ["hidden"] });
  }
  paintBadge();
  return { open, openAction(id) { const next = PALETTE[id]; if (!next) return false; open(next); return true; } };
}
