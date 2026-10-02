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
const ACTION_LABELS = { open: "Open", done: "Handled for me", clear: "Clear" };
const validBasis = value => typeof value === "string" && /^ub1_[a-f0-9]{64}$/.test(value);
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

export function mountUpdates({ client, host, getContext, onOpenWork, onOpenMessage }) {
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
  dialog.innerHTML = `<div class="dialog-head"><h2 id="updates-title">Updates</h2><button id="updates-close" class="button ghost" type="button">Close</button></div><div class="updates-filters" role="tablist" aria-label="Update filters"></div><ol class="updates-list"></ol><p id="updates-summary" class="form-hint"></p><p id="updates-partial" class="form-hint"></p><button id="updates-load-more" class="button secondary" type="button" hidden>Load more</button><p id="updates-status" class="form-hint" role="status"></p>`;
  (host ?? document.body).append(dialog);
  const tabs = dialog.querySelector(".updates-filters");
  const list = dialog.querySelector(".updates-list");
  const status = dialog.querySelector("#updates-status");
  const summary = dialog.querySelector("#updates-summary");
  const partial = dialog.querySelector("#updates-partial");
  const loadMore = dialog.querySelector("#updates-load-more");
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
  let cursor = null, hasMore = false, loadedPages = 0, incomplete = false;
  let visitedCursors = new Set();
  let badgeMore = false, badgeIncomplete = false, loading = false;
  let ticket = 0;
  let interaction = 0;
  let owner = null;
  // Uncertain operations survive same-session Close/reopen. Their observed
  // basis never advances just because a refresh brings a newer item into view.
  const operations = new Map();
  const context = () => getContext ? getContext() : client.session ? `${client.generation}|${client.session.roomId}|${client.session.member?.id}` : null;
  const owns = value => value !== null && value === context();
  function reset() {
    ticket++; interaction++; owner = null; items = []; actionable = 0; filter = "needs"; operations.clear();
    cursor = null; hasMore = false; loadedPages = 0; incomplete = false; visitedCursors = new Set();
    badgeMore = false; badgeIncomplete = false; loading = false;
    if (dialog.open) dialog.close();
    list.replaceChildren(); status.textContent = ""; summary.textContent = ""; partial.textContent = "";
    paintBadge(); paintPaging();
  }
  function currentContext() {
    const value = context();
    if (owner !== value) { reset(); owner = value; }
    return value;
  }
  function cancelPending() { interaction++; ticket++; loading = false; paintOperations(); paintPaging(); }
  function capture(itemId, action = "open") {
    return { filter, itemId, action, pageBudget: Math.max(1, loadedPages), scrollTop: dialog.scrollTop, listScrollTop: list.scrollTop };
  }
  async function restore(saved) {
    if (!currentContext()) return false;
    const mine = ++interaction, owned = owner;
    if (!dialog.open) dialog.showModal();
    const restored = await load(saved.filter, { budget: Math.max(1, saved.pageBudget || 1) });
    if (!restored || mine !== interaction || !owns(owned) || !dialog.open) return false;
    dialog.scrollTop = saved.scrollTop; list.scrollTop = saved.listScrollTop;
    const row = [...list.children].find(node => node.dataset.updateId === saved.itemId);
    const target = row?.querySelector(`[data-update-action="${saved.action}"]`)
      ?? tabs.querySelector(`[data-update-filter="${filter}"]`);
    target?.focus({ preventScroll: true });
    if (!row) {
      target?.scrollIntoView({ block: "nearest", behavior: "instant" });
      const fallback = hasMore ? "That update is outside the loaded window. Load more to continue."
        : incomplete ? "Some sources are unavailable. That update could not be restored."
          : "That update is no longer in this filter.";
      status.textContent = [status.textContent, fallback].filter(Boolean).join(" ");
    }
    return true;
  }

  function paintBadge() {
    badge.textContent = badgeIncomplete ? "?" : actionable ? `${actionable}${badgeMore ? "+" : ""}` : "";
    badge.hidden = !badgeIncomplete && actionable === 0;
    entry.setAttribute("aria-label", badgeIncomplete ? "Updates, some sources are unavailable"
      : actionable ? `Updates, ${badgeMore ? "at least " : ""}${actionable} loaded updates need you${badgeMore ? ", more available" : ""}` : "Updates");
  }
  function paintPaging() {
    summary.textContent = `${visible(items, filter).length} loaded${hasMore ? " · More available" : ""}${filter === "saved" ? ` · ${items.length} checked` : ""}`;
    partial.textContent = incomplete ? "Some update sources are unavailable. This list may be incomplete." : "";
    loadMore.hidden = !hasMore && !incomplete;
    loadMore.disabled = loading;
    loadMore.textContent = hasMore && cursor ? "Load more" : "Refresh updates";
    list.setAttribute("aria-busy", loading ? "true" : "false");
  }
  function paintOperations() {
    for (const row of list.querySelectorAll("[data-update-id]")) {
      const operation = operations.get(row.dataset.updateId);
      for (const button of row.querySelectorAll("[data-update-action]")) {
        const action = button.dataset.updateAction;
        const label = `${operation?.action === action ? (operation.busy ? "Checking " : "Retry ") : ""}${ACTION_LABELS[action]}`;
        button.textContent = label;
        button.setAttribute("aria-label", `${label} ${items.find(item => item.id === row.dataset.updateId)?.title || "update"}`);
        button.disabled = loading || (!!operation && (operation.action !== action || (operation.busy && action !== "open")));
      }
    }
  }
  function paint() {
    for (const button of tabs.querySelectorAll("[role=tab]")) {
      const on = button.dataset.updateFilter === filter;
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
    }
    list.replaceChildren();
    const rows = [...visible(items, filter)];
    // A committed-but-lost Done may have left this filter. Keep only a neutral
    // recovery control, not cached source text that a fresh read no longer lists.
    for (const [id] of operations) {
      if (!rows.some(item => item.id === id)) rows.push({ id, title: "Earlier update action", kind: "pending_action", state: "unconfirmed" });
    }
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty-note";
      empty.textContent = incomplete ? "No matching updates are loaded yet. Some sources are unavailable."
        : hasMore ? "No matching updates in the loaded pages yet."
          : filter === "needs" ? "Nothing needs you." : "Nothing in this filter.";
      list.append(empty); paintPaging();
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
      for (const [name, label] of Object.entries(ACTION_LABELS)) {
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
    paintOperations(); paintPaging();
  }
  async function load(next = filter, { append = false, budget = next === filter ? Math.max(1, loadedPages) : 1, notice = "" } = {}) {
    const owned = currentContext();
    if (!owned || (append && (loading || !hasMore || !cursor))) return false;
    const mine = ++ticket;
    const current = () => mine === ticket && owns(owned);
    const pageBudget = Number.isSafeInteger(budget) && budget > 0 ? budget : 1;
    const startCursor = append ? cursor : null;
    const priorItems = append ? items : [];
    loading = true; paintOperations(); paintPaging(); status.textContent = "Loading updates…";
    const partialSources = page => Object.values(page?.incompleteSources ?? {}).some(Boolean);
    const readWindow = async () => {
      const merged = new Map(priorItems.map(item => [item.id, item]));
      const seen = append ? new Set(visitedCursors) : new Set();
      let after = startCursor, more = false, unavailable = append && incomplete;
      let pages = append ? loadedPages : 0, stalled = false;
      // Explicit append reads one page. A return/refresh may replay only the
      // already browsed budget, never crawl until an old item count is filled.
      for (let step = 0; step < (append ? 1 : pageBudget); step++) {
        const page = await client.roomRead(`/updates?${queryFor(next)}&limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
        if (!page || !current()) return null;
        if (!Array.isArray(page.items)) throw new Error("Could not read this Updates page.");
        let progressed = false;
        for (const item of page.items) {
          if (!item || typeof item.id !== "string") throw new Error("Could not read this Updates page.");
          const previous = merged.get(item.id);
          if (!previous || previous.basisToken !== item.basisToken) progressed = true;
          merged.set(item.id, item);
        }
        pages++; unavailable ||= partialSources(page); more = page.hasMore === true;
        const following = typeof page.cursor === "string" && page.cursor ? page.cursor : null;
        if (more && (!following || seen.has(following) || !progressed)) {
          after = null; stalled = true; break;
        }
        after = more ? following : null;
        if (!more) break;
        seen.add(after);
      }
      return { items: [...merged.values()], cursor: after, hasMore: more, incomplete: unavailable, pages, stalled, seen };
    };
    try {
      const [window, needs] = await Promise.all([
        readWindow(), next === "needs" ? null : client.roomRead("/updates?state=actionable&limit=100")
      ]);
      if (!window || !current() || (next !== "needs" && !needs)) return false;
      filter = next; items = window.items; cursor = window.cursor; hasMore = window.hasMore;
      loadedPages = window.pages; incomplete = window.incomplete; visitedCursors = window.seen;
      const counted = next === "needs" ? window : needs;
      actionable = (counted.items ?? []).filter(item => item.state === "unread" || item.state === "read").length;
      badgeMore = counted.hasMore === true;
      badgeIncomplete = next === "needs" ? incomplete : partialSources(counted);
      loading = false; paintBadge(); paint();
      status.textContent = window.stalled ? "Loading stopped because the page did not advance. Refresh updates to continue." : notice;
      return true;
    } catch (error) {
      if (!current()) return false;
      if (error?.code === "cursor_stale" && (append || pageBudget > 1)) {
        // One fresh first-page restart, not an unbounded replay of changed pages.
        return load(next, { budget: 1, notice: "The list changed. Showing the newest updates; load more to continue." });
      }
      status.textContent = error?.message || "Could not load updates. Try again.";
      return false;
    } finally {
      if (current()) { loading = false; paintOperations(); paintPaging(); }
    }
  }
  async function mark(item, action) {
    const owned = currentContext();
    if (!owned) return;
    let operation = operations.get(item.id);
    if (operation && operation.action !== action) {
      status.textContent = "Confirm the earlier action before choosing another.";
      return;
    }
    if (!operation) {
      if (!validBasis(item.basisToken)) {
        status.textContent = "Refresh Updates before marking this item.";
        return;
      }
      operation = { requestId: crypto.randomUUID(), expectedBasis: item.basisToken, action,
        item: { ...item, sourceRef: { ...item.sourceRef } }, busy: false, flight: 0 };
      operations.set(item.id, operation);
    }
    const mine = ++interaction, flight = ++operation.flight;
    const origin = capture(item.id, action);
    const path = action === "open" ? "read" : action;
    const current = () => mine === interaction && owns(owned) && dialog.open;
    operation.busy = true; paintOperations(); status.textContent = "";
    let result;
    try {
      result = await client.roomWrite(`/updates/${encodeURIComponent(operation.item.id)}/${path}`,
        { requestId: operation.requestId, expectedBasis: operation.expectedBasis });
    } catch (error) {
      if (!current()) return;
      if (["update_changed", "update_basis_required", "invalid_update", "update_not_found", "idempotency_conflict"].includes(error?.code)) {
        operations.delete(item.id);
        await load();
        if (current()) status.textContent = error.code === "update_changed"
          ? "This update changed. Review it before acting again."
          : "That action could not be applied. Review the refreshed update before acting.";
        return;
      }
      throw error;
    } finally {
      if (owns(owned) && operations.get(item.id) === operation && operation.flight === flight) {
        operation.busy = false;
        if (dialog.open) paintOperations();
      }
    }
    if (!result || !current()) return;
    // A valid session echo alone does not bind a response to this row or click.
    if (result.requestId !== operation.requestId || result.item?.id !== operation.item.id
        || result.item?.roomId !== operation.item.roomId || result.item?.basisToken !== operation.expectedBasis
        || JSON.stringify(result.item?.sourceRef) !== JSON.stringify(operation.item.sourceRef)) {
      status.textContent = "Could not confirm that action. Retry it to check the same update.";
      return;
    }
    operations.delete(item.id);
    const latest = items.find(entry => entry.id === item.id);
    if (latest?.basisToken !== operation.expectedBasis) {
      if (!latest) {
        paint();
        tabs.querySelector(`[data-update-filter="${filter}"]`)?.focus();
      } else paintOperations();
      status.textContent = latest ? "Earlier action confirmed. This update changed; review it before acting again."
        : "Earlier action confirmed. That update is no longer in this list.";
      return;
    }
    if (action === "open") {
      const workItemId = operation.item.sourceRef?.workItemId;
      const messageId = operation.item.sourceRef?.messageId;
      const opened = workItemId && onOpenWork ? onOpenWork(workItemId, origin)
        : messageId && onOpenMessage ? onOpenMessage(messageId, origin) : null;
      if (opened === false) { paintOperations(); status.textContent = "That source is no longer available in this room."; return; }
      dialog.close();
      if (opened !== true && messageId) {
        const row = document.querySelector(`[data-message-record-id="${CSS.escape(messageId)}"]`);
        row?.scrollIntoView({ block: "nearest" });
        if (row instanceof HTMLElement) row.focus({ preventScroll: true });
      }
      return;
    }
    await load();
  }
  function open(next = "needs") {
    if (!currentContext()) return;
    cancelPending();
    if (!dialog.open) dialog.showModal();
    const tab = tabs.querySelector(`[data-update-filter="${next}"]`);
    tab?.focus();
    void load(next);
  }
  loadMore.addEventListener("click", () => {
    if (loading) return;
    cancelPending();
    void load(filter, hasMore && cursor ? { append: true } : { budget: 1 });
  });
  entry.addEventListener("click", () => open(filter));
  dialog.querySelector("#updates-close").addEventListener("click", () => { cancelPending(); dialog.close(); });
  dialog.addEventListener("cancel", cancelPending);
  tabs.addEventListener("click", event => {
    const button = event.target.closest("[data-update-filter]");
    if (button) { cancelPending(); void load(button.dataset.updateFilter); }
  });
  tabs.addEventListener("keydown", event => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...tabs.querySelectorAll("[role=tab]")];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = buttons[(index + step + buttons.length) % buttons.length];
    cancelPending(); next.focus();
    void load(next.dataset.updateFilter);
  });
  list.addEventListener("click", event => {
    const button = event.target.closest("[data-update-action]");
    const row = event.target.closest("[data-update-id]");
    if (!button || !row) return;
    const item = items.find(entry => entry.id === row.dataset.updateId) ?? operations.get(row.dataset.updateId)?.item;
    if (!item) return;
    const owned = context();
    void mark(item, button.dataset.updateAction).catch(error => {
      if (owns(owned) && dialog.open) status.textContent = error?.message || "Could not confirm that action. Retry it to check the same update.";
    });
  });
  const main = document.querySelector("#main");
  if (main) {
    new MutationObserver(() => { if (main.hidden) reset(); else void load(filter); })
      .observe(main, { attributes: true, attributeFilter: ["hidden"] });
  }
  paintBadge();
  return { open, restore, reset, cancelPending, close() { cancelPending(); if (dialog.open) dialog.close(); }, openAction(id) { const next = PALETTE[id]; if (!next) return false; open(next); return true; } };
}
