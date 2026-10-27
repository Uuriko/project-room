// Account-bound join requests. No agent credential or identity is created.
export function createHumanJoinUI({ accountClient, container, onJoined }) {
  let owner = null, epoch = 0, timer = null, selected = null, operation = null;
  const doc = container.ownerDocument;
  const element = (tag, text, attrs = {}) => {
    const node = doc.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const owns = ticket => ticket === epoch && owner === accountClient.session && owner?.authenticated;
  function reset() { epoch++; owner = null; selected = null; operation = null; clearTimeout(timer); container.replaceChildren(); container.hidden = true; }
  function status(text, error = false) { container.querySelector("[data-join-error]")?.remove(); container.hidden = false; const node = element("p", text, { role: error ? "alert" : "status", class: "form-hint" }); node.dataset.joinError = ""; container.append(node); }
  function schedule(ticket, pending) {
    clearTimeout(timer);
    if (pending && owns(ticket)) timer = setTimeout(() => { if (!doc.hidden && owns(ticket)) refresh(); else schedule(ticket, true); }, 15000);
  }
  async function refresh() {
    if (!owner) owner = accountClient.session;
    const ticket = epoch; if (!owns(ticket)) return;
    if (!container.querySelector("[data-join-refresh]")) {
      const check = element("button", "Refresh status", { type: "button", class: "button ghost", "data-join-refresh": "" });
      check.addEventListener("click", refresh); container.append(check);
    }
    try {
      const result = await accountClient.request("/api/account-join-requests", { session: owner });
      if (!owns(ticket)) return;
      container.querySelector("[data-join-error]")?.remove();
      const existing = container.querySelector("[data-join-status]"); existing?.remove();
      const list = element("div", "", { "data-join-status": "" });
      const rows = (result.requests ?? []).filter(row => !selected || row.roomId === selected.roomId);
      for (const row of rows) {
        const item = element("div", "", { class: "account-room-row" });
        const label = { pending: "Waiting for approval", unavailable: "Room is no longer accepting requests", approved: "Approved", denied: "Request declined", cancelled: "Request cancelled", expired: "Request expired" }[row.status] ?? "Checking request";
        item.append(element("p", `${row.roomId} · ${label}`));
        if (["pending", "unavailable"].includes(row.status)) {
          const cancel = element("button", "Cancel request", { type: "button", class: "button ghost" });
          cancel.addEventListener("click", async () => {
            if (!owns(ticket)) return; cancel.disabled = true;
            try { await accountClient.request(`/api/account-join-requests/${encodeURIComponent(row.requestId)}/cancel`, { method: "POST", session: owner, data: { expectedRevision: row.revision } }); if (owns(ticket)) await refresh(); }
            catch { if (owns(ticket)) { status("Couldn’t cancel. Refresh to check the request.", true); cancel.disabled = false; } }
          }); item.append(cancel);
        } else if (row.status === "approved") {
          const open = element("button", "Open room", { type: "button", class: "button primary" });
          open.addEventListener("click", () => { if (owns(ticket)) onJoined?.(row.roomId); }); item.append(open);
        }
        list.append(item);
      }
      container.append(list);
      if (rows.length) container.hidden = false;
      schedule(ticket, rows.some(row => row.status === "pending"));
    } catch { if (owns(ticket)) status("Couldn’t check your requests. Try again.", true); }
  }
  function open(roomId, title) {
    reset(); owner = accountClient.session;
    if (!owner?.authenticated) return;
    selected = { roomId }; container.hidden = false;
    container.append(element("h3", `Request to join ${title || roomId}`));
    const form = element("form");
    const name = element("input", "", { name: "displayName", required: "", maxlength: "80", autocomplete: "name" });
    const nameLabel = element("label", "Your name"); nameLabel.append(name);
    const note = element("textarea", "", { name: "note", maxlength: "1000", rows: "2" });
    const noteLabel = element("label", "Note (optional)"); noteLabel.append(note);
    const submit = element("button", "Request access", { type: "submit", class: "button primary" });
    const check = element("button", "Refresh status", { type: "button", class: "button ghost", "data-join-refresh": "" }); check.addEventListener("click", refresh);
    form.append(nameLabel, noteLabel, submit); container.append(form, check);
    form.addEventListener("submit", async event => {
      event.preventDefault(); const ticket = epoch; if (!owns(ticket) || submit.disabled) return;
      const data = { roomId, displayName: name.value.trim(), note: note.value.trim() };
      const fingerprint = JSON.stringify(data);
      if (!operation || operation.fingerprint !== fingerprint) operation = { fingerprint, data: { ...data, requestId: "humanjoin-" + crypto.randomUUID() } };
      submit.disabled = true;
      try {
        await accountClient.request("/api/account-join-requests", { method: "POST", session: owner, data: operation.data });
        if (!owns(ticket)) return; form.hidden = true; await refresh();
      } catch (error) {
        if (!owns(ticket)) return;
        status(error.code === "join_pending" ? "A request is already pending. Check its status below." : "Couldn’t send the request. Retry to confirm it.", true);
        submit.disabled = false; await refresh();
      }
    });
    refresh(); name.focus();
  }
  return { open, refresh, reset };
}
