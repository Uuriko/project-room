import { InboxClient, inboxTextVersion } from "./inbox-client.js";
import { installInboxSend, installInboxReplyReview } from "./inbox-send-ui.js";
import { validId } from "./events.js";
import { messagingConnectionsClient } from './messaging-connections-client.js';
import { installMessagingConnections } from './messaging-connections-ui.js';

export function installInbox({ account, room, getRoom, onShared, onOpenWork, onAccountEnded = () => room.endAccess(), onRooms = () => {}, onNavigate = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const api = new InboxClient(account, { onAccessEnded: onAccountEnded });
  const drafts = new Map(), positions = new Map();
  let owner = null, active = false, browsing = false, selected = null, epoch = 0, rows = [], sharing = null, sharingBusy = false, retryShare = null;
  let navigationEpoch = 0;
  let grantsEpoch = 0;
  let connectionTurn = 0, connectionBusy = false;
  let inboxView = 'all';
  const visibleRows = () => {
    const query = $('#inbox-search').value.trim().toLocaleLowerCase();
    return rows.filter(source => (inboxView === 'all' || (inboxView === 'email' ? source.adapter === 'email' : source.adapter === 'message'))
      && (!query || `${source.sender ?? ''} ${source.subject ?? ''}`.toLocaleLowerCase().includes(query)));
  };
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
  const messagingUI=installMessagingConnections({list:$('#inbox-messaging-list'),status:$('#inbox-messaging-status'),
    api:messagingConnectionsClient(api),ownerKey:()=>owns()?owner:null});
  const replyUI = installInboxReplyReview({ api, ownerKey: () => owns() ? owner : null });
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
      if (saved?.owner === owner && ["source.share", "source.excerpt", "source.grant"].includes(r?.action) && typeof r.requestId === "string"
        && typeof r.sourceId === "string" && typeof r.roomId === "string"
        && (r.action !== "source.grant" || Array.isArray(r.memberIds) && r.memberIds.length > 0 && r.memberIds.length <= 20)
        && (Array.isArray(r.paragraphs) || Number.isSafeInteger(r.selection?.start) && Number.isSafeInteger(r.selection?.end))) return (retryShare = r);
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
    navigationEpoch++;
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
    messagingUI.reset();
    telegramTurn++; $('#inbox-telegram-list').replaceChildren(); text('#inbox-telegram-status','');
    inboxView = 'all'; $('#inbox-search').value = '';
    $('#inbox-views').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.inboxView === 'all')));
    connectionTurn++; connectionBusy = false;
    $('#inbox-connections').open = false; $('#inbox-gmail-form').reset(); $('#inbox-gmail-form').hidden = true;
    $('#inbox-connections').querySelectorAll('button').forEach(button => { button.disabled = false; });
    $('#inbox-connection-list').replaceChildren(); text('#inbox-connection-status', '');
    navigationEpoch++;
    grantsEpoch++; $("#inbox-grant-list").replaceChildren(); $("#inbox-grants").open = false;
    $("#inbox-share-member-list").replaceChildren();
    if (!preservePending) { try { storage?.removeItem(positionKey); } catch {} }
    sendUI.reset({ preservePending });
    replyUI.reset({ preservePending });
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
    $("#inbox-list").replaceChildren(...visibleRows().map(source => {
      const button = document.createElement("button"); button.type = "button"; button.className = "inbox-row";
      button.dataset.sourceId = source.id; button.setAttribute("aria-current", selected === source.id ? "true" : "false");
      const sender = document.createElement("span"), subject = document.createElement("strong");
      sender.textContent = source.sender; subject.textContent = source.subject || "(No subject)";
      button.append(sender, subject); button.addEventListener("click", () => open(source.id)); return button;
    }));
  }
  function changeView() {
    if (!owns()) return;
    remember(); epoch++;
    const visible = visibleRows();
    if (!visible.some(source => source.id === selected) || !drafts.has(selected)) {
      selected = null; $('#inbox-reader').hidden = true; $('#inbox-panel').classList.remove('reading');
      if (visible.length) open(visible[0].id);
    }
    renderList();
    text('#inbox-status', visible.length ? '' : rows.length ? 'No matches in this view.' : 'No messages yet.');
  }
  $('#inbox-views').addEventListener('click', event => {
    const button = event.target.closest('[data-inbox-view]'); if (!button) return;
    inboxView = button.dataset.inboxView;
    $('#inbox-views').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    changeView();
  });
  $('#inbox-search').addEventListener('input', changeView);
  document.addEventListener('keydown', event => {
    if (!active || !owns() || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey
      || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === '/') { event.preventDefault(); $('#inbox-search').focus(); }
    if (event.key === 'j' || event.key === 'k') {
      const visible = visibleRows(), index = visible.findIndex(source => source.id === selected);
      const next = index < 0 ? 0 : index + (event.key === 'j' ? 1 : -1);
      if (visible[next]) { event.preventDefault(); open(visible[next].id); }
    }
  });
  let telegramTurn = 0;
  async function loadTelegram() {
    if (!owns()) return;
    const turn=++telegramTurn,capturedOwner=owner;
    $('#inbox-telegram-list').replaceChildren();
    try {
      const result=await api.telegramStatus();
      if (!owns() || capturedOwner!==owner || turn!==telegramTurn) return;
      text('#inbox-telegram-status','');
      $('#inbox-telegram-list').replaceChildren(...result.connections.map(connection=>{
        const row=document.createElement('div'),label=document.createElement('p');
        label.textContent='Telegram'+(connection.state==='active'?'':connection.state==='disconnected'?' · Disconnected':' · Setup needed');row.append(label);
        if(connection.state==='active') for(const action of ['sync','disconnect']) {
          const button=document.createElement('button');button.type='button';button.className='text-button';
          button.textContent=action==='sync'?'Sync':'Disconnect';button.setAttribute('aria-label',button.textContent+' Telegram');button.disabled=connectionBusy;
          button.addEventListener('click',()=>telegramAction(action,connection));row.append(button);
        }
        return row;
      }));
    } catch {
      if(owns()&&capturedOwner===owner&&turn===telegramTurn)text('#inbox-telegram-status','Telegram status unavailable.');
    }
  }
  async function telegramAction(action,connection) {
    if(!owns()||connectionBusy)return;
    const capturedOwner=owner;connectionBusy=true;telegramTurn++;connectionTurn++;
    $('#inbox-connections').querySelectorAll('button').forEach(b=>{b.disabled=true;});
    text('#inbox-telegram-status','Working…');
    try {
      const result=await api.telegram(action,{connectionId:connection.connectionId,expectedRevision:connection.revision});
      if(!owns()||capturedOwner!==owner)return;
      if(action==='sync')await load();
      if(!owns()||capturedOwner!==owner)return;
      await loadTelegram();
      if(!owns()||capturedOwner!==owner)return;
      text('#inbox-telegram-status',action==='disconnect'?'Disconnected here. Saved messages remain.':`${result.imported} message${result.imported===1?'':'s'} synced.`);
    } catch {
      if(owns()&&capturedOwner===owner){await loadTelegram();if(owns()&&capturedOwner===owner)text('#inbox-telegram-status','Action unconfirmed. Refresh before trying again.');}
    } finally {
      if(owns()&&capturedOwner===owner){connectionBusy=false;$('#inbox-connections').querySelectorAll('button').forEach(b=>{b.disabled=false;});}
    }
  }
  async function loadConnections() {
    if (!owns()) return;
    const turn = ++connectionTurn, capturedOwner = owner;
    text('#inbox-connection-status', 'Loading…');
    try {
      const result = await api.gmailStatus();
      if (!owns() || capturedOwner !== owner || turn !== connectionTurn) return;
      $('#inbox-gmail-form').hidden = !result.enabled;
      text('#inbox-connection-status', result.enabled ? '' : 'Email connections aren’t enabled on this server.');
      $('#inbox-connection-list').replaceChildren(...result.connections.map(connection => {
        const row = document.createElement('div'), label = document.createElement('p');
        label.textContent = connection.mailbox + (connection.state === 'connected' ? '' : ' · Reconnect');
        row.append(label);
        for (const action of connection.state === 'connected' ? ['sync', 'disconnect'] : ['start']) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
          button.textContent = { sync: 'Sync', disconnect: 'Disconnect', start: 'Reconnect' }[action];
          button.setAttribute('aria-label', button.textContent + ' ' + connection.mailbox);
          button.addEventListener('click', () => connectionAction(action, action === 'start' ? { mailbox: connection.mailbox } : { connectionId: connection.connectionId }));
          row.append(button);
        }
        return row;
      }));
    } catch (error) {
      if (owns() && capturedOwner === owner && turn === connectionTurn) {
        $('#inbox-gmail-form').hidden = true; text('#inbox-connection-status', errorText(error));
      }
    }
  }
  async function connectionAction(action, data) {
    if (!owns() || connectionBusy) return;
    const capturedOwner = owner; connectionBusy = true; connectionTurn++;
    $('#inbox-connections').querySelectorAll('button').forEach(button => { button.disabled = true; });
    text('#inbox-connection-status', action === 'start' ? 'Opening Google…' : 'Working…');
    try {
      const result = await api.gmail(action, data);
      if (!owns() || capturedOwner !== owner) return;
      if (action === 'start') { location.assign(result.authorizationUrl); return; }
      if (action === 'sync') await load();
      if (!owns() || capturedOwner !== owner) return;
      await loadConnections();
      if (!owns() || capturedOwner !== owner) return;
      text('#inbox-connection-status', action === 'disconnect' ? result.providerRevoked ? 'Disconnected. Saved mail remains.' : 'Disconnected here. Google revocation unconfirmed.'
        : `${result.imported ? `${result.imported} message${result.imported === 1 ? '' : 's'} synced.` : 'Inbox updated.'}${result.complete ? '' : ' Sync again for more.'}`);
    } catch (error) { if (owns() && capturedOwner === owner) text('#inbox-connection-status', errorText(error)); }
    finally {
      if (owns() && capturedOwner === owner) {
        connectionBusy = false; $('#inbox-connections').querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    }
  }
  $('#inbox-connections').addEventListener('toggle', () => { if ($('#inbox-connections').open && !connectionBusy) { loadConnections(); loadTelegram(); messagingUI.load(); } });
  $('#inbox-connect-empty').addEventListener('click', () => {
    $('#inbox-connections').open = true;
    $('#inbox-connections summary').focus();
  });
  $('#inbox-gmail-form').addEventListener('submit', event => { event.preventDefault(); connectionAction('start', { mailbox: $('#inbox-gmail-address').value }); });
  async function load() {
    sync(); if (!owns()) return;
    show("inbox"); text("#inbox-status", "Loading…");
    const turn = ++epoch;
    try {
      const result = await api.list(); if (!owns() || turn !== epoch) return;
      rows = result.sources; renderList(); const visible = visibleRows();
      text("#inbox-status", visible.length ? "" : rows.length ? "No matches in this view." : "No messages yet.");
      $("#inbox-empty").hidden = rows.length > 0;
      if (selected && drafts.has(selected) && visible.some(source => source.id === selected)) { render(); loadResults(selected); return; }
      selected = null; $('#inbox-reader').hidden = true; $('#inbox-panel').classList.remove('reading');
      const pending = pendingShare(), saved = savedPosition();
      if (saved && rows.some(r => r.id === saved.sourceId && r.revision === saved.sourceRevision))
        positions.set(saved.sourceId, { sourceRevision: saved.sourceRevision, reader: saved.reader, page: saved.page });
      if (visible.length) await open(visible.find(r => r.id === pending?.sourceId)?.id ?? visible.find(r => r.id === saved?.sourceId)?.id ?? visible[0].id);
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
    const d = drafts.get(selected); if (!d || !owns() || !visibleRows().some(source => source.id === selected)) return;
    loadGrants();
    $("#inbox-reader").hidden = false;
    text("#inbox-subject", d.source.subject || "(No subject)");
    const email = d.source.email;
    text("#inbox-source-label", email ? "Email · only you" : d.source.adapter === 'message' ? `${({telegram:'Telegram',sms:'SMS',whatsapp:'WhatsApp'})[d.source.provider]} · only you` : "Sample message · only you");
    $("#inbox-ask").hidden = d.source.adapter === 'message' || Boolean(email) && !d.source.capabilities.share && !pendingShare();
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
    replyUI.update(selected, d);
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
    replyUI.update(selected, d);
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
    replyUI.load(sourceId);
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
  async function loadGrants() {
    const sourceId = selected, capturedOwner = owner, turn = ++grantsEpoch;
    const current = () => owns() && owner === capturedOwner && selected === sourceId && grantsEpoch === turn;
    const list = $("#inbox-grant-list"); list.replaceChildren();
    if (!owns() || !sourceId || !$("#inbox-grants").open) return;
    list.textContent = "Loading…";
    try {
      const result = await api.grants(sourceId); if (!current()) return;
      list.replaceChildren();
      if (!result.grants.length) list.textContent = "No private shares.";
      if (result.hasMore) list.textContent = "Latest 100 shares shown.";
      for (const grant of result.grants) {
        const row = document.createElement("p"), label = document.createElement("span"), button = document.createElement("button");
        const expired = grant.expiresAt <= Date.now();
        label.textContent = `${grant.memberIds.length} recipient${grant.memberIds.length === 1 ? "" : "s"} · ${grant.revoked ? "Revoked" : expired ? "Expired" : "Private share"} `;
        label.title = grant.memberIds.join(", "); row.append(label);
        if (!grant.revoked && !expired) {
          button.type = "button"; button.textContent = "Revoke"; button.className = "button ghost";
          const request = { action: "grant.revoke", requestId: crypto.randomUUID(), sourceId, grantId: grant.grantId };
          button.addEventListener("click", async () => {
            if (!current() || button.disabled) return;
            button.disabled = true;
            try { await api.apply(request); if (current()) await loadGrants(); }
            catch { if (current()) { button.disabled = false; button.textContent = "Retry revoke"; } }
          }); row.append(button);
        }
        list.append(row);
      }
    } catch { if (current()) list.textContent = "Couldn’t load private shares. Reopen to retry."; }
  }
  $("#inbox-grants").addEventListener("toggle", loadGrants);
  function updateShareChoice() {
    if (!sharing || !owns()) return;
    const privateShare = $("#inbox-share-scope").value === "private";
    $("#inbox-share-members").hidden = !privateShare;
    text("#inbox-share-title", privateShare ? "Share privately" : "Share with room");
    text("#inbox-share-boundary", privateShare ? "Only selected recipients and you. Expires in 7 days; copies can’t be recalled."
      : "Selected text becomes room history, including for future members.");
    const count = document.querySelectorAll("#inbox-share-member-list input:checked").length;
    const hasText = sharing.source.adapter === "email" ? Boolean(sharing.selection) : Boolean($("#inbox-share-paragraphs input:checked"));
    $("#inbox-share-confirm").disabled = sharingBusy || (!sharing.request && (!hasText || privateShare && (count === 0 || count > 20)));
  }
  $("#inbox-share-scope").addEventListener("change", updateShareChoice);
  $("#inbox-share-members").addEventListener("change", updateShareChoice);
  async function ask() {
    if (!owns() || !selected) return;
    const d = drafts.get(selected); if (d?.source.adapter === "email" && !d.source.capabilities.share && !pendingShare()) return;
    if (!getRoom()) { show("rooms"); return; }
    $("#inbox-share-dialog").showModal(); text("#inbox-share-status", "Loading…");
    sharing = null; $("#inbox-share-scope").disabled = true; $("#inbox-share-member-list").replaceChildren();
    $("#inbox-share-confirm").disabled = true; $("#inbox-share-paragraphs").replaceChildren();
    const pending = pendingShare(), sourceId = pending?.sourceId ?? selected, turn = ++epoch;
    try {
      const source = await api.read(sourceId), context = await api.context(sourceId, pending?.roomId ?? getRoom().room.id);
      if (!owns() || turn !== epoch || !$("#inbox-share-dialog").open) return;
      if (source.source.revision !== context.sourceRevision) throw new Error("Source changed");
      sharing = { source: source.source, context, request: pending };
      $("#inbox-share-scope").value = pending?.action === "source.grant" ? "private" : "room";
      $("#inbox-share-scope").disabled = Boolean(pending);
      $("#inbox-share-member-list").replaceChildren(...context.members.map(member => {
        const label = document.createElement("label"), input = document.createElement("input");
        input.type = "checkbox"; input.value = member.id; input.checked = pending?.memberIds?.includes(member.id) ?? false;
        input.disabled = Boolean(pending); label.append(input, document.createTextNode(member.displayName + (member.kind === "agent" ? " (agent)" : ""))); return label;
      }));
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
          updateShareChoice();
        };
        for (const event of ["select", "keyup", "mouseup", "touchend"]) input.addEventListener(event, select);
        const all = document.createElement("button");
        all.type = "button"; all.id = "inbox-excerpt-all"; all.textContent = "All text";
        all.title = "Select the message text only; attachments and recipients are not included";
        all.addEventListener("click", () => {
          if (sharing !== selectionOwner || !owns() || sharing.request || sharingBusy) return;
          input.focus(); input.setSelectionRange(0, input.value.length); select();
        });
        $("#inbox-share-paragraphs").replaceChildren(label, all, input, preview);
      }
      text("#inbox-share-status", pending ? "Share unconfirmed. Retry the original selection." : "");
      $("#inbox-share-confirm").textContent = pending ? "Confirm share" : "Share";
      updateShareChoice();
    } catch (error) { if (owns() && turn === epoch) text("#inbox-share-status", "Couldn’t load sharing context. Close and try again."); }
  }
  $("#inbox-share-paragraphs").addEventListener("change", event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    updateShareChoice();
  });
  $("#inbox-share-confirm").addEventListener("click", async () => {
    if (!sharing || sharingBusy || !owns()) return;
    const current = sharing, c = current.context;
    const privateShare = $("#inbox-share-scope").value === "private";
    const memberIds = [...document.querySelectorAll("#inbox-share-member-list input:checked")].map(el => el.value);
    if (!current.request && privateShare && (memberIds.length === 0 || memberIds.length > 20)) return;
    if (!current.request && current.source.adapter === "email" && !current.selection) return;
    current.request ??= { action: privateShare ? "source.grant" : current.source.adapter === "email" ? "source.excerpt" : "source.share", requestId: crypto.randomUUID(), sourceId: current.source.id,
      ...(privateShare ? { memberIds } : {}),
      sourceRevision: c.sourceRevision, roomId: c.roomId, audienceVersion: c.audienceVersion,
      ...(current.source.adapter === "email" ? { selection: current.selection }
        : { paragraphs: [...document.querySelectorAll("#inbox-share-paragraphs input:checked")].map(el => Number(el.value)) }) };
    const retained = persistShare(current.request); sharingBusy = true; $("#inbox-share-confirm").disabled = true;
    $("#inbox-share-scope").disabled = true;
    for (const el of document.querySelectorAll("#inbox-share-member-list input")) el.disabled = true;
    for (const el of document.querySelectorAll("#inbox-share-paragraphs input, #inbox-share-paragraphs textarea, #inbox-share-paragraphs button")) el.disabled = true;
    text("#inbox-share-status", "Sharing…");
    try {
      const result = await api.apply(current.request); if (!owns() || sharing !== current) return;
      persistShare(); $("#inbox-share-dialog").close(); sharing = null; sharingBusy = false;
      if (current.request.action === "source.grant") {
        text("#inbox-status", "Shared privately"); $("#inbox-grants").open = true; await loadGrants(); return;
      }
      show("rooms");
      const navigation = navigationEpoch;
      text("#inbox-status", "Shared"); await onShared(result.receipt, () => owns() && navigation === navigationEpoch
        && !active && !browsing && getRoom()?.room.id === result.receipt.roomId);
    } catch (error) {
      if (!owns() || sharing !== current) return;
      if (["stale_inbox_source", "stale_inbox_audience"].includes(error.code)) {
        persistShare(); current.request = null; sharing = null;
        text("#inbox-share-status", "Source or audience changed. Close and review again.");
      } else if (Number.isSafeInteger(error.status) && error.status < 500) {
        persistShare(); current.request = null; sharing = null; text("#inbox-share-status", "Not shared. Close and try again.");
      } else { text("#inbox-share-status", retained ? "Share unconfirmed. Retry the original selection." : "Share unconfirmed. Keep this tab open and retry.");
        $("#inbox-share-confirm").textContent = "Confirm share"; $("#inbox-share-confirm").disabled = false; }
    } finally { if (sharing === current || sharing === null) sharingBusy = false; }
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
    if (owns() && ([...drafts.values()].some(d => d.dirty || d.pending) || sendUI.hasPending() || replyUI.hasPending())) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") remember(); });
  return { sync, reset, open: () => { if (!active) return load(); },
    detachRoom: () => {
      navigationEpoch++;
      sharing = null; resultPreview = null; resultEpoch++;
      $("#inbox-share-dialog").close(); $("#inbox-result-dialog").close();
      $("#inbox-results").hidden = true; $("#inbox-result-list").replaceChildren();
      sync();
    },
    showRoomList: () => { navigationEpoch++; remember(); active = false; browsing = true; history.replaceState(null, "", "#pr-view/rooms");
      $("#nav-inbox").setAttribute("aria-current", "false"); $("#nav-rooms").setAttribute("aria-current", "page");
      $("#inbox-panel").hidden = true; $("#main").hidden = true;
      $("#account-rooms-panel").hidden = false; onNavigate(); onRooms(); },
    showRooms: () => { if (active || browsing) show("rooms", false); },
    hasPending: () => owns() && ([...drafts.values()].some(d => d.dirty || d.pending) || Boolean(pendingShare()) || sendUI.hasPending() || replyUI.hasPending()) };
}
