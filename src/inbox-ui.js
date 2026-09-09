import { InboxClient, inboxTextVersion } from "./inbox-client.js";
import { installInboxSend } from "./inbox-send-ui.js";
import { validId } from "./events.js";

export function installInbox({ account, room, getRoom, onShared, onOpenWork, onAccountEnded = () => room.endAccess(), onRooms = () => {}, onNavigate = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const api = new InboxClient(account, { onAccessEnded: onAccountEnded });
  const drafts = new Map(), positions = new Map();
  let owner = null, active = false, browsing = false, selected = null, epoch = 0, rows = [], sharing = null, sharingBusy = false, retryShare = null;
  const storageKey = "project-room:pending-private-share:v1";
  const positionKey = "project-room:inbox-position:v1";
  let storage; try { storage = sessionStorage; } catch {}
  let resultPreview = null, resultEpoch = 0;
  const text = (selector, value) => { $(selector).textContent = value; };
  const ownerKey = () => {
    const s = account.session;
    return s?.authenticated
      ? JSON.stringify([s.account.id, s.account.authEpoch, s.sessionRevision, s.sessionBinding]) : null;
  };
  const owns = () => owner !== null && owner === ownerKey();
  const sendUI = installInboxSend({ api, ownerKey: () => owns() ? owner : null, reviewChanges: async () => {
    const id = selected, d = drafts.get(id); if (!d || !owns()) return;
    await review(id, d); if (owns() && selected === id) render();
  } });
  function persistShare(request = null) {
    // Only operation metadata; never private bodies, addresses, CSRF or access keys.
    retryShare = request;
    try {
      if (!storage) return false;
      request ? storage.setItem(storageKey, JSON.stringify({ owner, request })) : storage.removeItem(storageKey);
      return true;
    } catch { return false; }
  }
  function pendingShare() {
    if (retryShare) return retryShare;
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null"), r = saved?.request;
      if (saved?.owner === owner && ["source.share", "source.excerpt"].includes(r?.action) && typeof r.requestId === "string"
        && typeof r.sourceId === "string" && typeof r.roomId === "string"
        && (r.action === "source.share" ? Array.isArray(r.paragraphs) : Number.isSafeInteger(r.selection?.start) && Number.isSafeInteger(r.selection?.end))) return (retryShare = r);
      storage?.removeItem(storageKey);
    } catch { return null; }
    return null;
  }
  function savedPosition() {
    try {
      const raw = storage?.getItem(positionKey);
      const saved = raw && raw.length <= 1024 ? JSON.parse(raw) : null;
      if (saved?.owner === owner && Object.keys(saved).length === 5 && validId(saved.sourceId) && Number.isSafeInteger(saved.sourceRevision) && saved.sourceRevision > 0
        && [saved.reader, saved.page].every(n => Number.isFinite(n) && n >= 0 && n <= 1000000)) return saved;
      storage?.removeItem(positionKey);
    } catch {}
    return null;
  }
  function remember() {
    const d = drafts.get(selected);
    if (!active || !owns() || !d) return;
    const point = { sourceRevision: d.source.revision, reader: $("#inbox-reader").scrollTop, page: window.scrollY };
    positions.set(selected, point);
    // Per-tab navigation metadata only: never source text, addresses or draft text.
    try { storage?.setItem(positionKey, JSON.stringify({ owner, sourceId: selected, ...point })); } catch {}
  }
  function show(place, updateLocation = true) {
    remember(); // Capture before hiding the reader, when scroll offsets are meaningful.
    onNavigate();
    active = place === "inbox";
    browsing = false;
    if (updateLocation) history.replaceState(null, "", "#pr-view/" + (active ? "inbox" : "rooms"));
    $("#main").hidden = active || !getRoom();
    $("#inbox-panel").hidden = !active;
    $("#account-rooms-panel").hidden = active || Boolean(getRoom());
    $("#nav-inbox").setAttribute("aria-current", active ? "page" : "false");
    $("#nav-rooms").setAttribute("aria-current", active ? "false" : "page");
    if (!active) {
      if (getRoom()) $("#conversation-title").focus({ preventScroll: true });
      else onRooms();
    }
  }
  function reset({ preservePending = false } = {}) {
    if (!preservePending) { try { storage?.removeItem(positionKey); } catch {} }
    sendUI.reset({ preservePending });
    api.reset(); owner = null; epoch++; active = false; browsing = false; selected = null; rows = []; sharing = null; sharingBusy = false;
    drafts.clear(); positions.clear(); retryShare = null; if (!preservePending) persistShare();
    $("#workspace-nav").hidden = true; $("#inbox-panel").hidden = true; $("#inbox-share-dialog").close();
    $("#account-rooms-panel").hidden = true;
    resultPreview = null; resultEpoch++; $("#inbox-result-dialog").close(); $("#inbox-results").hidden = true;
    for (const selector of ["#inbox-result-list", "#inbox-result-body", "#inbox-replaced-draft", "#inbox-result-status", "#inbox-origin"]) $(selector).replaceChildren();
    $("#inbox-panel").classList.remove("reading");
    $("#nav-inbox").setAttribute("aria-current", "false"); $("#nav-rooms").setAttribute("aria-current", "page");
    for (const selector of ["#inbox-list", "#inbox-source-body", "#inbox-subject", "#inbox-addresses", "#inbox-draft-status", "#inbox-status", "#inbox-remote-draft", "#inbox-share-paragraphs", "#inbox-share-audience", "#inbox-share-status"]) $(selector).replaceChildren();
    $("#inbox-draft").value = ""; $("#inbox-reader").hidden = true; $("#inbox-conflict").hidden = true;
    $("#inbox-email-details").hidden = true; $("#inbox-email-details").open = false;
    $("#inbox-email-metadata").replaceChildren(); text("#inbox-source-notice", ""); $("#inbox-source-notice").hidden = true;
  }
  function sync() {
    const next = ownerKey();
    if (!next) { if (owner) reset(); return; }
    if (owner && owner !== next) reset();
    owner = next; $("#workspace-nav").hidden = false;
    // Room snapshot updates must not replace the current private destination.
    $("#main").hidden = active || browsing || !getRoom();
    $("#account-rooms-panel").hidden = !browsing && (active || Boolean(getRoom()));
    $("#inbox-ask").disabled = Boolean(getRoom()) && !room.ownsAccountSession();
    $("#choose-room").hidden = !getRoom();
  }
  const errorText = error => error.code === "obsolete_inbox" ? "" : error.status === 404 ? "Message unavailable." : "Couldn’t load inbox. Try again.";
  function renderList() {
    $("#inbox-list").replaceChildren(...rows.map(source => {
      const button = document.createElement("button"); button.type = "button"; button.className = "inbox-row";
      button.dataset.sourceId = source.id; button.setAttribute("aria-current", selected === source.id ? "true" : "false");
      const sender = document.createElement("span"), subject = document.createElement("strong");
      sender.textContent = source.sender; subject.textContent = source.subject || "(No subject)";
      button.append(sender, subject); button.addEventListener("click", () => open(source.id)); return button;
    }));
  }
  async function load() {
    sync(); if (!owns()) return;
    show("inbox"); text("#inbox-status", "Loading…");
    const turn = ++epoch;
    try {
      const result = await api.list(); if (!owns() || turn !== epoch) return;
      rows = result.sources; renderList(); text("#inbox-status", rows.length ? "" : "No messages yet.");
      $("#inbox-empty").hidden = rows.length > 0;
      if (selected && drafts.has(selected)) { render(); loadResults(selected); return; }
      const pending = pendingShare(), saved = savedPosition();
      if (saved && rows.some(r => r.id === saved.sourceId && r.revision === saved.sourceRevision))
        positions.set(saved.sourceId, { sourceRevision: saved.sourceRevision, reader: saved.reader, page: saved.page });
      if (rows.length) await open(rows.find(r => r.id === pending?.sourceId)?.id ?? rows.find(r => r.id === saved?.sourceId)?.id ?? rows[0].id);
    } catch (error) { if (owns() && turn === epoch) text("#inbox-status", errorText(error)); }
  }
  async function open(sourceId) {
    if (!owns()) return;
    if (selected !== sourceId) $("#inbox-email-details").open = false;
    remember(); selected = sourceId; renderList();
    $("#inbox-panel").classList.add("reading");
    if (drafts.has(sourceId)) { render(); loadResults(sourceId); return; }
    $("#inbox-reader").hidden = true; text("#inbox-status", "Loading…");
    const turn = ++epoch;
    try {
      const result = await api.read(sourceId); if (!owns() || turn !== epoch || selected !== sourceId) return;
      drafts.set(sourceId, { source: result.source, base: result.draft, reviewedSource: result.draft?.sourceRevision ?? result.source.revision,
        body: result.draft?.body ?? "", dirty: false, pending: null, busy: false, conflict: null });
      text("#inbox-status", ""); render(); remember(); loadResults(sourceId);
    } catch (error) { if (owns() && turn === epoch) text("#inbox-status", errorText(error)); }
  }
  function render() {
    const d = drafts.get(selected); if (!d || !owns()) return;
    $("#inbox-reader").hidden = false;
    text("#inbox-subject", d.source.subject || "(No subject)");
    const email = d.source.email;
    text("#inbox-source-label", email ? "Sample email · only you" : "Sample message · only you");
    $("#inbox-ask").hidden = Boolean(email) && !d.source.capabilities.share && !pendingShare();
    $("#inbox-email-details").hidden = !email;
    const metadata = email ? ["Mailbox: " + d.source.recipient,
      ...["to", "cc", "bcc"].filter(k => email[k].length).map(k => (k === "to" ? "To" : k.toUpperCase()) + ": " + email[k].join(", ")),
      email.attachmentState === "complete" ? (email.attachmentCount ? `${email.attachmentCount} ${email.attachmentCount === 1 ? "attachment" : "attachments"} · files unavailable` : "No attachments")
        : "Attachments " + (email.attachmentState === "partial" ? "partly listed" : "not loaded") + " · files unavailable",
      d.source.capabilities.share ? "Sending unavailable" : "Sharing and sending unavailable"] : [];
    $("#inbox-email-metadata").replaceChildren(...metadata.map(value => { const p = document.createElement("p"); p.textContent = value; return p; }));
    const notices = email ? [email.connectionState === "disconnected" ? "Disconnected · saved copy" : email.connectionState === "reconnect_required" ? "Reconnect required · saved copy" : "",
      email.format === "html" ? "HTML preview unavailable." : !d.source.paragraphs[0] ? "No message text." : ""].filter(Boolean) : [];
    text("#inbox-source-notice", notices.join(" · ")); $("#inbox-source-notice").hidden = !notices.length;
    text("#inbox-addresses", d.source.sender + " → " + d.source.recipient);
    $("#inbox-source-body").replaceChildren(...d.source.paragraphs.map(value => { const p = document.createElement("p"); p.textContent = value; return p; }));
    $("#inbox-draft").value = d.body;
    $("#inbox-draft").readOnly = Boolean(d.pending || d.busy || d.conflict);
    $("#inbox-save").disabled = d.busy || Boolean(d.conflict) || (!d.pending && d.reviewedSource !== d.source.revision) || (!d.dirty && !d.pending);
    $("#inbox-save").textContent = d.busy ? "Saving…" : d.pending ? "Confirm save" : "Save draft";
    $("#inbox-review").hidden = Boolean(d.conflict) || (d.reviewedSource === d.source.revision && !d.note?.includes("review changes"));
    $("#inbox-review").disabled = Boolean(d.busy || d.pending);
    $("#inbox-conflict").hidden = !d.conflict;
    text("#inbox-remote-draft", d.conflict?.draft?.body || "No saved draft");
    text("#inbox-draft-status", d.note ?? (d.pending ? "Save unconfirmed. Confirm before editing." : d.reviewedSource !== d.source.revision ? "Source changed. Review before saving." : d.dirty ? "Not saved" : d.base ? "Saved · only you" : "Only you · nothing sent"));
    const saved = positions.get(selected);
    const point = saved?.sourceRevision === d.source.revision ? saved : { reader: 0, page: 0 };
    $("#inbox-reader").scrollTop = point.reader;
    window.scrollTo({ top: point.page, behavior: "instant" });
    const origin = d.base?.origin;
    sendUI.update(selected, d);
    text("#inbox-origin", origin ? (d.dirty || !origin.unchanged ? "Edited since room review" : "Copied from room review")
      + (origin.sourceChanged ? " · source changed" : "") : "");
  }
  $("#inbox-draft").addEventListener("input", () => {
    const d = drafts.get(selected); if (!d || !owns()) return;
    d.body = $("#inbox-draft").value; d.dirty = d.body !== (d.base?.body ?? ""); d.note = null;
    $("#inbox-save").disabled = !d.dirty || d.reviewedSource !== d.source.revision;
    text("#inbox-draft-status", d.reviewedSource !== d.source.revision ? "Source changed. Review before saving." : d.dirty ? "Not saved" : d.base ? "Saved · only you" : "Only you · nothing sent");
    if (d.base?.origin) text("#inbox-origin", d.dirty || !d.base.origin.unchanged ? "Edited since room review" : "Copied from room review");
    sendUI.update(selected, d);
  });
  async function saveDraft(adoption = null) {
    const sourceId = selected, d = drafts.get(sourceId);
    if (!d || d.busy || d.conflict || !owns() || (!adoption && !d.dirty && !d.pending) || (!d.pending && d.reviewedSource !== d.source.revision)) return;
    const request = d.pending ?? adoption ?? { action: "draft.save", requestId: crypto.randomUUID(), sourceId,
      sourceRevision: d.source.revision, expectedRevision: d.base?.revision ?? 0, body: d.body };
    d.pending = request; d.busy = true; d.note = null; remember(); render();
    try {
      const result = await api.apply(request); if (!owns() || drafts.get(sourceId) !== d) return;
      const body = request.action === "draft.adopt" ? result.receipt.body : request.body;
      let origin = result.receipt.origin ? { ...result.receipt.origin, unchanged: true, sourceChanged: false } : d.base?.origin ?? null;
      if (origin && !result.receipt.origin) origin = body ? { ...origin, unchanged: await inboxTextVersion(body) === origin.evidenceVersion } : null;
      if (!owns() || drafts.get(sourceId) !== d) return;
      d.body = body; d.base = { revision: result.receipt.revision, sourceRevision: request.sourceRevision, body, origin };
      d.pending = null; d.dirty = false; d.note = "Saved · only you";
    } catch (error) {
      if (!owns() || drafts.get(sourceId) !== d) return;
      if (["stale_inbox_source", "stale_inbox_draft"].includes(error.code)) {
        d.pending = null; d.note = "Changed elsewhere. Review before saving.";
        await review(sourceId, d);
      } else if (error.code === "stale_inbox_result") { d.pending = null; d.note = "Result changed. Review again."; loadResults(sourceId); }
      else if (Number.isSafeInteger(error.status) && error.status < 500) { d.pending = null; d.note = "Draft not saved. Try again."; }
      else d.note = "Save unconfirmed. Confirm before editing.";
    } finally { if (owns() && drafts.get(sourceId) === d) { d.busy = false; if (selected === sourceId) render(); } }
  }
  $("#inbox-draft-form").addEventListener("submit", event => { event.preventDefault(); saveDraft(); });
  async function loadResults(sourceId) {
    sendUI.load(sourceId);
    const turn = ++resultEpoch;
    $("#inbox-results").hidden = true; $("#inbox-result-list").replaceChildren();
    if (!getRoom() || !room.ownsAccountSession()) return;
    try {
      const value = await api.results(sourceId, getRoom().room.id);
      if (!owns() || selected !== sourceId || turn !== resultEpoch) return;
      const labels = { source_changed: "Source changed", superseded: "Replaced", no_native_result: "Work in progress", needs_review: "Needs review and approval", too_long: "Result exceeds draft size" };
      $("#inbox-results").hidden = !value.results.length;
      $("#inbox-result-list").replaceChildren(...value.results.map(result => {
        const row = document.createElement("div"), open = document.createElement("button"), detail = document.createElement("span");
        row.className = "inbox-result-row"; open.type = "button"; open.className = "text-button"; open.textContent = result.title;
        open.addEventListener("click", () => { show("rooms"); onOpenWork(result.workItemId); });
        detail.textContent = labels[result.status] ?? "Reviewed and approved"; row.append(open, detail);
        if (result.status === "ready") {
          const use = document.createElement("button"); use.type = "button"; use.className = "button secondary"; use.textContent = "Use result";
          use.dataset.inboxResult = result.workItemId; use.addEventListener("click", () => previewResult(sourceId, result.workItemId)); row.append(use);
        }
        return row;
      }));
    } catch (error) {
      if (owns() && selected === sourceId && turn === resultEpoch && error.status !== 404) {
        $("#inbox-results").hidden = false; text("#inbox-result-list", "Room results unavailable. Refresh to retry.");
      }
    }
  }
  async function previewResult(sourceId, workItemId) {
    const d = drafts.get(sourceId);
    if (!owns() || !getRoom() || !room.ownsAccountSession() || d?.busy || d?.pending || d?.conflict) return;
    const turn = ++resultEpoch; resultPreview = null;
    $("#inbox-result-dialog").showModal(); $("#inbox-result-use").disabled = true;
    text("#inbox-result-body", ""); text("#inbox-replaced-draft", d.body || "No current draft"); text("#inbox-result-status", "Loading…");
    try {
      const value = await api.results(sourceId, getRoom().room.id, workItemId);
      if (!owns() || selected !== sourceId || turn !== resultEpoch || !$("#inbox-result-dialog").open) return;
      const result = value.results[0];
      if (value.sourceRevision !== d.source.revision || d.reviewedSource !== d.source.revision) { text("#inbox-result-status", "Review source changes first."); return; }
      if (result.status !== "ready") { text("#inbox-result-status", "Result changed. Review the work again."); return; }
      resultPreview = { sourceId, expectedRevision: d.base?.revision ?? 0, sourceRevision: value.sourceRevision, roomId: value.roomId, ...result };
      text("#inbox-result-body", result.body); text("#inbox-result-status", "Independently reviewed · approved by a human");
      $("#inbox-result-use").disabled = false;
    } catch { if (owns() && turn === resultEpoch) text("#inbox-result-status", "Couldn’t verify the result. Close and try again."); }
  }
  $("#inbox-result-close").addEventListener("click", () => { resultEpoch++; resultPreview = null; $("#inbox-result-dialog").close(); });
  $("#inbox-result-use").addEventListener("click", () => {
    const p = resultPreview; if (!p || !owns() || selected !== p.sourceId) return;
    $("#inbox-result-dialog").close(); resultPreview = null;
    saveDraft({ action: "draft.adopt", requestId: crypto.randomUUID(), sourceId: p.sourceId, sourceRevision: p.sourceRevision,
      expectedRevision: p.expectedRevision, roomId: p.roomId, workItemId: p.workItemId, shareRequestId: p.shareRequestId, resultVersion: p.resultVersion });
  });
  async function review(sourceId, d) {
    const turn = d.reviewTurn = (d.reviewTurn ?? 0) + 1;
    try {
      const result = await api.read(sourceId); if (!owns() || drafts.get(sourceId) !== d || turn !== d.reviewTurn) return;
      if (result.source.revision === d.source.revision && d.reviewedSource === result.source.revision
        && result.draft?.revision === d.base?.revision && result.draft?.sourceRevision === d.base?.sourceRevision
        && result.draft?.body === d.base?.body) {
        // Metadata-only refreshes must not turn unchanged drafts into conflicts.
        d.source = result.source; d.base = result.draft; d.note = null; return;
      }
      d.conflict = result;
      // Show the changed source before the user decides which draft to retain.
      d.source = result.source; d.note = "Review the source and saved draft.";
    } catch (error) { if (owns() && drafts.get(sourceId) === d && turn === d.reviewTurn) d.note = "Couldn’t review changes. Try again."; }
  }
  $("#inbox-review").addEventListener("click", async () => {
    const sourceId = selected, d = drafts.get(sourceId); if (!d || d.busy || d.pending) return;
    remember(); d.busy = true; render(); await review(sourceId, d); d.busy = false; if (owns() && selected === sourceId) render();
  });
  for (const choice of ["mine", "saved"]) $("#inbox-use-" + choice).addEventListener("click", () => {
    const d = drafts.get(selected); if (!d?.conflict || !owns()) return;
    d.base = d.conflict.draft; if (choice === "saved") d.body = d.base?.body ?? "";
    d.conflict = null; d.reviewedSource = d.source.revision; d.dirty = true; d.note = choice === "mine" ? "Your draft kept. Save when ready." : "Saved draft selected. Review before saving.";
    render();
  });
  async function ask() {
    if (!owns() || !selected) return;
    const d = drafts.get(selected); if (d?.source.adapter === "email" && !d.source.capabilities.share && !pendingShare()) return;
    if (!getRoom()) { show("rooms"); return; }
    $("#inbox-share-dialog").showModal(); text("#inbox-share-status", "Loading…");
    $("#inbox-share-confirm").disabled = true; $("#inbox-share-paragraphs").replaceChildren();
    const pending = pendingShare(), sourceId = pending?.sourceId ?? selected, turn = ++epoch;
    try {
      const source = await api.read(sourceId), context = await api.context(sourceId, pending?.roomId ?? getRoom().room.id);
      if (!owns() || turn !== epoch || !$("#inbox-share-dialog").open) return;
      if (source.source.revision !== context.sourceRevision) throw new Error("Source changed");
      sharing = { source: source.source, context, request: pending };
      text("#inbox-share-audience", context.roomTitle + " · " + context.members.map(m => m.displayName + (m.kind === "agent" ? " (agent)" : "")).join(", "));
      $("#inbox-share-paragraphs").replaceChildren(...(pending ? [] : source.source.paragraphs).map((value, index) => {
        const label = document.createElement("label"), input = document.createElement("input"), span = document.createElement("span");
        input.type = "checkbox"; input.value = index; input.checked = pending?.paragraphs.includes(index) ?? false;
        input.disabled = Boolean(pending); span.textContent = value; label.append(input, span); return label;
      }));
      if (!pending && source.source.adapter === "email") {
        if (!source.source.capabilities.share) throw new Error("Sharing unavailable");
        const selectionOwner = sharing;
        const label = document.createElement("p"), input = document.createElement("textarea"), preview = document.createElement("pre");
        label.id = "inbox-excerpt-label"; label.textContent = "Select text to share";
        input.id = "inbox-excerpt-text"; input.setAttribute("aria-labelledby", label.id); input.setAttribute("aria-readonly", "true"); input.rows = 6;
        input.value = source.source.paragraphs[0]; preview.id = "inbox-excerpt-preview"; preview.hidden = true;
        // Native readonly textareas on macOS do not move a selection with arrow
        // keys. Block edits while retaining normal keyboard selection behavior.
        input.addEventListener("beforeinput", event => event.preventDefault());
        input.addEventListener("input", () => {
          if (sharing !== selectionOwner || !owns()) return;
          input.value = source.source.paragraphs[0]; input.setSelectionRange(0, 0);
          if (sharing && !sharing.request) sharing.selection = null;
          preview.textContent = ""; preview.hidden = true; $("#inbox-share-confirm").disabled = true;
        });
        const select = () => {
          if (sharing !== selectionOwner || !owns() || sharing.request || sharingBusy) return;
          const start = input.selectionStart, end = input.selectionEnd, value = input.value.slice(start, end);
          const body = "Shared email excerpt\n\n" + value;
          const valid = Boolean(value.trim()) && value.isWellFormed() && body.length <= 4000;
          sharing.selection = valid ? { start, end } : null;
          preview.textContent = valid ? body : ""; preview.hidden = !valid;
          text("#inbox-share-status", body.length > 4000 ? "Select a shorter excerpt." : "");
          $("#inbox-share-confirm").disabled = !valid;
        };
        for (const event of ["select", "keyup", "mouseup", "touchend"]) input.addEventListener(event, select);
        $("#inbox-share-paragraphs").replaceChildren(label, input, preview);
      }
      text("#inbox-share-status", pending ? "Share unconfirmed. Retry the original selection." : "");
      $("#inbox-share-confirm").textContent = pending ? "Confirm share" : "Share";
      $("#inbox-share-confirm").disabled = !pending;
    } catch (error) { if (owns() && turn === epoch) text("#inbox-share-status", "Couldn’t load sharing context. Close and try again."); }
  }
  $("#inbox-share-paragraphs").addEventListener("change", () => {
    $("#inbox-share-confirm").disabled = !$("#inbox-share-paragraphs input:checked");
  });
  $("#inbox-share-confirm").addEventListener("click", async () => {
    if (!sharing || sharingBusy || !owns()) return;
    const current = sharing, c = current.context;
    if (!current.request && current.source.adapter === "email" && !current.selection) return;
    current.request ??= { action: current.source.adapter === "email" ? "source.excerpt" : "source.share", requestId: crypto.randomUUID(), sourceId: current.source.id,
      sourceRevision: c.sourceRevision, roomId: c.roomId, audienceVersion: c.audienceVersion,
      ...(current.source.adapter === "email" ? { selection: current.selection }
        : { paragraphs: [...document.querySelectorAll("#inbox-share-paragraphs input:checked")].map(el => Number(el.value)) }) };
    const retained = persistShare(current.request); sharingBusy = true; $("#inbox-share-confirm").disabled = true;
    for (const el of document.querySelectorAll("#inbox-share-paragraphs input, #inbox-share-paragraphs textarea")) el.disabled = true;
    text("#inbox-share-status", "Sharing…");
    try {
      const result = await api.apply(current.request); if (!owns() || sharing !== current) return;
      persistShare(); $("#inbox-share-dialog").close(); sharing = null; show("rooms");
      text("#inbox-status", "Shared"); await onShared(result.receipt);
    } catch (error) {
      if (!owns() || sharing !== current) return;
      if (["stale_inbox_source", "stale_inbox_audience"].includes(error.code)) {
        persistShare(); current.request = null; sharing = null;
        text("#inbox-share-status", "Source or audience changed. Close and review again.");
      } else if (Number.isSafeInteger(error.status) && error.status < 500) {
        persistShare(); current.request = null; sharing = null; text("#inbox-share-status", "Not shared. Close and try again.");
      } else { text("#inbox-share-status", retained ? "Share unconfirmed. Retry the original selection." : "Share unconfirmed. Keep this tab open and retry.");
        $("#inbox-share-confirm").textContent = "Confirm share"; $("#inbox-share-confirm").disabled = false; }
    } finally { sharingBusy = false; }
  });
  $("#inbox-share-close").addEventListener("click", () => $("#inbox-share-dialog").close());
  $("#inbox-ask").addEventListener("click", ask);
  $("#nav-inbox").addEventListener("click", load);
  $("#nav-rooms").addEventListener("click", () => show("rooms"));
  $("#inbox-refresh").addEventListener("click", async () => {
    const sourceId = selected, d = drafts.get(sourceId);
    if (d && !d.busy && !d.pending) { await review(sourceId, d); if (owns() && selected === sourceId) { render(); loadResults(sourceId); } }
    else await load();
  });
  $("#inbox-back").addEventListener("click", () => { remember(); $("#inbox-panel").classList.remove("reading"); $("#inbox-list button[aria-current=true]")?.focus(); });
  window.addEventListener("beforeunload", event => {
    remember();
    if (owns() && ([...drafts.values()].some(d => d.dirty || d.pending) || sendUI.hasPending())) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") remember(); });
  return { sync, reset, open: () => { if (!active) return load(); },
    detachRoom: () => {
      sharing = null; resultPreview = null; resultEpoch++;
      $("#inbox-share-dialog").close(); $("#inbox-result-dialog").close();
      $("#inbox-results").hidden = true; $("#inbox-result-list").replaceChildren();
      sync();
    },
    showRoomList: () => { remember(); active = false; browsing = true; history.replaceState(null, "", "#pr-view/rooms");
      $("#nav-inbox").setAttribute("aria-current", "false"); $("#nav-rooms").setAttribute("aria-current", "page");
      $("#inbox-panel").hidden = true; $("#main").hidden = true;
      $("#account-rooms-panel").hidden = false; onNavigate(); onRooms(); },
    showRooms: () => { if (active || browsing) show("rooms", false); },
    hasPending: () => owns() && ([...drafts.values()].some(d => d.dirty || d.pending) || Boolean(pendingShare()) || sendUI.hasPending()) };
}
