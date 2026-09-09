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
    if (draft?.source.adapter === "email") {
      $("inbox-send-panel").hidden = true; $("inbox-save").hidden = false; return;
    }
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
    if (id === sourceId && draft?.source.adapter === "email") { render(); return true; }
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
    if (!sourceId || !ownerKey() || draft?.source.adapter === "email") return;
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

// Exact content acknowledgment only. Provider creation/observation stays outside
// the browser; pending storage contains operation IDs and versions, never mail.
export function installInboxReplyReview({ api, ownerKey }) {
  const $ = id => document.getElementById(id), key = "project-room:pending-reply-review:v1";
  let storage; try { storage = sessionStorage; } catch {}
  let sourceId = null, draft = null, data = null, preview = null, pending = null;
  let generation = 0, readTurn = 0, modalTurn = 0, busy = false, verified = false, note = "";
  const validPending = r => r?.action === "reply.review" && [r.requestId, r.sourceId, r.attemptId].every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))
    && Number.isSafeInteger(r.expectedRevision) && r.expectedRevision >= 0 && typeof r.reviewVersion === "string" && /^[a-f0-9]{64}$/.test(r.reviewVersion);
  function restore() {
    if (pending) return;
    try {
      const raw = storage?.getItem(key), saved = raw && raw.length <= 1600 ? JSON.parse(raw) : null;
      if (saved?.owner === ownerKey() && validPending(saved.request)) pending = saved.request;
    } catch {}
  }
  function retain(request) {
    pending = request;
    try {
      if (!storage) return false;
      request ? storage.setItem(key, JSON.stringify({ owner: ownerKey(), request })) : storage.removeItem(key);
      return true;
    } catch { return false; }
  }
  const clean = a => a && draft && !draft.dirty && !draft.busy && !draft.pending && !draft.conflict
    && a.sourceRevision === draft.source.revision && a.draftRevision === draft.base?.revision;
  const current = a => Boolean(a?.review?.current && clean(a));
  function render() {
    const a = data?.attempt, ownPending = pending?.sourceId === sourceId, email = draft?.source.adapter === "email";
    $("inbox-reply-panel").hidden = !ownerKey() || !email || !a && !ownPending;
    $("inbox-reply-open").disabled = busy || Boolean(pending && !ownPending);
    $("inbox-reply-open").textContent = ownPending ? "Check review" : current(a) ? "View reply" : "Review reply";
    const label = a?.status === "creation_unconfirmed" ? "Sample draft unconfirmed" : a?.status === "reserved" ? "Sample draft not created"
      : a?.status === "draft_unavailable" ? "Sample draft unavailable" : current(a) ? "Reviewed · not sent" : "Sample draft · not sent";
    $("inbox-reply-status").textContent = note || (ownPending ? "Review unconfirmed" : label);
    const matches = verified && preview?.id === a?.id && preview?.revision === a?.revision;
    $("inbox-reply-confirm").disabled = busy || Boolean(pending) || !matches || !clean(preview) || !preview?.canReview;
    if ($("inbox-reply-dialog").open && preview && (!matches || !clean(preview)))
      $("inbox-reply-dialog-status").textContent = "Reply changed or unavailable. Close and review again.";
  }
  async function load(id = sourceId) {
    if (!ownerKey() || id !== sourceId || draft?.source.adapter !== "email") return false;
    restore(); const owner = ownerKey(), gen = generation, turn = ++readTurn;
    verified = false; render();
    try {
      const value = await api.replyReview(id);
      if (gen !== generation || turn !== readTurn || owner !== ownerKey() || id !== sourceId) return false;
      if (data?.attempt && (!value.attempt || value.attempt.id !== data.attempt.id || value.attempt.revision < data.attempt.revision))
        throw new Error("Reply history changed unexpectedly");
      data = value; verified = true; note = ""; render(); return true;
    } catch {
      if (gen !== generation || turn !== readTurn || owner !== ownerKey() || id !== sourceId) return false;
      note = "Couldn’t check this reply"; render(); return false;
    }
  }
  function clearPreview() {
    preview = null;
    for (const id of ["inbox-reply-addresses", "inbox-reply-subject", "inbox-reply-body", "inbox-reply-dialog-status"]) $(id).replaceChildren();
    $("inbox-reply-confirm").hidden = true; $("inbox-reply-confirm").disabled = true;
  }
  async function open() {
    if (!ownerKey() || busy) return;
    if (pending?.sourceId === sourceId) return acknowledge();
    const turn = ++modalTurn, id = sourceId, owner = ownerKey();
    clearPreview(); $("inbox-reply-dialog").showModal(); $("inbox-reply-dialog-status").textContent = "Loading…";
    const loaded = await load(id);
    if (turn !== modalTurn || id !== sourceId || owner !== ownerKey() || !$("inbox-reply-dialog").open) return;
    if (!loaded) { $("inbox-reply-dialog-status").textContent = "Couldn’t check this reply. Close and try again."; return; }
    preview = data.attempt; const o = preview?.observation;
    if (!o) { $("inbox-reply-dialog-status").textContent = "No confirmed draft preview. Nothing sent."; return; }
    const rows = [["From", [o.from]], ...(o.sender !== o.from ? [["Sender", [o.sender]]] : []), ["To", o.to], ["CC", o.cc], ["BCC", o.bcc]];
    $("inbox-reply-addresses").replaceChildren(...rows.filter(([, values]) => values.length).map(([label, values]) => {
      const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = values.join(", "); row.append(dt, dd); return row;
    }));
    $("inbox-reply-subject").textContent = o.subject || "(No subject)";
    $("inbox-reply-body").textContent = o.body ?? "HTML preview unavailable.";
    $("inbox-reply-confirm").hidden = current(preview) || !preview.canReview;
    $("inbox-reply-dialog-status").textContent = current(preview) ? "Reviewed · not sent" : preview.canReview && clean(preview)
      ? "Sample only · nothing will be sent" : "This draft needs a current, supported preview. Nothing sent.";
    render();
  }
  async function acknowledge() {
    const id = sourceId, owner = ownerKey(), gen = generation, a = preview;
    if (!owner || busy || pending && pending.sourceId !== id) return;
    if (!pending && (!verified || !clean(a) || !a?.canReview || a.id !== data?.attempt?.id || a.revision !== data?.attempt?.revision)) return;
    const request = pending ?? { action: "reply.review", requestId: crypto.randomUUID(), sourceId: id,
      attemptId: a.id, expectedRevision: a.revision, reviewVersion: a.observation.version };
    const retained = retain(request); busy = true; render();
    try {
      await api.reviewReply(request);
      if (gen !== generation || owner !== ownerKey()) return;
      retain(null); note = "";
    } catch (error) {
      if (gen !== generation || owner !== ownerKey()) return;
      if (error.status && error.status < 500) { retain(null); note = "Review not recorded. Open the current reply."; }
      else note = retained ? "Review unconfirmed. Check review." : "Review unconfirmed. Keep this tab open.";
    } finally {
      if (gen === generation && owner === ownerKey()) {
        busy = false;
        if (id === sourceId) {
          const message = note; $("inbox-reply-dialog").close();
          await load(id); if (gen === generation && owner === ownerKey() && id === sourceId) { note = message; render(); }
        } else render();
      }
    }
  }
  $("inbox-reply-open").addEventListener("click", open);
  $("inbox-reply-confirm").addEventListener("click", acknowledge);
  $("inbox-reply-close").addEventListener("click", () => $("inbox-reply-dialog").close());
  $("inbox-reply-dialog").addEventListener("close", () => { modalTurn++; clearPreview(); });
  return {
    update(id, value) {
      if (sourceId !== id) { readTurn++; modalTurn++; data = null; verified = false; note = ""; $("inbox-reply-dialog").close(); clearPreview(); }
      sourceId = id; draft = value; restore(); render();
    }, load,
    reset({ preservePending = false } = {}) {
      generation++; readTurn++; modalTurn++; sourceId = null; draft = null; data = null; busy = false; verified = false; note = "";
      if (!preservePending) retain(null); pending = null;
      $("inbox-reply-dialog").close(); clearPreview(); $("inbox-reply-panel").hidden = true; $("inbox-reply-status").textContent = "";
    },
    hasPending: () => Boolean(pending || busy)
  };
}
