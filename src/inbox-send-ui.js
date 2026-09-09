// Contextual private reply controls. Only the explicitly enabled local simulator
// is exposed; no global composer shortcut can submit an external-style reply.
export function installInboxSend({ api, ownerKey, reviewChanges }) {
  const $ = id => document.getElementById(id), states = new Map();
  const storageKey = "project-room:pending-private-send:v1";
  let storage; try { storage = sessionStorage; } catch {}
  let sourceId = null, draft = null, generation = 0, preview = null, modalTurn = 0;
  const state = id => {
    if (!states.has(id)) states.set(id, { sends: [], loaded: false, available: false, busy: false, pending: null, uncertain: false, note: "", turn: 0 });
    return states.get(id);
  };
  function pending() {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
      if (saved?.owner === ownerKey() && Array.isArray(saved.requests)) return saved.requests.filter(r =>
        ["send.reserve", "send.cancel"].includes(r?.action) && typeof r.sourceId === "string" && typeof r.requestId === "string");
    } catch {}
    return [];
  }
  function retain(id, request) {
    state(id).pending = request;
    try {
      const requests = pending().filter(r => r.sourceId !== id); if (request) requests.push(request);
      if (!storage) return false;
      requests.length ? storage.setItem(storageKey, JSON.stringify({ owner: ownerKey(), requests })) : storage.removeItem(storageKey);
      return true;
    } catch { return false; }
  }
  const latest = s => s.sends.at(-1);
  const clean = () => draft && !draft.dirty && !draft.busy && !draft.pending && !draft.conflict
    && draft.reviewedSource === draft.source.revision && draft.body.trim();
  function render() {
    if (!sourceId || !ownerKey()) return;
    const s = state(sourceId), send = latest(s), unresolved = send && ["queued", "unknown"].includes(send.status);
    const already = send && !["cancelled", "rejected"].includes(send.status)
      && send.envelope.draftRevision === draft?.base?.revision && send.envelope.sourceRevision === draft?.source.revision;
    $("inbox-send-panel").hidden = !s.loaded || (!s.available && !s.sends.length && !s.pending);
    $("inbox-save").hidden = s.available && !draft?.dirty && !draft?.pending && !draft?.busy && !draft?.conflict;
    $("inbox-send-preview").hidden = !s.available || Boolean(unresolved || s.pending || already || s.uncertain);
    $("inbox-send-preview").disabled = s.busy || !clean();
    $("inbox-send-check").hidden = !s.pending && !s.uncertain && (!send || !["unknown", "accepted"].includes(send.status));
    $("inbox-send-check").disabled = s.busy || (!s.pending && !s.available);
    $("inbox-send-resume").hidden = Boolean(s.pending || s.uncertain) || send?.status !== "queued";
    $("inbox-send-resume").disabled = s.busy || !s.available;
    $("inbox-send-cancel").hidden = Boolean(s.pending || s.uncertain) || send?.status !== "queued";
    $("inbox-send-cancel").disabled = s.busy;
    $("inbox-send-view").hidden = !send || Boolean(unresolved);
    $("inbox-send-view").disabled = s.busy;
    const labels = { queued: "Sample reply ready · not sent", unknown: "Sample outcome unknown", accepted: "Sample accepted · delivery unconfirmed",
      delivered: "Sample delivered", rejected: "Sample rejected · not sent", bounced: "Sample delivery failed", cancelled: "Sample cancelled · not sent" };
    const previous = send && (send.envelope.draftRevision !== draft?.base?.revision || send.envelope.body !== draft?.body);
    $("inbox-send-status").textContent = s.note || (s.pending ? "Reply unconfirmed. Check status." : send
      ? previous ? "Previous " + labels[send.status].toLowerCase() : labels[send.status] : "");
  }
  async function load(id) {
    if (!ownerKey()) return;
    const s = state(id), owner = ownerKey(), turn = ++s.turn, gen = generation;
    s.pending ??= pending().find(r => r.sourceId === id) ?? null;
    try {
      const value = await api.sends(id);
      if (gen !== generation || owner !== ownerKey() || turn !== s.turn) return;
      if (s.sends.some(prior => !value.sends.some(next => next.id === prior.id && next.revision >= prior.revision)))
        throw new Error("Previously recorded reply is missing or older");
      s.sends = value.sends; s.available = value.simulationAvailable; s.loaded = true; s.uncertain = false; s.note = "";
    } catch {
      if (gen !== generation || owner !== ownerKey() || turn !== s.turn) return;
      s.loaded = true; s.note = "Couldn’t check replies. Refresh to retry.";
      s.uncertain = s.sends.length > 0 || s.uncertain;
      if (id === sourceId) render();
      return false;
    }
    if (id === sourceId) render();
    return true;
  }
  function showEnvelope(value, canSend) {
    preview = value;
    $("inbox-send-addresses").textContent = value.from + " → " + value.to.join(", ");
    $("inbox-send-subject").textContent = value.subject;
    $("inbox-send-body").textContent = value.body;
    $("inbox-send-confirm").hidden = !canSend;
    $("inbox-send-confirm").disabled = !canSend;
  }
  async function open(existing = false, readOnly = false) {
    if (!sourceId || !ownerKey()) return;
    const id = sourceId, s = state(id), owner = ownerKey(), turn = ++modalTurn;
    if (s.busy || s.pending || (!existing && !clean())) return;
    preview = null; $("inbox-send-dialog").showModal();
    for (const key of ["inbox-send-addresses", "inbox-send-subject", "inbox-send-body"]) $(key).textContent = "";
    $("inbox-send-confirm").hidden = readOnly; $("inbox-send-confirm").disabled = true;
    $("inbox-send-dialog-status").textContent = "Loading…";
    try {
      const value = existing ? { preview: latest(s).envelope, simulationAvailable: s.available } : await api.sendContext(id);
      if (owner !== ownerKey() || turn !== modalTurn || id !== sourceId || !$("inbox-send-dialog").open) return;
      const p = value.preview;
      const unchanged = clean() && draft.base?.revision === p.draftRevision && draft.source.revision === p.sourceRevision && draft.body === p.body;
      showEnvelope(p, !readOnly && value.simulationAvailable && unchanged);
      $("inbox-send-dialog-status").textContent = readOnly ? "Previous sample reply" : !value.simulationAvailable ? "Sample sending is unavailable here."
        : !unchanged ? "Reply changed. Close and review your draft." : "Simulation only · no one will be contacted";
      if (!existing && !unchanged) await reviewChanges();
    } catch {
      if (owner === ownerKey() && turn === modalTurn) $("inbox-send-dialog-status").textContent = "Couldn’t verify this reply. Close and try again.";
    }
  }
  async function act(kind) {
    const id = sourceId, s = state(id), owner = ownerKey(), gen = generation, p = preview;
    if (!owner || s.busy || kind === "send" && (!p || !clean())) return;
    s.busy = true; s.note = kind === "check" ? "Checking…" : "Working…"; render();
    $("inbox-send-confirm").disabled = true;
    let retained = true;
    try {
      let send = latest(s);
      if (s.pending) {
        await api.apply(s.pending);
        if (owner !== ownerKey() || gen !== generation) return;
        retain(id, null);
        // A recovered reservation is not a second implicit Send click.
        await load(id); return;
      }
      if (kind === "cancel") {
        const request = { action: "send.cancel", requestId: crypto.randomUUID(), sourceId: id, sendId: send.id, expectedRevision: send.revision };
        retained = retain(id, request); await api.apply(request);
        if (owner !== ownerKey() || gen !== generation) return;
        retain(id, null);
      } else if (kind === "send") {
        if (!send || send.status !== "queued") {
          const request = { action: "send.reserve", requestId: crypto.randomUUID(), sourceId: id,
            sourceRevision: p.sourceRevision, draftRevision: p.draftRevision, previewVersion: p.previewVersion };
          retained = retain(id, request); const value = await api.apply(request);
          if (owner !== ownerKey() || gen !== generation) return;
          retain(id, null); send = value.receipt.send; s.sends.push(send);
        }
        const value = await api.simulate("dispatch", id, send.id);
        if (owner !== ownerKey() || gen !== generation) return;
        s.sends = value.sends;
      } else {
        if (!await load(id)) return;
        if (owner !== ownerKey() || gen !== generation) return;
        send = latest(s);
        if (!send || !["unknown", "accepted"].includes(send.status)) return;
        const value = await api.simulate("reconcile", id, send.id);
        if (owner !== ownerKey() || gen !== generation) return;
        s.sends = value.sends;
      }
      s.note = ""; if (id === sourceId) $("inbox-send-dialog").close();
      await load(id);
    } catch (error) {
      if (owner !== ownerKey() || gen !== generation) return;
      if (error.status && error.status < 500) {
        retain(id, null); await load(id);
        s.note = error.code === "stale_inbox_reply" ? latest(s)?.status === "queued"
          ? "Reply changed. Cancel the pending reply and review again." : "Reply changed. Review your draft again." : "Reply not confirmed. Check its status.";
        if (error.code === "stale_inbox_reply" && sourceId === id) await reviewChanges();
      } else {
        s.uncertain = true;
        await load(id);
        s.note = s.pending ? retained ? "Reply unconfirmed. Check status." : "Reply unconfirmed. Keep this tab open and check status."
          : "Outcome unconfirmed. Check status before continuing.";
      }
      if (id === sourceId) $("inbox-send-dialog").close();
    } finally {
      if (owner === ownerKey() && gen === generation) { s.busy = false; if (id === sourceId) render(); }
    }
  }
  $("inbox-send-preview").addEventListener("click", () => open());
  $("inbox-send-resume").addEventListener("click", () => open(true));
  $("inbox-send-view").addEventListener("click", () => open(true, true));
  $("inbox-send-confirm").addEventListener("click", () => act("send"));
  $("inbox-send-check").addEventListener("click", () => act("check"));
  $("inbox-send-cancel").addEventListener("click", () => act("cancel"));
  $("inbox-send-close").addEventListener("click", () => $("inbox-send-dialog").close());
  $("inbox-send-dialog").addEventListener("close", () => { modalTurn++; preview = null; });
  return {
    update(id, value) { sourceId = id; draft = value; render(); },
    load,
    reset({ preservePending = false } = {}) {
      generation++; modalTurn++; sourceId = null; draft = null; preview = null; states.clear();
      if (!preservePending) try { storage?.removeItem(storageKey); } catch {}
      $("inbox-send-dialog").close(); $("inbox-send-panel").hidden = true;
      $("inbox-save").hidden = false;
      for (const id of ["inbox-send-addresses", "inbox-send-subject", "inbox-send-body", "inbox-send-status", "inbox-send-dialog-status"]) $(id).textContent = "";
    },
    hasPending: () => [...states.values()].some(s => s.pending || s.busy)
  };
}
