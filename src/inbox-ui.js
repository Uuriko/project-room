import { InboxClient, inboxTextVersion } from "./inbox-client.js";
import { installInboxSend, installInboxReplyReview } from "./inbox-send-ui.js";
import { installQuarantineReview } from "./inbox-quarantine-ui.js";
import { validId } from "./events.js";

export function installInbox({ account, room, getRoom, onShared, onOpenWork, onAccountEnded = () => room.endAccess(), onRooms = () => {}, onNavigate = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const api = new InboxClient(account, { onAccessEnded: onAccountEnded });
  const drafts = new Map(), positions = new Map();
  let owner = null, active = false, browsing = false, selected = null, epoch = 0, rows = [], sharing = null, sharingBusy = false, retryShare = null,
    nextCursor = null, paging = false, searchQuery = null, searching = false;
  let navigationEpoch = 0;
  const storageKey = "project-room:pending-private-share:v1";
  const positionKey = "project-room:inbox-position:v1";
  let storage; try { storage = sessionStorage; } catch {}
  let resultPreview = null, resultEpoch = 0, attachmentEpoch = 0, threadEpoch = 0;
  const text = (selector, value) => { $(selector).textContent = value; };
  const ownerKey = () => {
    const s = account.session;
    return s?.authenticated
      ? JSON.stringify([s.account.id, s.account.authEpoch, s.sessionRevision, s.sessionBinding]) : null;
  };
  const owns = () => owner !== null && owner === ownerKey();
  const replyUI = installInboxReplyReview({ api, ownerKey: () => owns() ? owner : null });
  const sendUI = installInboxSend({ api, ownerKey: () => owns() ? owner : null, reviewChanges: async () => {
    const id = selected, d = drafts.get(id); if (!d || !owns()) return;
    await review(id, d); if (owns() && selected === id) render();
  }, onChannelSend: () => loadConnections() });
  // Held-message quarantine review (owner review surface): mounted after
  // ownerKey exists so the section always reads the live owner epoch.
  const quarantineUI = installQuarantineReview({ api, ownerKey: () => owns() ? owner : null });
  function persistShare(request = null) {
    // Only operation metadata; never private bodies, addresses, CSRF or access keys.
    // Sanitize to a whitelist of known-safe fields: a caller bug that attaches
    // source text must not turn sessionStorage into a private-content leak.
    // (2026-09-16: flaky "unknown share" browser test caught content in storage.)
    const sanitize = r => {
      if (!r || typeof r !== "object") return null;
      const out = {};
      for (const k of ["action", "requestId", "sourceId", "sourceRevision", "roomId", "audienceVersion"]) {
        if (r[k] !== undefined) out[k] = r[k];
      }
      if (Array.isArray(r.paragraphs) && r.paragraphs.every(n => Number.isSafeInteger(n))) out.paragraphs = [...r.paragraphs];
      if (r.selection && Number.isSafeInteger(r.selection.start) && Number.isSafeInteger(r.selection.end)) {
        out.selection = { start: r.selection.start, end: r.selection.end };
      }
      return out;
    };
    const clean = request ? sanitize(request) : null;
    retryShare = request;
    try {
      if (!storage) return false;
      clean ? storage.setItem(storageKey, JSON.stringify({ owner, request: clean })) : storage.removeItem(storageKey);
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
    navigationEpoch++;
    if (!preservePending) { try { storage?.removeItem(positionKey); } catch {} }
    sendUI.reset({ preservePending });
    replyUI.reset({ preservePending });
    api.reset(); owner = null; epoch++; active = false; browsing = false; selected = null; rows = []; sharing = null; sharingBusy = false;
    nextCursor = null; paging = false; searchQuery = null; searching = false;
    drafts.clear(); positions.clear(); retryShare = null; if (!preservePending) persistShare();
    connectionEpoch++; connectionNotes.clear(); connectionRecords.clear(); $("#inbox-connections").hidden = true; $("#inbox-connections").replaceChildren();
    filters = { channel: "all", connection: "all", grouped: true, unreadOnly: false }; $("#inbox-filters").hidden = true; $("#inbox-group-toggle").checked = true;
    const unreadToggle = $("#inbox-unread-toggle"); if (unreadToggle) unreadToggle.checked = false;
    for (const selector of ["#inbox-filter-channel", "#inbox-filter-connection"]) { $(selector).replaceChildren(); $(selector).value = ""; }
    $("#inbox-connection-form").reset(); $("#inbox-add-connection").open = false; $("#inbox-add-connection").hidden = true; text("#inbox-connection-form-status", ""); text("#inbox-attention-count", "");
    $("#workspace-nav").hidden = true; $("#inbox-panel").hidden = true; $("#inbox-share-dialog").close();
    $("#account-rooms-panel").hidden = true;
    resultPreview = null; resultEpoch++; $("#inbox-result-dialog").close(); $("#inbox-results").hidden = true;
    for (const selector of ["#inbox-result-list", "#inbox-result-body", "#inbox-replaced-draft", "#inbox-result-status", "#inbox-origin"]) $(selector).replaceChildren();
    $("#inbox-panel").classList.remove("reading");
    $("#nav-inbox").setAttribute("aria-current", "false"); $("#nav-rooms").setAttribute("aria-current", "page");
    for (const selector of ["#inbox-list", "#inbox-source-body", "#inbox-subject", "#inbox-addresses", "#inbox-draft-status", "#inbox-status", "#inbox-remote-draft", "#inbox-share-paragraphs", "#inbox-share-audience", "#inbox-share-status"]) $(selector).replaceChildren();
    $("#inbox-draft").value = ""; $("#inbox-reader").hidden = true; $("#inbox-conflict").hidden = true;
    $("#inbox-email-details").hidden = true; $("#inbox-email-details").open = false;
    $("#inbox-email-metadata").replaceChildren(); text("#inbox-source-notice", ""); $("#inbox-source-notice").hidden = true; $("#inbox-addressed").hidden = true;
    attachmentEpoch++; $("#inbox-attachments").hidden = true; $("#inbox-attachment-list").replaceChildren();
    threadEpoch++; $("#inbox-thread").hidden = true; $("#inbox-thread-list").replaceChildren();
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
  const channelLabel = { email: "Email", telegram: "Telegram", whatsapp: "WhatsApp" };
  const stateLabel = { active: "connected", disconnected: "disconnected", reconnect_required: "reconnect required" };
  // One group per connection (email, Telegram, ...) plus the sample messages.
  const groupLabel = c => c ? `${channelLabel[c.channel] ?? c.channel} · ${connectionName(c.id) ?? stateLabel[c.state] ?? c.state}` : "Sample messages";
  const connectionName = id => { const c = connectionRecords.get(id)?.connection; return c ? (c.identity.displayName || c.identity.handle || c.externalId) : null; };
  // One list across channels. Filters narrow by channel or connection; grouping
  // (the default) keeps one section per connection, off gives one flat list.
  let filters = { channel: "all", connection: "all", grouped: true, unreadOnly: false };
  const rowChannel = source => source.connection?.channel ?? "sample", rowConnection = source => source.connection?.id ?? "sample";
  const visibleRows = () => rows.filter(source => (filters.channel === "all" || rowChannel(source) === filters.channel)
    && (filters.connection === "all" || rowConnection(source) === filters.connection)
    && (!filters.unreadOnly || !source.readAt));
  function renderFilters() {
    $("#inbox-filters").hidden = rows.length === 0;
    const option = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; };
    const present = new Map(rows.map(source => [rowChannel(source), null]));
    if (!present.has(filters.channel)) filters.channel = "all";
    $("#inbox-filter-channel").replaceChildren(option("all", "All channels"), ...[...present.keys()].map(key => option(key, key === "sample" ? "Samples" : channelLabel[key] ?? key)));
    $("#inbox-filter-channel").value = filters.channel;
    const connections = new Map();
    for (const source of rows) if (source.connection && !connections.has(source.connection.id)) connections.set(source.connection.id, source.connection);
    if (filters.connection !== "all" && filters.connection !== "sample" && !connections.has(filters.connection)) filters.connection = "all";
    $("#inbox-filter-connection").replaceChildren(option("all", "All connections"),
      ...[...connections.values()].map(c => option(c.id, `${channelLabel[c.channel] ?? c.channel} · ${connectionName(c.id) ?? c.id}`)),
      ...(rows.some(source => !source.connection) ? [option("sample", "Sample messages")] : []));
    $("#inbox-filter-connection").value = filters.connection;
    $("#inbox-group-toggle").checked = filters.grouped;
  }
  function row(source) {
    const button = document.createElement("button"); button.type = "button"; button.className = "inbox-row";
    button.dataset.sourceId = source.id; button.dataset.channel = rowChannel(source); button.dataset.needsYou = source.needsYou ? "true" : "false";
    button.dataset.read = source.readAt ? "true" : "false";
    button.setAttribute("aria-current", selected === source.id ? "true" : "false");
    const meta = document.createElement("span"), sender = document.createElement("span"), badge = document.createElement("span"), subject = document.createElement("strong");
    meta.className = "inbox-row-meta"; sender.textContent = source.sender; badge.className = "inbox-channel-badge";
    badge.textContent = source.connection ? channelLabel[source.connection.channel] ?? source.connection.channel : "Sample";
    meta.append(badge, sender);
    if (source.needsYou) { const mark = document.createElement("span"); mark.className = "inbox-needs-you"; mark.textContent = "Needs you"; meta.append(mark); }
    subject.textContent = source.subject || "(No subject)";
    if (!source.readAt) subject.style.fontWeight = "700";
    button.append(meta, subject); button.addEventListener("click", () => open(source.id)); return button;
  }
  function renderList() {
    const visible = visibleRows(), list = $("#inbox-list");
    if (!filters.grouped) { list.replaceChildren(...visible.map(row)); }
    else {
      const groups = new Map();
      for (const source of visible) {
        const key = source.connection ? source.connection.channel + ":" + source.connection.id : "sample";
        if (!groups.has(key)) groups.set(key, { connection: source.connection ?? null, sources: [] });
        groups.get(key).sources.push(source);
      }
      list.replaceChildren(...[...groups.entries()].map(([key, group], index) => {
        const section = document.createElement("section"); section.className = "inbox-group"; section.dataset.connectionId = group.connection?.id ?? "";
        const heading = document.createElement("h2"); heading.className = "inbox-group-label form-hint"; heading.id = "inbox-group-" + index;
        heading.textContent = groupLabel(group.connection); section.setAttribute("aria-labelledby", heading.id);
        section.append(heading, ...group.sources.map(row));
        return section;
      }));
    }
    if (rows.length && !visible.length) text("#inbox-status", "No messages match these filters."); else if (rows.length && $("#inbox-status").textContent === "No messages match these filters.") text("#inbox-status", "");
    const needing = rows.filter(source => source.needsYou).length;
    text("#inbox-attention-count", needing ? `(${needing} need you)` : "");
    // Paged list: a "Show more" button appears while the server has another
    // page. It is built here so no static markup changes are needed.
    if (nextCursor) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button"; moreBtn.className = "inbox-show-more"; moreBtn.textContent = "Show more";
      moreBtn.addEventListener("click", more);
      list.append(moreBtn);
    }
  }
  // Append the next page without disturbing selection or filters. Rows are
  // keyed by id so a repeated cursor can never duplicate a row.
  async function more() {
    if (!owns() || !nextCursor || paging) return;
    paging = true; text("#inbox-status", "Loading more…");
    const turn = ++epoch;
    try {
      const result = await api.list({ cursor: nextCursor }); if (!owns() || turn !== epoch) return;
      const seen = new Set(rows.map(source => source.id));
      rows.push(...result.sources.filter(source => !seen.has(source.id)));
      nextCursor = result.nextCursor ?? null;
      renderFilters(); renderList();
      text("#inbox-status", rows.length ? "" : "No messages yet.");
    } catch (error) { if (owns() && turn === epoch) text("#inbox-status", errorText(error)); }
    paging = false;
  }
  $("#inbox-filter-channel").addEventListener("change", () => { filters.channel = $("#inbox-filter-channel").value; if (owns()) renderList(); });
  $("#inbox-filter-connection").addEventListener("change", () => { filters.connection = $("#inbox-filter-connection").value; if (owns()) renderList(); });
  $("#inbox-group-toggle").addEventListener("change", () => { filters.grouped = $("#inbox-group-toggle").checked; if (owns()) renderList(); });
  // The unread filter is built here so no static markup changes are needed.
  if (!$("#inbox-unread-toggle")) {
    const label = document.createElement("label"); label.className = "inbox-filter-toggle";
    const box = document.createElement("input"); box.id = "inbox-unread-toggle"; box.type = "checkbox";
    label.append(box, document.createTextNode(" Unread only"));
    $("#inbox-filters").append(label);
    box.addEventListener("change", () => { filters.unreadOnly = box.checked; if (owns()) renderList(); });
  }
  // Full-text search over the account's visible sources, built here so no
  // static markup changes are needed. Searching replaces the list with the
  // ranked results; clearing restores the paged list.
  if (!$("#inbox-search-form")) {
    const form = document.createElement("form"); form.id = "inbox-search-form"; form.className = "inbox-search";
    const input = document.createElement("input"); input.id = "inbox-search-input"; input.type = "search";
    input.placeholder = "Search messages…"; input.setAttribute("aria-label", "Search messages");
    const go = document.createElement("button"); go.type = "submit"; go.className = "button secondary"; go.textContent = "Search";
    const clear = document.createElement("button"); clear.type = "button"; clear.id = "inbox-search-clear";
    clear.className = "button secondary"; clear.textContent = "Clear"; clear.hidden = true;
    form.append(input, go, clear);
    $("#inbox-filters").append(form);
    form.addEventListener("submit", event => { event.preventDefault(); runSearch(input.value); });
    clear.addEventListener("click", () => { input.value = ""; clearSearch(); });
  }
  async function runSearch(query) {
    if (!owns() || searching) return;
    const q = query.trim();
    if (!q) { clearSearch(); return; }
    searching = true; searchQuery = q; text("#inbox-status", `Searching for “${q}”…`);
    const turn = ++epoch;
    try {
      const result = await api.search({ query: q }); if (!owns() || turn !== epoch) return;
      rows = result.results.map(r => r.source); nextCursor = null;
      renderFilters(); renderList();
      const clear = $("#inbox-search-clear"); if (clear) clear.hidden = false;
      text("#inbox-status", result.total ? `${result.total} result${result.total === 1 ? "" : "s"} for “${result.query}”.` : `No results for “${result.query}”.`);
    } catch (error) { if (owns() && turn === epoch) { searchQuery = null; text("#inbox-status", errorText(error)); } }
    searching = false;
  }
  function clearSearch() {
    if (searchQuery === null) return;
    searchQuery = null; const clear = $("#inbox-search-clear"); if (clear) clear.hidden = true;
    load();
  }
  // Read/unread toggle next to "Ask room": read state is a marker, not a new
  // source version, so drafts and their revision pins are unaffected.
  const readToggle = document.createElement("button");
  readToggle.type = "button"; readToggle.id = "inbox-read-toggle"; readToggle.className = "button secondary"; readToggle.hidden = true;
  $("#inbox-ask").before(readToggle);
  readToggle.addEventListener("click", async () => {
    const sourceId = selected, d = drafts.get(sourceId);
    if (!d || d.busy || !owns()) return;
    const action = d.source.readAt ? "source.unread" : "source.read";
    readToggle.disabled = true;
    try {
      const result = await api.apply({ action, requestId: crypto.randomUUID(), sourceId, expectedRevision: d.source.revision });
      if (!owns() || drafts.get(sourceId) !== d) return;
      d.source.readAt = result.receipt.readAt;
      const listed = rows.find(r => r.id === sourceId);
      if (listed) listed.readAt = result.receipt.readAt;
      renderList();
    } catch (error) {
      if (!owns() || drafts.get(sourceId) !== d) return;
      text("#inbox-draft-status", error.code === "stale_inbox_source" ? "Changed elsewhere. Refresh to retry." : "Couldn’t update read state. Try again.");
    } finally { if (owns() && drafts.get(sourceId) === d) render(); }
  });
  // Connection cards: one per configured connection, with the live Telegram facts
  // (binding state, webhook, last delivery, last send) and the import trigger.
  let connectionEpoch = 0; const connectionNotes = new Map(), connectionRecords = new Map(), removing = new Set();
  const when = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "none yet";
  const rotationLine = rotation => !rotation || rotation.state === "none" ? null : rotation.state === "pending"
    ? "Secret rotation: pending · previous secret accepted until " + when(rotation.windowExpiresAt) : "Secret rotation: complete";
  const liveLines = live => !live ? [] : [
    live.state === "configured" ? "Live: configured" : live.state === "invalid" ? "Live: invalid binding · " + live.invalid.join(", ") : "Live: not configured · set " + live.missing.join(", "),
    { unset: "Webhook: not registered", set: "Webhook: secret stored " + when(live.webhookSetAt), matches: "Webhook: registered " + when(live.webhookSetAt), differs: "Webhook: stored secret differs from the binding · use Reconnect" }[live.webhook],
    "Last update received: " + when(live.lastUpdateReceivedAt),
    "Last send: " + (live.lastSendResult ? live.lastSendResult.outcome + (live.lastSendResult.code ? " · " + live.lastSendResult.code : "") + " · " + when(live.lastSendResult.at) : "none yet"),
    rotationLine(live.rotation)
  ].filter(Boolean);
  // Email has no live path yet: the mailbox is a recorded fixture until routing lands.
  const emailLines = record => [record.mode === "fixture" ? "Inbound: fixture mailbox · not yet routed" : "Inbound: routed", "Sending: not available",
    "Last update received: " + when(record.webhookSetAt ?? null).replace("none yet", "fixture only")];
  // WhatsApp has no live path yet: pairing is recorded from a last-four fingerprint,
  // inbound stays unrouted and sending is unavailable until a live adapter lands.
  const whatsappLines = record => ["Pairing: required · link the number", "Inbound: not yet routed", "Sending: not available",
    "Last update received: " + when(record.webhookSetAt ?? null).replace("none yet", "none recorded")];
  function renderConnections(records) {
    const container = $("#inbox-connections");
    container.hidden = !records.length;
    $("#inbox-add-connection").hidden = false;
    container.replaceChildren(...records.map(record => {
      const c = record.connection, card = document.createElement("article"); card.className = "inbox-connection-card"; card.dataset.connectionId = c.id;
      card.dataset.liveState = record.live?.state ?? "fixture"; card.dataset.connectionState = c.state;
      const heading = document.createElement("h2"); heading.className = "form-hint"; heading.textContent = `${channelLabel[c.channel] ?? c.channel} · ${c.identity.displayName || c.identity.handle || c.externalId}`;
      const status = document.createElement("p"); status.className = "inbox-connection-state"; status.textContent = stateLabel[c.state] ?? c.state;
      const facts = document.createElement("ul"); facts.className = "inbox-connection-facts";
      for (const line of record.live ? liveLines(record.live) : c.channel === "email" ? emailLines(record) : c.channel === "whatsapp" ? whatsappLines(record) : []) { const item = document.createElement("li"); item.textContent = line; facts.append(item); }
      card.append(heading, status, facts);
      const actions = document.createElement("div"), note = document.createElement("span");
      actions.className = "inbox-connection-actions"; note.className = "inbox-connection-note"; note.setAttribute("role", "status"); note.textContent = connectionNotes.get(c.id) ?? "";
      if (record.live) {
        const button = document.createElement("button"); button.type = "button"; button.className = "button ghost"; button.textContent = "Reconnect";
        button.setAttribute("aria-label", "Reconnect " + heading.textContent); button.disabled = c.state !== "active";
        button.addEventListener("click", () => reconnect(c.id, button, note)); actions.append(button);
      }
      if (c.state !== "disconnected") {
        // Two deliberate clicks, no native dialog: Remove, then Confirm remove (or Keep).
        const remove = document.createElement("button"), keep = document.createElement("button");
        remove.type = "button"; remove.className = "button ghost"; remove.dataset.remove = c.id;
        remove.textContent = removing.has(c.id) ? "Confirm remove" : "Remove"; remove.setAttribute("aria-label", (removing.has(c.id) ? "Confirm remove " : "Remove ") + heading.textContent);
        keep.type = "button"; keep.className = "text-button"; keep.textContent = "Keep"; keep.hidden = !removing.has(c.id);
        remove.addEventListener("click", () => { if (removing.has(c.id)) disconnect(c, remove, note); else { removing.add(c.id); renderConnections(records); container.querySelector(`[data-connection-id="${c.id}"] [data-remove]`)?.focus(); } });
        keep.addEventListener("click", () => { removing.delete(c.id); renderConnections(records); container.querySelector(`[data-connection-id="${c.id}"] [data-remove]`)?.focus(); });
        actions.append(remove, keep);
      }
      actions.append(note); card.append(actions);
      return card;
    }));
  }
  async function loadConnections() {
    if (!owns()) return;
    const turn = ++connectionEpoch;
    try {
      const listed = await api.connections(); if (!owns() || turn !== connectionEpoch) return;
      const records = [];
      for (const c of listed.connections) { const record = await api.connection(c.id); if (!owns() || turn !== connectionEpoch) return; records.push(record); }
      connectionRecords.clear(); for (const record of records) connectionRecords.set(record.connection.id, record);
      renderConnections(records); if (rows.length) { renderFilters(); renderList(); }
    } catch { if (owns() && turn === connectionEpoch) renderConnections([]); }
  }
  async function disconnect(c, button, note) {
    if (!owns() || button.disabled) return;
    button.disabled = true; note.textContent = "Removing…";
    try {
      await api.applyConnection({ action: "connection.disconnect", requestId: crypto.randomUUID(), connectionId: c.id, expectedRevision: c.revision }); if (!owns()) return;
      removing.delete(c.id); connectionNotes.set(c.id, "Removed · saved copies stay in the inbox");
      await loadConnections(); load();
    } catch (error) {
      if (!owns()) return;
      removing.delete(c.id);
      connectionNotes.set(c.id, error.code === "stale_email_connection" ? "Connection changed elsewhere. Refresh and try again." : error.code === "rate_limited" ? "Too many attempts. Try again in a minute." : "Couldn’t remove. Try again.");
      await loadConnections();
    }
  }
  // Add connection: a bot record for Telegram (bot id, username, name) or a
  // fixture mailbox for email (address, name). The owner's session is the authority;
  // the server validates the profile and refuses another account's id.
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  function connectionProfile(form, accountId) {
    const value = name => form.elements[name].value.trim(), channel = value("channel"), id = value("id");
    if (!idPattern.test(id)) throw new Error("Connection id: letters, digits, . _ : - only.");
    const existing = connectionRecords.get(id)?.connection ?? null, revision = (existing?.revision ?? 0) + 1;
    if (existing && existing.channel !== channel) throw new Error("That id belongs to a " + (channelLabel[existing.channel] ?? existing.channel) + " connection.");
    if (channel === "telegram") {
      const botId = value("bot-id"), username = value("username").replace(/^@/, ""), displayName = value("name") || username;
      if (!/^\d{1,20}$/.test(botId)) throw new Error("Bot id: the digits before the colon in the BotFather token.");
      if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) throw new Error("Bot username: 4 to 32 letters, digits or underscores.");
      return { revision, profile: { accountId, id, revision, channel, provider: "telegram-bot", externalId: botId,
        identity: { kind: "bot", id: botId, handle: "@" + username, displayName }, capabilities: { read: true, send: true, threads: true, edit: true } } };
    }
    if (channel === "whatsapp") {
      // Pairing-required channel: validate E.164, but keep only the last-four
      // fingerprint in the profile. The full number never leaves this form.
      const phone = value("phone");
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Phone: E.164 format, e.g. +15551234567.");
      const last4 = phone.slice(-4), displayName = value("name") || "WhatsApp …" + last4;
      return { revision, profile: { accountId, id, revision, channel, provider: "whatsapp-cloud", externalId: "wa-" + last4,
        identity: { kind: "user", id: "wa:" + last4, handle: "…" + last4, displayName }, capabilities: { read: true, send: false, threads: true, edit: false } } };
    }
    const address = value("address").toLowerCase(), name = value("name") || address;
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(address) || address.length > 320) throw new Error("Address: one mailbox address.");
    return { revision, profile: { accountId, id, revision, provider: "microsoft-graph", mailboxId: address, identity: { name, address }, aliases: [] } };
  }
  $("#inbox-connection-channel").addEventListener("change", () => {
    const channel = $("#inbox-connection-channel").value;
    for (const field of document.querySelectorAll("#inbox-connection-form [data-channel]")) { field.hidden = field.dataset.channel !== channel; for (const input of field.querySelectorAll("input")) input.required = !field.hidden; }
    $("#inbox-connection-id").value = channel === "telegram" ? "telegram-bot" : channel === "whatsapp" ? "whatsapp" : "mailbox";
  });
  $("#inbox-connection-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget, submit = form.querySelector("button[type=submit]");
    if (!owns() || submit.disabled) return;
    let request;
    try {
      const { revision, profile } = connectionProfile(form, account.session.account.id);
      request = { action: "connection.configure", requestId: crypto.randomUUID(), connectionId: profile.id, expectedRevision: revision - 1, profile };
    } catch (error) { text("#inbox-connection-form-status", error.message); return; }
    submit.disabled = true; text("#inbox-connection-form-status", "Adding…");
    try {
      const result = await api.applyConnection(request); if (!owns()) return;
      const c = result.connection;
      connectionNotes.set(c.id, c.channel === "telegram" ? (result.live?.state === "configured" ? "Added · press Reconnect to register the webhook secret" : "Added · set the Telegram bindings, then Reconnect")
        : c.channel === "whatsapp" ? "Added · pairing required, not yet routed"
        : "Added · fixture mailbox, not yet routed");
      text("#inbox-connection-form-status", "Added " + (c.identity.displayName || c.identity.handle || c.externalId) + ".");
      form.reset(); $("#inbox-connection-channel").dispatchEvent(new Event("change"));
      await loadConnections(); $(`.inbox-connection-card[data-connection-id="${c.id}"] h2`)?.scrollIntoView({ block: "nearest" });
    } catch (error) {
      if (!owns()) return;
      text("#inbox-connection-form-status", error.code === "email_mailbox_exists" ? "This account already has a connection for that mailbox or bot."
        : error.code === "email_mailbox_changed" ? "That id already belongs to a different bot or mailbox." : error.code === "email_connection_limit" ? "Connection limit reached (20)."
        : error.code === "rate_limited" ? "Too many attempts. Try again in a minute." : error.status && error.status < 500 ? "Not added. Check the fields and try again." : "Not confirmed. Refresh to see whether it was added.");
    } finally { submit.disabled = false; }
  });
  async function reconnect(connectionId, button, note) {
    if (!owns() || button.disabled) return;
    button.disabled = true; note.textContent = "Reconnecting…";
    try {
      const result = await api.reconnectConnection(connectionId, crypto.randomUUID()); if (!owns()) return;
      const parts = [result.registered ? "Webhook secret registered" : "", result.imported ? `Imported ${result.imported} ${result.imported === 1 ? "update" : "updates"}` : ""].filter(Boolean);
      connectionNotes.set(connectionId, parts.length ? parts.join(" · ") : "No new updates yet");
      await loadConnections(); if (result.imported) load();
    } catch (error) {
      if (!owns()) return;
      connectionNotes.set(connectionId, error.code === "channel_webhook_unavailable" ? "Webhook delivery is not configured here." : error.code === "rate_limited" ? "Too many attempts. Try again in a minute." : "Couldn’t reconnect. Try again.");
      await loadConnections();
    }
  }
  async function load() {
    sync(); if (!owns()) return;
    show("inbox"); text("#inbox-status", "Loading…");
    const turn = ++epoch;
    loadConnections();
    quarantineUI.refresh();
    try {
      const result = await api.list(); if (!owns() || turn !== epoch) return;
      rows = result.sources; nextCursor = result.nextCursor ?? null; searchQuery = null;
      const clear = $("#inbox-search-clear"); if (clear) clear.hidden = true;
      renderFilters(); renderList(); text("#inbox-status", rows.length ? (visibleRows().length ? "" : "No messages match these filters.") : "No messages yet.");
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
    threadEpoch++; $("#inbox-thread").hidden = true; $("#inbox-thread-list").replaceChildren();
    $("#inbox-panel").classList.add("reading");
    if (drafts.has(sourceId)) { render(); loadResults(sourceId); loadAttachments(sourceId); return; }
    $("#inbox-reader").hidden = true; text("#inbox-status", "Loading…");
    const turn = ++epoch;
    try {
      const result = await api.read(sourceId); if (!owns() || turn !== epoch || selected !== sourceId) return;
      drafts.set(sourceId, { source: result.source, base: result.draft, reviewedSource: result.draft?.sourceRevision ?? result.source.revision,
        body: result.draft?.body ?? "", dirty: false, pending: null, busy: false, conflict: null });
      text("#inbox-status", ""); render(); remember(); loadResults(sourceId); loadAttachments(sourceId);
    } catch (error) { if (owns() && turn === epoch) text("#inbox-status", errorText(error)); }
  }
  function render() {
    const d = drafts.get(selected); if (!d || !owns()) return;
    $("#inbox-reader").hidden = false;
    text("#inbox-subject", d.source.subject || "(No subject)");
    readToggle.hidden = false;
    readToggle.textContent = d.source.readAt ? "Mark unread" : "Mark read";
    readToggle.disabled = d.busy || d.pending;
    const email = d.source.email, channel = d.source.channel, live = connectionRecords.get(rows.find(r => r.id === selected)?.connection?.id)?.live?.state === "configured";
    text("#inbox-source-label", email ? "Sample email · only you" : channel ? `${live ? "" : "Sample "}${channelLabel[channel.channel] ?? channel.channel} message · only you` : "Sample message · only you");
    $("#inbox-ask").hidden = Boolean(email || channel) && !d.source.capabilities.share && !pendingShare();
    $("#inbox-email-details").hidden = !email && !channel;
    const metadata = email ? ["Mailbox: " + d.source.recipient,
      ...["to", "cc", "bcc"].filter(k => email[k].length).map(k => (k === "to" ? "To" : k.toUpperCase()) + ": " + email[k].join(", ")),
      email.attachmentState === "complete" ? (email.attachmentCount ? `${email.attachmentCount} ${email.attachmentCount === 1 ? "attachment" : "attachments"} · files unavailable` : "No attachments")
        : "Attachments " + (email.attachmentState === "partial" ? "partly listed" : "not loaded") + " · files unavailable",
      d.source.capabilities.share ? "Sending unavailable" : "Sharing and sending unavailable"]
      : channel ? ["Bot: " + d.source.recipient, "Chat: " + channel.chat, channel.kind === "channel_post" ? "Channel post" : channel.edited ? "Edited message" : "Message",
        channel.attachmentCount ? `${channel.attachmentCount} ${channel.attachmentCount === 1 ? "attachment" : "attachments"} · files unavailable` : "No attachments",
        (d.source.capabilities.send ? "Replies go through the bot" : "Sending unavailable") + (d.source.capabilities.share ? "" : " · sharing unavailable")] : [];
    $("#inbox-email-metadata").replaceChildren(...metadata.map(value => { const p = document.createElement("p"); p.textContent = value; return p; }));
    const link = email ?? channel;
    const notices = link ? [link.connectionState === "disconnected" ? "Disconnected · saved copy" : link.connectionState === "reconnect_required" ? "Reconnect required · saved copy" : "",
      link.format === "html" ? "HTML preview unavailable." : !d.source.paragraphs[0] ? "No message text." : ""].filter(Boolean) : [];
    $("#inbox-addressed").hidden = !d.source.needsYou;
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
  // Attachment descriptors for the open source, rendered honestly: names,
  // types and sizes only, with downloads marked unavailable. Files were
  // never retained, so there is nothing to offer a download for.
  async function loadAttachments(sourceId) {
    const turn = ++attachmentEpoch;
    $("#inbox-attachments").hidden = true; $("#inbox-attachment-list").replaceChildren();
    const d = drafts.get(sourceId);
    const count = d?.source?.email?.attachmentCount ?? d?.source?.channel?.attachmentCount ?? 0;
    if (!owns() || !getRoom() || !room.ownsAccountSession() || !count) return;
    try {
      const value = await api.attachments(sourceId);
      if (!owns() || selected !== sourceId || turn !== attachmentEpoch) return;
      const rows = value.attachments;
      if (!rows.length) return;
      $("#inbox-attachments").hidden = false;
      $("#inbox-attachment-list").replaceChildren(...rows.map(a => {
        const item = document.createElement("li");
        item.textContent = [a.name ?? "Unnamed attachment", a.contentType, a.size === null ? null : `${a.size} bytes`].filter(Boolean).join(" · ");
        return item;
      }));
    } catch (error) {
      if (owns() && selected === sourceId && turn === attachmentEpoch && error.status !== 404) {
        $("#inbox-attachments").hidden = false;
        text("#inbox-attachment-list", "Attachment details unavailable. Refresh to retry.");
      }
    }
  }
  // The conversation around the open source: entries indented by reply
  // depth, each opening its source. Re-clicking the button refreshes it.
  async function loadThread(sourceId) {
    const turn = ++threadEpoch;
    $("#inbox-thread").hidden = true; $("#inbox-thread-list").replaceChildren();
    if (!owns() || !getRoom() || !room.ownsAccountSession()) return;
    try {
      const value = await api.threads({ sourceId });
      if (!owns() || selected !== sourceId || turn !== threadEpoch) return;
      const thread = value.threads[0];
      if (!thread || thread.entries.length < 2) {
        $("#inbox-thread").hidden = false;
        text("#inbox-thread-list", "No replies in this conversation yet.");
        return;
      }
      $("#inbox-thread").hidden = false;
      $("#inbox-thread-list").replaceChildren(...thread.entries.map(({ depth, source }) => {
        const row = document.createElement("div"), entry = document.createElement("button");
        entry.type = "button"; entry.className = "text-button";
        entry.style.marginLeft = `${Math.min(depth, 6) * 16}px`;
        entry.textContent = `${source.subject || "(No subject)"} · ${source.sender}`;
        if (source.id === sourceId) { entry.disabled = true; entry.textContent += " (this message)"; }
        else entry.addEventListener("click", () => open(source.id));
        row.append(entry); return row;
      }));
    } catch (error) {
      if (owns() && selected === sourceId && turn === threadEpoch && error.status !== 404) {
        $("#inbox-thread").hidden = false;
        text("#inbox-thread-list", "Conversation unavailable. Refresh to retry.");
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
    const d = drafts.get(selected); if (d && d.source.adapter !== "synthetic" && !d.source.capabilities.share && !pendingShare()) return;
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
      if (!pending && source.source.adapter !== "synthetic") {
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
          const body = (source.source.adapter === "email" ? "Shared email excerpt" : "Shared message excerpt") + "\n\n" + value;
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
    if (!current.request && current.source.adapter !== "synthetic" && !current.selection) return;
    current.request ??= { action: current.source.adapter !== "synthetic" ? "source.excerpt" : "source.share", requestId: crypto.randomUUID(), sourceId: current.source.id,
      sourceRevision: c.sourceRevision, roomId: c.roomId, audienceVersion: c.audienceVersion,
      ...(current.source.adapter !== "synthetic" ? { selection: current.selection }
        : { paragraphs: [...document.querySelectorAll("#inbox-share-paragraphs input:checked")].map(el => Number(el.value)) }) };
    const retained = persistShare(current.request); sharingBusy = true; $("#inbox-share-confirm").disabled = true;
    for (const el of document.querySelectorAll("#inbox-share-paragraphs input, #inbox-share-paragraphs textarea")) el.disabled = true;
    text("#inbox-share-status", "Sharing…");
    try {
      const result = await api.apply(current.request); if (!owns() || sharing !== current) return;
      persistShare(); $("#inbox-share-dialog").close(); sharing = null; sharingBusy = false; show("rooms");
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
    } finally { sharingBusy = false; } // Only one share is in flight at a time; a dialog reopened mid-flight must not stay locked.
  });
  $("#inbox-share-close").addEventListener("click", () => $("#inbox-share-dialog").close());
  $("#inbox-ask").addEventListener("click", ask);
    $("#inbox-thread-toggle").addEventListener("click", () => { if (selected) loadThread(selected); });
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
