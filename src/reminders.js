import { terminalWork } from "./workflow.js";
import { reminderTime, formatReminderTime } from "./reminder-time.js";

export function installReminders({ client, getState, onSaved }) {
  const $ = id => document.getElementById(id), dialog = $("reminder-dialog");
  const pending = new Map(); // Unknown outcomes keep the exact request until retry or identity loss.
  let owner = null, serial = 0, rows = [], anchor = null, timer = null, signature = "", entry = null, flight = null, saving = false, loading = false, error = "";
  const owns = ticket => ticket && owner === ticket && client.generation === ticket.generation
    && client.session === ticket.session && client.ownsAccountSession();
  const now = () => anchor ? anchor.at + performance.now() - anchor.received : Date.now();
  const rowFor = id => rows.find(row => row.workItemId === id);
  const status = text => { $("reminder-status").textContent = text; $("reminder-status").classList.toggle("visible", Boolean(text)); };
  function restoreFocus(key) {
    const replacement = [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key && node.checkVisibility());
    (replacement ?? document.querySelector("#return-brief-panel > summary"))?.focus({ preventScroll: true });
  }
  function close() {
    if (saving) return;
    const focusKey = entry?.focusKey;
    entry = null; dialog.close(); status(""); $("reminder-work-title").textContent = "";
    if (focusKey) restoreFocus(focusKey);
  }
  function reset() {
    serial++; clearTimeout(timer); timer = null; owner = null; entry = null; flight = null; anchor = null; rows = []; signature = "";
    saving = loading = false; error = ""; pending.clear(); dialog.close(); $("reminder-form").reset();
    $("reminder-work-title").textContent = ""; $("reminder-preview").textContent = ""; $("reminder-current").textContent = ""; status("");
    for (const id of ["reminder-due", "reminder-upcoming", "reminder-pending"]) { $(id).replaceChildren(); delete $(id).dataset.signature; }
    $("reminder-count").textContent = ""; $("reminder-count").hidden = true; $("reminder-panel").hidden = true;
    $("reminder-load-error").textContent = ""; $("reminder-scheduled").open = false;
  }
  function controls() {
    const locked = saving || loading || pending.has(entry?.workId);
    $("reminder-choice").disabled = locked; $("reminder-custom").disabled = locked;
    $("reminder-save").disabled = saving || loading;
    $("reminder-save").textContent = pending.get(entry?.workId)?.action === "cancel" ? "Retry removal" : pending.has(entry?.workId) ? "Retry save" : "Save";
    $("reminder-close").disabled = saving;
    $("reminder-cancel").hidden = rowFor(entry?.workId)?.state !== "active";
    $("reminder-cancel").disabled = locked;
    $("reminder-form").setAttribute("aria-busy", String(saving || loading));
  }
  function preview() {
    $("reminder-custom-label").hidden = $("reminder-choice").value !== "custom";
    const at = pending.get(entry?.workId)?.dueAt ?? reminderTime($("reminder-choice").value, now(), $("reminder-custom").value);
    if (entry) entry.chosenAt = at;
    $("reminder-preview").textContent = formatReminderTime(at);
    $("reminder-preview").hidden = pending.get(entry?.workId)?.action === "cancel";
    const row = rowFor(entry?.workId);
    $("reminder-current").textContent = row?.state === "active" ? `Scheduled: ${formatReminderTime(row.dueAt)}` : "";
  }
  function renderList(id, items) {
    const list = $(id), state = getState();
    const next = JSON.stringify(items.map(row => [row.workItemId, row.dueAt, row.revision, pending.has(row.workItemId), state.workItems[row.workItemId]?.title]));
    if (list.dataset.signature === next) return;
    list.dataset.signature = next;
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    list.replaceChildren(...items.map(row => {
      const li = document.createElement("li"), link = document.createElement("a"), time = document.createElement("small"), button = document.createElement("button");
      link.href = `#pr-record/work/${encodeURIComponent(row.workItemId)}`; link.dataset.openWork = row.workItemId;
      link.dataset.focusKey = `reminder-link:${row.workItemId}`;
      link.textContent = state.workItems[row.workItemId]?.title ?? "Work";
      time.textContent = formatReminderTime(row.dueAt);
      button.type = "button"; button.className = "button ghost"; button.textContent = pending.has(row.workItemId) ? "Review retry" : "Change";
      button.setAttribute("aria-label", `${button.textContent}: ${link.textContent}`);
      button.dataset.reminderWork = row.workItemId; button.dataset.focusKey = `reminder-manage:${row.workItemId}`;
      li.append(link, time, button); return li;
    }));
    if (focusKey) restoreFocus(focusKey);
  }
  function render() {
    if (!owns(owner) || !getState()) return;
    const active = rows.filter(row => !pending.has(row.workItemId) && row.state === "active" && getState().workItems[row.workItemId] && !terminalWork(getState().workItems[row.workItemId])).sort((a, b) => a.dueAt - b.dueAt || a.workItemId.localeCompare(b.workItemId));
    const unresolved = [...pending.values()].map(request => ({ workItemId: request.workItemId, revision: request.expectedRevision, dueAt: request.dueAt ?? rowFor(request.workItemId)?.dueAt }));
    const at = now(), due = active.filter(row => row.dueAt <= at), future = active.filter(row => row.dueAt > at);
    $("reminder-panel").hidden = !active.length && !unresolved.length && !error;
    $("reminder-count").hidden = !due.length && !unresolved.length;
    $("reminder-count").textContent = [due.length ? `${due.length} reminder${due.length === 1 ? "" : "s"}` : "", unresolved.length ? `${unresolved.length} save${unresolved.length === 1 ? "" : "s"} to confirm` : ""].filter(Boolean).join(" · ");
    $("reminder-pending-heading").hidden = !unresolved.length;
    $("reminder-due-heading").hidden = !due.length; $("reminder-scheduled").hidden = !future.length;
    $("reminder-scheduled-heading").textContent = `Scheduled (${future.length})`;
    $("reminder-load-error").textContent = error; $("reminder-refresh").hidden = !error;
    renderList("reminder-due", due); renderList("reminder-upcoming", future);
    renderList("reminder-pending", unresolved);
    clearTimeout(timer); timer = null;
    if (document.visibilityState !== "hidden" && active.length) timer = setTimeout(() => { render(); void load(); }, Math.max(100, Math.min(60000, (future[0]?.dueAt ?? at + 60000) - at)));
  }
  function apply(result) {
    rows = result.reminders; anchor = { at: result.evaluatedAt, received: performance.now() }; error = ""; render();
  }
  function load() {
    const ticket = owner;
    if (!owns(ticket) || saving) return Promise.resolve(false);
    if (flight?.owner === ticket) { flight.again = true; return flight.promise; }
    const current = { owner: ticket, again: false }; flight = current;
    const request = ++serial; loading = true; controls();
    current.promise = (async () => {
      try {
        do {
          current.again = false;
          const result = await client.reminders();
          if (!owns(ticket) || request !== serial || !result) return false;
          apply(result);
        } while (current.again);
        return true;
      } catch {
        if (owns(ticket) && request === serial) { error = "Reminders could not refresh. Times may be out of date."; render(); }
        return false;
      } finally {
        if (flight === current) flight = null;
        if (owns(ticket) && request === serial) { loading = false; controls(); }
      }
    })();
    return current.promise;
  }
  function sync() {
    if (!client.session || !client.ownsAccountSession() || !getState()) { reset(); return; }
    if (!owns(owner)) { reset(); owner = { generation: client.generation, session: client.session }; }
    const next = JSON.stringify(Object.values(getState().workItems).map(work => [work.id, work.revision]));
    if (next !== signature) { signature = next; void load(); }
    render();
  }
  document.addEventListener("click", async event => {
    const button = event.target.closest("[data-reminder-work]");
    if (!button || !owns(owner) || saving) return;
    const workId = button.dataset.reminderWork, work = getState()?.workItems[workId];
    if ((!work || terminalWork(work)) && !pending.has(workId)) return;
    close(); entry = { owner, workId, focusKey: button.dataset.focusKey, revision: null };
    const ticket = entry;
    $("reminder-form").reset(); $("reminder-work-title").textContent = work?.title ?? "Work"; status("Loading…"); dialog.showModal(); preview(); controls();
    const loaded = await load();
    if (entry !== ticket || !owns(ticket.owner)) return;
    ticket.revision = loaded ? rowFor(workId)?.revision ?? 0 : null;
    status(pending.has(workId) ? "Save not confirmed. Retry the same request." : loaded ? "" : "Could not load your reminder. Close and try again.");
    controls(); preview();
  });
  async function save(action) {
    const ticket = entry;
    if (!ticket || !owns(ticket.owner) || saving || loading) return;
    let request = pending.get(ticket.workId);
    if (!request) {
      if (ticket.revision === null) { status("Close and reopen to load your reminder."); return; }
      request = { requestId: crypto.randomUUID(), workItemId: ticket.workId, expectedRevision: ticket.revision, action };
      if (action === "schedule") {
        request.dueAt = ticket.chosenAt;
        if (!Number.isSafeInteger(request.dueAt) || request.dueAt <= now()) { status("Choose a valid future local time."); return; }
      }
    }
    pending.set(ticket.workId, request); saving = true; ++serial; controls(); status("Saving…");
    try {
      const result = await client.reminders(request);
      if (entry !== ticket || !owns(ticket.owner) || !result) return;
      apply(result); pending.delete(ticket.workId); saving = false; close();
      const current = result.reminders.find(row => row.workItemId === request.workItemId);
      onSaved(current?.state === "active" ? "Reminder saved." : "No active reminder.");
    } catch (failure) {
      if (entry !== ticket || !owns(ticket.owner)) return;
      const uncertain = !Number.isSafeInteger(failure.status) || failure.status >= 500;
      if (!uncertain) pending.delete(ticket.workId);
      status(uncertain ? "Save not confirmed. Retry the same request." : failure.message + (failure.status === 409 ? " Close and reopen to review." : ""));
      // Never silently rebase a stale edit. Reopening loads the new revision.
      if (failure.status === 409) ticket.revision = null;
    } finally { if (owns(ticket.owner)) { saving = false; controls(); render(); } }
  }
  $("reminder-form").addEventListener("submit", event => { event.preventDefault(); void save("schedule"); });
  $("reminder-cancel").addEventListener("click", () => void save("cancel"));
  $("reminder-close").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  for (const id of ["reminder-choice", "reminder-custom"]) $(id).addEventListener("input", preview);
  for (const id of ["reminder-refresh", "rb-refresh-button"]) $(id).addEventListener("click", () => void load());
  $("return-brief-panel").addEventListener("toggle", () => { if ($("return-brief-panel").open) void load(); });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer); timer = null;
    if (document.visibilityState !== "hidden") void load();
  });
  return { reset, sync, hasPending: () => pending.size > 0 };
}
