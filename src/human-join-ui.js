import { uiText } from "./strings.js";
// Account-bound join requests. No agent credential or identity is created.
export function createHumanJoinUI({ accountClient, container, onJoined }) {
  let owner = null, epoch = 0, readGeneration = 0, timer = null, selected = null, operation = null;
  const doc = container.ownerDocument;
  const element = (tag, text, attrs = {}) => {
    const node = doc.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const owns = ticket => ticket === epoch && owner === accountClient.session && owner?.authenticated;
  function invalidateReads() { readGeneration++; clearTimeout(timer); }
  function reset() { invalidateReads(); epoch++; owner = null; selected = null; operation = null; clearTimeout(timer); container.replaceChildren(); container.hidden = true; }
  function status(text, error = false) { container.querySelector("[data-join-error]")?.remove(); container.hidden = false; const node = element("p", text, { role: error ? "alert" : "status", class: "form-hint" }); node.dataset.joinError = ""; container.append(node); }
  function schedule(ticket, pending) {
    clearTimeout(timer);
    if (pending && owns(ticket)) timer = setTimeout(() => { if (!doc.hidden && owns(ticket)) refresh(); else schedule(ticket, true); }, 15000);
  }
  async function refresh() {
    if (!owner) owner = accountClient.session;
    const ticket = epoch; if (!owns(ticket)) return;
    const generation = ++readGeneration;
    const ownsRead = () => owns(ticket) && generation === readGeneration;
    if (!container.querySelector("[data-join-refresh]")) {
      const check = element("button", uiText("rooms.join.refresh"), { type: "button", class: "button ghost", "data-join-refresh": "" });
      check.addEventListener("click", refresh); container.append(check);
    }
    try {
      const result = await accountClient.request("/api/account-join-requests", { session: owner });
      if (!ownsRead()) return;
      container.querySelector("[data-join-error]")?.remove();
      const existing = container.querySelector("[data-join-status]"); existing?.remove();
      const list = element("div", "", { "data-join-status": "" });
      const rows = (result.requests ?? []).filter(row => !selected || row.roomId === selected.roomId);
      for (const row of rows) {
        const item = element("div", "", { class: "account-room-row" });
        const label = { pending: uiText("rooms.join.pending"), unavailable: uiText("rooms.join.unavailable"), approved: uiText("rooms.join.approved"), denied: uiText("rooms.join.denied"), cancelled: uiText("rooms.join.cancelled"), expired: uiText("rooms.join.expired") }[row.status] ?? uiText("rooms.join.checking");
        item.append(element("p", uiText("rooms.join.status", { room: row.roomId, status: label })));
        if (["pending", "unavailable"].includes(row.status)) {
          const cancel = element("button", uiText("rooms.join.cancel"), { type: "button", class: "button ghost" });
          cancel.addEventListener("click", async () => {
            if (!owns(ticket)) return; invalidateReads(); cancel.disabled = true;
            try { await accountClient.request(`/api/account-join-requests/${encodeURIComponent(row.requestId)}/cancel`, { method: "POST", session: owner, data: { expectedRevision: row.revision } }); if (owns(ticket)) await refresh(); }
            catch { if (owns(ticket)) { status(uiText("rooms.join.cancelError"), true); cancel.disabled = false; } }
          }); item.append(cancel);
        } else if (row.status === "approved") {
          const open = element("button", uiText("rooms.join.open"), { type: "button", class: "button primary" });
          open.addEventListener("click", () => { if (owns(ticket)) onJoined?.(row.roomId); }); item.append(open);
        }
        list.append(item);
      }
      container.append(list);
      if (rows.length) container.hidden = false;
      schedule(ticket, rows.some(row => row.status === "pending"));
    } catch { if (ownsRead()) status(uiText("rooms.join.readError"), true); }
  }
  function open(roomId, title) {
    reset(); owner = accountClient.session;
    if (!owner?.authenticated) return;
    selected = { roomId }; container.hidden = false;
    container.append(element("h3", uiText("rooms.join.title", { title: title || roomId })));
    const form = element("form");
    const name = element("input", "", { name: "displayName", required: "", maxlength: "80", autocomplete: "name" });
    const nameLabel = element("label", uiText("rooms.join.name")); nameLabel.append(name);
    const note = element("textarea", "", { name: "note", maxlength: "1000", rows: "2" });
    const noteLabel = element("label", uiText("rooms.join.note")); noteLabel.append(note);
    const submit = element("button", uiText("rooms.join.request"), { type: "submit", class: "button primary" });
    const check = element("button", uiText("rooms.join.refresh"), { type: "button", class: "button ghost", "data-join-refresh": "" }); check.addEventListener("click", refresh);
    form.append(nameLabel, noteLabel, submit); container.append(form, check);
    form.addEventListener("submit", async event => {
      event.preventDefault(); const ticket = epoch; if (!owns(ticket) || submit.disabled) return;
      const data = { roomId, displayName: name.value.trim(), note: note.value.trim() };
      const fingerprint = JSON.stringify(data);
      if (!operation || operation.fingerprint !== fingerprint) operation = { fingerprint, data: { ...data, requestId: ["humanjoin", crypto.randomUUID()].join("-") } };
      invalidateReads(); submit.disabled = true;
      try {
        await accountClient.request("/api/account-join-requests", { method: "POST", session: owner, data: operation.data });
        if (!owns(ticket)) return; form.hidden = true; await refresh();
      } catch (error) {
        if (!owns(ticket)) return;
        status(error.code === "join_pending" ? uiText("rooms.join.alreadyPending") : uiText("rooms.join.sendError"), true);
        submit.disabled = false; await refresh();
      }
    });
    refresh(); name.focus();
  }
  return { open, refresh, reset };
}
