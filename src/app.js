import { EVENT_TYPES as T, WORK_STATES as S } from "./events.js";
import { RoomClient, draftCommand } from "./client.js";
import { ReturnBrief } from "./return-brief.js";
import { verificationSatisfied, matchesReceipt, workStatus } from "./work-status.js";
import { REACTIONS, conversationIndex, searchMessages, ConversationDrafts, DraftRecovery } from "./conversation.js";

const $ = selector => document.querySelector(selector);
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
let workDraftId = null, replyToId = null, busy = false;
let submission = null;
let currentThreadId = null, conversation = null, drafts = new ConversationDrafts();
const viewPositions = new Map(), pendingReactions = new Map(), locallyOwnedMessageIds = new Set();
let newVisibleMessages = 0;
let signoutOperationId = 0, signoutLoading = false;
let refreshOperationId = 0;
let noticeTimer = null, noticeVersion = 0, workFormOpener = null;
let recovery;
let leavingPage = false;
try { recovery = new DraftRecovery(window.sessionStorage); } catch { recovery = new DraftRecovery(null); }
const draftScope = identity => JSON.stringify([identity.roomId, identity.member.id]);
const client = new RoomClient({
  onSnapshot(snapshot, identity) {
    const firstSnapshot = !state;
    state = snapshot.state; session = identity;
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#auth-panel").setAttribute("aria-busy", "false");
    $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
    $("#identity-label").textContent = `${memberLabel(session.member.id)} · ${session.member.kind}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
    if (firstSnapshot) {
      const saved = recovery.read(draftScope(identity), state);
      if (saved) {
        drafts = saved.drafts; currentThreadId = saved.threadId;
        const draft = drafts.get(currentThreadId);
        $("#message-input").value = draft.body; $("#message-to-select").value = draft.toMemberId;
        replyToId = draft.replyToId; pendingMessage = draft.pending;
        $("#remember-drafts").checked = true;
        updateReply(); renderMessages();
        $("#draft-recovery-status").textContent = "Recovered drafts for this room. Review before sending.";
      }
    }
    if (!briefView.owns(briefView.chain)) loadReturnBrief();
    if (firstSnapshot) revealLocationHash();
  },
  onStatus(text) { setConnectionStatus(text); },
  onAccessEnded() {
    const pendingSignout = signoutLoading;
    if (!leavingPage) recovery.clear();
    releaseSubmission();
    state = null; session = null; pendingMessage = null; pendingWork = null; pendingAction = null;
    workDraftId = null; replyToId = null;
    currentThreadId = null; conversation = null; drafts = new ConversationDrafts();
    renderComposerError();
    viewPositions.clear(); pendingReactions.clear(); locallyOwnedMessageIds.clear(); newVisibleMessages = 0; briefView.reset();
    if (!pendingSignout) signoutOperationId += 1;
    refreshOperationId += 1;
    $("#signout-button").disabled = pendingSignout;
    workFormOpener = null; clearNotice();
    $("#main").hidden = true; $("#auth-panel").hidden = false; $("#signout-button").hidden = true;
    $("#auth-panel").setAttribute("aria-busy", pendingSignout ? "true" : "false");
    $("#identity-label").textContent = "Not signed in";
    for (const id of ["message-list", "work-list", "event-list", "presence-list", "member-stack", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "message-count", "event-count", "rb-attention-list", "rb-involving-list", "rb-history-list"]) $(`#${id}`).replaceChildren();
    delete $("#summary-grid")._content;
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) form.reset();
    for (const control of document.querySelectorAll("#auth-form input, #auth-form button")) control.disabled = pendingSignout;
    setFormStatus($("#new-work-status"), ""); setFormStatus($("#action-error"), ""); setFormStatus($("#composer-status"), "");
    $("#action-dialog").close(); $("#new-work-form").hidden = true; $("#reply-bar").hidden = true;
    $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = "";
    $("#thread-title").textContent = ""; $("#thread-context").textContent = "";
    $("#thread-bar").hidden = true; $("#search-results").hidden = true; $("#new-messages-button").hidden = true;
    $("#conversation-announcement").textContent = ""; delete $("#message-list").dataset.view;
    for (const id of ["rb-attention-list", "rb-involving-list", "rb-history-list"]) delete $(`#${id}`)._content;
    $("#rb-current-boundary").textContent = ""; $("#rb-history-boundary").textContent = "";
    $("#rb-ack-button").textContent = "Mark caught up"; $("#return-brief-panel").open = false;
    renderReturnBrief();
    setFormStatus($("#auth-error"), "Sign in with an active room key. Session ended; private drafts were cleared.", true);
    setConnectionStatus("Not connected");
    if (!pendingSignout) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
  }
});
const briefView = new ReturnBrief(client, {
  onChange: renderReturnBrief,
  // A recoverable catch-up error belongs to its own status region. It does not
  // establish that the room's separate live connection has disconnected.
  onError: error => { if ([401, 403].includes(error.status)) client.handleFailure(error); },
  onReconciliationFailure: () => {
    if (state) notice("Your caught-up position was saved, but the latest room view could not be refreshed. Refresh before relying on this brief.", true);
  }
});
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const humanize = value => String(value).replaceAll("_", " ").replaceAll(".", " ");
const memberLabel = id => id == null ? "Unassigned" : state.members[id] ? `${state.members[id].displayName} (${id})` : `Unknown member (${id})`;
const name = id => memberLabel(id);
const can = capability => state?.members[session?.member.id]?.permissions.includes(capability);
const sameSession = (generation, roomId, memberId) => generation === client.generation && state
  && session?.roomId === roomId && session?.member.id === memberId;
const initials = text => esc(text.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase());
const time = value => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
function safeUrl(value) { try { const u = new URL(value); return u.protocol === "https:" ? esc(u.href) : "#"; } catch { return "#"; } }
const recordDomId = (kind, id) => `pr-${kind}-record-${[...String(id)].map(character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
// Keep application-owned fragments outside the valid record-id alphabet. Earlier
// `#work-${id}` links were ambiguous with legacy raw work ids such as `work-123`.
const recordHref = (kind, id) => `#pr-record/${kind}/${encodeURIComponent(id)}`;
const workDomId = id => recordDomId("work", id);
const workHref = id => recordHref("work", id);
function setConnectionStatus(text) {
  const normalized = /^(Reconnecting|Connection interrupted)/.test(text)
    ? "Connection interrupted · reconnecting; displayed history may be stale"
    : text;
  const status = $("#connection-status");
  if (status.textContent !== normalized) status.textContent = normalized;
}
function setFormStatus(status, text, error = false) {
  status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text) && error);
}
function clearNotice() {
  noticeVersion += 1;
  clearTimeout(noticeTimer);
  noticeTimer = null;
  const status = $("#status");
  status.textContent = "";
  status.classList.remove("visible", "error");
}
function notice(text, error = false) {
  const status = $("#status"), version = ++noticeVersion;
  clearTimeout(noticeTimer);
  const show = () => {
    if (version !== noticeVersion) return;
    status.textContent = text;
    status.classList.add("visible");
    status.classList.toggle("error", error);
    noticeTimer = setTimeout(() => {
      if (version !== noticeVersion) return;
      status.classList.remove("visible", "error");
      status.textContent = "";
    }, error ? 10000 : 6000);
  };
  // Repeated successful actions still deserve one fresh status announcement each.
  if (status.textContent === text) { status.textContent = ""; queueMicrotask(show); }
  else show();
}
function handleFailureNotice(error) {
  client.handleFailure(error);
  if (state) notice(error.message, true);
}
function selectOptions(selector, members, blank) {
  const select = $(selector), previous = select.value;
  const signature = JSON.stringify(members.map(m => [m.id, m.displayName]));
  if (select.dataset.signature === signature) return;
  select.innerHTML = `<option value="">${esc(blank)}</option>${members.map(m => `<option value="${esc(m.id)}">${esc(memberLabel(m.id))} · ${esc(m.kind)}</option>`).join("")}`;
  if (previous && !members.some(m => m.id === previous)) select.insertAdjacentHTML("beforeend", `<option value="${esc(previous)}" disabled>Previously selected member unavailable — choose again</option>`);
  if (previous) select.value = previous;
  select.dataset.signature = signature;
}
// Quiet Focus A1/A2: a background snapshot must not collapse open disclosures or
// steal focus. Capture keyed disclosure + focus state before replacing list
// contents, restore it after. Keys are stable per host record, never positional.
function disclosureKey(details) {
  const host = details.closest("[data-disclosure-host]");
  return (host ? host.dataset.disclosureHost : "root") + ">" + (details.className || "details");
}
function captureDisclosures(container) {
  const openKeys = new Set();
  container.querySelectorAll("details[open]").forEach(d => openKeys.add(disclosureKey(d)));
  const active = document.activeElement;
  const focusKey = active && container.contains(active) ? active.dataset.focusKey ?? null : null;
  const focusHost = active && container.contains(active) ? active.closest("[data-disclosure-host]")?.dataset.disclosureHost ?? null : null;
  return { openKeys, focusKey, focusHost };
}
function restoreDisclosures(container, snap) {
  container.querySelectorAll("details").forEach(d => {
    if (snap.openKeys.has(disclosureKey(d))) d.open = true;
  });
  if (!snap.focusKey) return;
  const exact = [...container.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === snap.focusKey);
  const fallback = snap.focusHost
    ? [...container.querySelectorAll("[data-disclosure-host]")].find(node => node.dataset.disclosureHost === snap.focusHost)
    : null;
  (exact || fallback)?.focus({ preventScroll: true });
}
function render() {
  conversation = conversationIndex(state.messages);
  const members = Object.values(state.members), active = members.filter(m => m.active !== false);
  selectOptions("#message-to-select", active, "Everyone in this room");
  selectOptions("#assignee-select", active.filter(m => m.permissions.includes("accept_work") && m.permissions.includes("complete_work")), "Choose accountable member");
  selectOptions("#verifier-select", active.filter(m => m.permissions.includes("verify")), "Choose independent verifier");
  $("#presence-count").textContent = `${active.length} members · presence not measured`;
  $("#member-stack").innerHTML = active.map(m => `<div class="member-avatar ${m.kind}" title="${esc(memberLabel(m.id))}" aria-hidden="true"><span>${initials(m.displayName)}</span></div>`).join("");
  const presenceSnap = captureDisclosures($("#presence-list")), workSnap = captureDisclosures($("#work-list"));
  $("#presence-list").innerHTML = members.map(m => `<div id="${recordDomId("member", m.id)}" class="presence-member" tabindex="-1" data-member-record-id="${esc(m.id)}" data-disclosure-host="${esc(m.id)}" data-focus-key="member:${esc(m.id)}"><div class="member-avatar ${m.kind}" aria-hidden="true"><span>${initials(m.displayName)}</span></div><div><strong>${esc(memberLabel(m.id))}</strong><span>${esc(m.kind)} · ${m.active === false ? "access revoked" : "presence unknown"}</span><details><summary data-focus-key="member-capabilities:${esc(m.id)}">Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p></details></div></div>`).join("");
  $("#new-work-button").disabled = !can("steer"); $("#composer-work-button").disabled = !can("steer");
  const items = Object.values(state.workItems);
  const waiting = items.filter(i => readyForDecision(i) && i.humanDecisionMakerId === session.member.id).length;
  const summaryHtml = `<article class="summary-card"><span>Your decisions</span><strong>${waiting}</strong><p>Completion, verification, and approval stay separate.</p></article><article class="summary-card"><span>Work in this room</span><strong>${items.length}</strong><p>${items.filter(i => i.state === S.BLOCKED).length} blocked. Conversation never creates work automatically.</p></article>`;
  if ($("#summary-grid")._content !== summaryHtml) {
    $("#summary-grid").innerHTML = summaryHtml;
    $("#summary-grid")._content = summaryHtml;
  }
  renderMessages();
  renderSearch();
  $("#work-list").innerHTML = items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(workCard).join("") || '<p class="empty-note">Nothing assigned. A room is useful before it has a task.</p>';
  for (const item of items) {
    const card = workRecord(item.id), status = workStatus(item);
    card.querySelector(".state").textContent = status.label;
    const next = document.createElement("p"); next.className = "work-next";
    next.textContent = `${status.owner ? `Next: ${name(status.owner)}. ` : ""}${status.next}`;
    const updated = document.createElement("p"); updated.className = "form-hint";
    updated.textContent = `Last recorded update: ${new Date(item.updatedAt).toLocaleString()}. Live execution is not measured.`;
    card.querySelector(".work-facts").after(next, updated);
  }
  restoreDisclosures($("#presence-list"), presenceSnap);
  restoreDisclosures($("#work-list"), workSnap);
  $("#event-count").textContent = `${client.sequence}`;
  renderReturnBrief();
  $("#event-list").innerHTML = [...state.eventLog].reverse().map(e => `<li id="${recordDomId("event", e.id)}" tabindex="-1" data-event-record-id="${esc(e.id)}"><span>${esc(humanize(e.type))}</span><strong>${esc(name(e.actorId))}</strong><time datetime="${esc(e.at)}">${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join("");
}
function renderMessages() {
  const list = $("#message-list"), view = currentThreadId ? `thread:${currentThreadId}` : "room";
  const sameView = list.dataset.view === view;
  const messages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots;
  const previous = new Map([...list.children].map(e => [e.dataset.key, e]));
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const anchor = [...list.children].find(e => e.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
  const anchorOffset = anchor?.getBoundingClientRect().top;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.closest("[data-key]")?.dataset.key;
  const focusAction = focused?.dataset.messageAction, focusReaction = focused?.dataset.reaction;
  const focusedMessage = focused?.matches(".message");
  const newMessages = sameView ? messages.filter(m => !previous.has(m.id)) : [];
  const newCount = newMessages.length;
  const pendingOutgoingId = pendingMessage?.command?.data?.messageId || pendingMessage?.command?.id;
  const announceCount = newMessages.filter(message => message.id !== pendingOutgoingId && !locallyOwnedMessageIds.has(message.id)).length;
  newMessages.forEach(message => locallyOwnedMessageIds.delete(message.id));
  $("#message-count").textContent = `${state.messages.length} messages`;
  $("#thread-bar").hidden = !currentThreadId;
  $("#composer-label").textContent = currentThreadId ? "Reply in this thread" : "Message the room";
  if (currentThreadId) {
    const root = conversation.byId.get(currentThreadId);
    $("#thread-title").textContent = `Thread with ${name(root.authorId)}`;
    $("#thread-context").textContent = `${messages.length - 1} replies · visible to everyone in this room`;
  }

  // Retain unchanged message nodes so new arrivals do not discard text selection or focus.
  const keep = new Set(messages.map(m => m.id));
  for (const [id, node] of previous) if (!keep.has(id)) node.remove();
  messages.forEach((message, index) => {
    const node = previous.get(message.id) || document.createElement("li");
    node.id = recordDomId("message", message.id); node.dataset.key = message.id; node.dataset.messageRecordId = message.id;
    node.className = "message"; node.tabIndex = -1;
    const html = messageContent(message);
    if (node._content !== html) {
      if (!node._content) node.innerHTML = html;
      else {
        const next = document.createElement("div"); next.innerHTML = html;
        // Reply counts/reactions change independently; the selected message text stays put.
        for (const selector of [".message-avatar", ".message-meta", ".message-context", ".reactions", ".message-links"]) {
          const before = node.querySelector(selector), after = next.querySelector(selector);
          if (before.innerHTML !== after.innerHTML) before.innerHTML = after.innerHTML;
        }
      }
      node._content = html;
    }
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  if (!messages.length) list.innerHTML = '<li class="empty-note">Start with a hello, a thought, or a question. No task required.</li>';
  list.dataset.view = view;
  if (!sameView) { list.scrollTop = viewPositions.get(view) ?? list.scrollHeight; newVisibleMessages = 0; }
  else if (nearBottom && !focused) { list.scrollTop = list.scrollHeight; newVisibleMessages = 0; }
  else {
    if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
    newVisibleMessages += newCount;
  }
  if (focused && !focused.isConnected) {
    const row = [...list.children].find(e => e.dataset.key === focusKey);
    const replacement = focusedMessage ? row : [...(row?.querySelectorAll("[data-message-action]") || [])].find(e => e.dataset.messageAction === focusAction && e.dataset.reaction === focusReaction);
    replacement?.focus({ preventScroll: true });
  }
  $("#new-messages-button").hidden = newVisibleMessages === 0;
  $("#new-messages-button").textContent = `${newVisibleMessages} new ${newVisibleMessages === 1 ? "message" : "messages"} · jump to latest`;
  if (announceCount) $("#conversation-announcement").textContent = `${announceCount} new ${announceCount === 1 ? "message" : "messages"} in ${currentThreadId ? "this thread" : "the room"}. Room event ${client.sequence}.`;
}
function messageContent(m) {
  const author = state.members[m.authorId];
  const authorLabel = memberLabel(m.authorId);
  const linked = Object.values(state.workItems).filter(i => i.sourceMessageId === m.id || i.id === m.workItemId);
  const parent = conversation.byId.get(m.replyToId);
  const count = (conversation.threads.get(m.id)?.length || 1) - 1;
  const reactionButtons = Object.entries(REACTIONS).map(([reaction, symbol]) => {
    const members = m.reactions?.[reaction] || [], selected = members.includes(session.member.id);
    const pending = pendingReactions.get(`${m.id}:${reaction}`);
    const label = `${pending && !pending.busy ? "Retry " : ""}${reaction}`;
    return `<button type="button" class="reaction" aria-pressed="${selected}" aria-label="${esc(label)} reaction, ${members.length}" title="${esc(members.map(name).join(", ") || `React with ${reaction}`)}" data-message-action="react" data-message-id="${esc(m.id)}" data-reaction="${reaction}"${pending?.busy ? " disabled" : ""}><span aria-hidden="true">${symbol}</span><span>${members.length || ""}</span>${pending && !pending.busy ? " Retry" : ""}</button>`;
  }).join("");
  return `<div class="message-avatar ${author.kind}" aria-hidden="true">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(authorLabel)}</strong><span>${esc(author.kind)}</span><a class="message-time" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" aria-label="Link to message by ${esc(authorLabel)} at ${esc(time(m.createdAt))}"><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a></div><div class="message-context">${m.toMemberId ? `<span class="audience-chip">To ${esc(name(m.toMemberId))} · room-visible</span>` : ""}${parent && parent.id !== currentThreadId ? `<a class="source-link reply-preview" href="${esc(recordHref("message", parent.id))}" data-open-message="${esc(parent.id)}">↳ ${esc(name(parent.authorId))}: ${esc(parent.body.slice(0,90))}</a>` : ""}</div><p>${esc(m.body)}</p><div class="reactions" aria-label="Reactions to message by ${esc(authorLabel)}">${reactionButtons}</div><div class="message-links">${linked.map(i => `<a class="work-link" href="${esc(workHref(i.id))}" data-open-work="${esc(i.id)}">↳ ${esc(i.title)}</a>`).join("")}<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button">Reply</button>${!currentThreadId && count ? `<button class="thread-link" data-message-action="thread" data-message-id="${esc(m.id)}" type="button">${count} ${count === 1 ? "reply" : "replies"} ↗</button>` : ""}${can("steer") ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : ""}</div></div>`;
}
function renderSearch() {
  const query = $("#message-search").value;
  $("#search-results").hidden = !query.trim();
  if (!query.trim()) { $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = ""; return; }
  const result = searchMessages(state, query);
  $("#search-count").textContent = `${result.total} ${result.total === 1 ? "match" : "matches"}${result.total > result.messages.length ? ` · latest ${result.messages.length} shown` : ""} in this room`;
  const list = $("#search-list"), focused = list.contains(document.activeElement) ? document.activeElement.dataset.openMessage : null;
  const html = result.messages.map(m => `<li><a href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}"><strong>${esc(name(m.authorId))}</strong><span>${esc(m.body.slice(0, 240))}</span><small>${m.replyToId ? "Open thread at this reply" : "Open in room"}</small></a></li>`).join("") || '<li class="empty-note">No matches. Try a name or another phrase.</li>';
  if (list._content !== html) { list.innerHTML = html; list._content = html; }
  if (focused) [...list.querySelectorAll("[data-open-message]")].find(e => e.dataset.openMessage === focused)?.focus({ preventScroll: true });
}
function saveComposer() {
  drafts.save(currentThreadId, { body: $("#message-input").value, toMemberId: $("#message-to-select").value, replyToId, pending: pendingMessage });
  persistDrafts();
}
function persistDrafts() {
  if (!session || !$("#remember-drafts").checked) return;
  const saved = recovery.write(draftScope(session), drafts, currentThreadId);
  $("#draft-recovery-status").textContent = saved ? "Draft recovery enabled in this tab for 12 hours. Sign-out clears it." : "Draft recovery unavailable. Keep this page open to retain unsent text.";
}
function renderComposerError() {
  const text = drafts.get(currentThreadId).error || "", local = $("#composer-status");
  if (local.textContent !== text) local.textContent = text;
  local.classList.toggle("visible", Boolean(text)); local.classList.toggle("error", Boolean(text));
}
function setComposerError(text) {
  drafts.save(currentThreadId, { error: text });
  renderComposerError();
}
function switchThread(threadId, focusComposer = false) {
  if (!state || busy || (threadId && !conversation.threads.has(threadId))) return;
  if (threadId !== currentThreadId) {
    saveComposer(); viewPositions.set(currentThreadId ? `thread:${currentThreadId}` : "room", $("#message-list").scrollTop);
    currentThreadId = threadId;
    const draft = drafts.get(threadId);
    $("#message-input").value = draft.body;
    const select = $("#message-to-select");
    if (draft.toMemberId && ![...select.options].some(o => o.value === draft.toMemberId)) {
      select.add(new Option("Previous recipient unavailable — choose again", draft.toMemberId));
      select.options[select.options.length - 1].disabled = true;
    }
    select.value = draft.toMemberId; replyToId = draft.replyToId; pendingMessage = draft.pending;
  }
  updateReply(); renderMessages(); renderComposerError();
  if (focusComposer) $("#message-input").focus();
  else (currentThreadId ? $("#thread-title") : $("#conversation-title")).focus({ preventScroll: true });
}
function revealMessage(id) {
  if (!state || busy || !conversation.byId.has(id)) return;
  const message = conversation.byId.get(id);
  switchThread(message.replyToId ? conversation.rootById.get(id) : null);
  const row = [...$("#message-list").querySelectorAll("[data-message-record-id]")]
    .find(node => node.dataset.messageRecordId === id);
  row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function focusRecord(node) {
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function workRecord(id) {
  return [...$("#work-list").querySelectorAll("[data-work-record-id]")]
    .find(node => node.dataset.workRecordId === id) || null;
}
function revealWork(id) { if (state?.workItems[id] && !busy) focusRecord(workRecord(id)); }
function revealMember(id) {
  if (!state?.members[id] || busy) return;
  focusRecord([...$("#presence-list").querySelectorAll("[data-member-record-id]")]
    .find(node => node.dataset.memberRecordId === id));
}
function revealRoom() { if (state && !busy) focusRecord($("#room-title")); }
function revealEvent(id) {
  if (!state || busy) return;
  $("#record-panel").open = true;
  focusRecord([...$("#event-list").querySelectorAll("[data-event-record-id]")]
    .find(node => node.dataset.eventRecordId === id));
}
function decodeFragment(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
function revealLocationHash() {
  if (!state || !location.hash) return;
  const hash = location.hash;
  const current = /^#pr-record\/(message|work|member|event|room)\/(.+)$/.exec(hash);
  if (current) {
    const id = decodeFragment(current[2]);
    if (id !== null) ({ message: revealMessage, work: revealWork, member: revealMember, event: revealEvent, room: revealRoom }[current[1]])(id);
    return;
  }
  const rawWorkId = decodeFragment(hash.slice(1));
  if (rawWorkId !== null && state.workItems[rawWorkId]) { revealWork(rawWorkId); return; }
  if (hash === "#room-title") { revealRoom(); return; }
  // The first release also emitted namespaced fragments. Preserve those only
  // when they resolve to a real record. Raw legacy work ids take precedence,
  // including valid ids beginning with message-, member-, event-, or work-.
  for (const [prefix, reveal] of [["#message-", revealMessage], ["#work-", revealWork], ["#member-", revealMember], ["#event-", revealEvent]]) {
    if (!hash.startsWith(prefix)) continue;
    const id = decodeFragment(hash.slice(prefix.length));
    const exists = prefix === "#message-" ? conversation.byId.has(id)
      : prefix === "#work-" ? Boolean(state.workItems[id])
      : prefix === "#member-" ? Boolean(state.members[id])
      : state.eventLog.some(event => event.id === id);
    if (id !== null && exists) { reveal(id); return; }
    break;
  }
}
function readyForDecision(i) { return i.ownerDecisionRequired && !matchesReceipt(i.decision, i.receipt) && i.state === S.COMPLETED && verificationSatisfied(i); }
function hasReportedProducer(i) { return i.receipt?.producerAttribution === "reported" && i.receipt.producerId != null; }
function hasIndependentProducer(i) { return hasReportedProducer(i) && i.receipt.producerId !== i.verifierMemberId; }
function activeClaim(i) { return i.claim?.status === "active" && Date.parse(i.claim.expiresAt) > Date.now(); }
function actions(i) {
  const a = [], own = i.accountableMemberId === session.member.id;
  if (own && i.state === S.PROPOSED && can("accept_work")) a.push(["accept", "Accept"]);
  if (own && [S.ACCEPTED, S.WORKING, S.BLOCKED].includes(i.state) && i.mode === "write" && !activeClaim(i) && can("write_external")) a.push(["claim", "Record write scope"]);
  if (own && i.state === S.ACCEPTED && can("accept_work") && (i.mode === "read" || (activeClaim(i) && can("write_external")))) a.push(["start", "Start"]);
  if (own && i.state === S.BLOCKED && can("accept_work")) a.push(["resolve", "Resolve blocker"]);
  if (own && [S.ACCEPTED, S.WORKING].includes(i.state)) {
    if (can("accept_work")) a.push(["block", "Report blocker"]);
    if (can("complete_work") && (i.mode === "read" || (activeClaim(i) && can("write_external")))) a.push(["complete", "Post evidence"]);
  }
  if (own && i.state === S.COMPLETED && can("accept_work")) a.push(["block", "Reopen for rework"]);
  if (i.state === S.COMPLETED && session.member.id === i.verifierMemberId && can("verify") && !i.verification) {
    if (!i.independentVerificationRequired || !hasReportedProducer(i)) a.push(["verify", "Record evidence check"]);
    else if (hasIndependentProducer(i)) a.push(["verify", "Record independent check"]);
  }
  if (readyForDecision(i) && session.member.id === i.humanDecisionMakerId && can("decide")) a.push(["decide", "Record decision"]);
  return a.map(([action, label]) => `<button type="button" class="button secondary" data-action="${action}" data-work-id="${esc(i.id)}" data-focus-key="work-action:${esc(i.id)}:${action}"${busy ? " disabled" : ""}>${label}</button>`).join("");
}
function claimStateLabel(i) {
  if (activeClaim(i)) return "not expired";
  if (i.claim?.status === "superseded") return "superseded";
  if (i.claim?.status === "released") return "released";
  return "expired";
}
function receiptCard(i) {
  if (!i.receipt) return "";
  const receipt = i.receipt;
  const reporter = receipt.reportedById ? memberLabel(receipt.reportedById) : "Unknown reporter";
  const producer = receipt.producerAttribution === "reported" && receipt.producerId
    ? memberLabel(receipt.producerId)
    : "Unknown — no producer was reported";
  let verification = "<p>No verification recorded.</p>";
  if (i.verification) {
    const confirmed = i.verification.independenceConfirmed === true;
    const result = i.verification.result.toUpperCase();
    const resultLabel = result === "PASS" && confirmed ? "INDEPENDENT PASS" : result;
    const independence = result === "PASS" && i.independentVerificationRequired
      ? ` · ${confirmed ? "independence confirmed" : "independence not confirmed"}`
      : "";
    verification = `<p><strong>${esc(resultLabel)}</strong> reported by ${esc(memberLabel(i.verification.verifierId))}${independence}: ${esc(i.verification.summary)}</p>`;
  }
  return `<div class="receipt"><p class="receipt-label">REPORTED COMPLETION · NOT AUTOMATIC VERIFICATION</p><dl class="receipt-attribution"><div><dt>Completion reporter</dt><dd>${esc(reporter)}</dd></div><div><dt>Producer</dt><dd>${esc(producer)}</dd></div></dl><p>${esc(receipt.summary)}</p><a href="${safeUrl(receipt.evidenceUrl)}" target="_blank" rel="noreferrer" data-focus-key="work-evidence:${esc(i.id)}">Open submitted evidence ↗</a><code>${esc(receipt.evidenceVersion)}</code><p>${esc(receipt.nextAction)}</p>${verification}</div>`;
}
function workCard(i) {
  const source = i.sourceMessageId ? `<a class="source-link" href="${esc(recordHref("message", i.sourceMessageId))}" data-open-message="${esc(i.sourceMessageId)}" data-focus-key="work-source:${esc(i.id)}">From this conversation</a>` : "";
  const blocker = i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : "";
  const decision = i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : "";
  const claim = i.claim ? `<details class="claim"><summary data-focus-key="work-claim:${esc(i.id)}">Recorded scope · ${esc(claimStateLabel(i))}</summary><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p><p>Expires ${esc(i.claim.expiresAt)}. This service does not execute external actions.</p></details>` : "";
  return `<article id="${workDomId(i.id)}" class="work-card" tabindex="-1" data-work-record-id="${esc(i.id)}" data-disclosure-host="${esc(i.id)}" data-focus-key="work:${esc(i.id)}"><div class="work-card-header"><span class="state state-${i.state}">${esc(i.state)}</span><span class="mode">${esc(i.mode)} · revision ${i.revision}</span></div><h3>${esc(i.title)}</h3>${source}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(memberLabel(i.accountableMemberId))}</dd></div><div><dt>Verifier</dt><dd>${esc(memberLabel(i.verifierMemberId))}</dd></div></dl>${receiptCard(i)}${blocker}${decision}${claim}<div class="work-actions">${actions(i)}</div></article>`;
}
// Quiet Focus A4: a failed send reports beside the composer that holds the draft,
// not only in the page-level status area; the Send button is the retry and the
// draft clears only after the service acknowledges the retry.
function releaseSubmission(restoreFocus = false) {
  const finished = submission;
  if (finished) {
    finished.controls.forEach((e, i) => e.disabled = finished.disabled[i]);
    finished.form.removeAttribute("aria-busy");
  }
  submission = null; busy = false;
  // Disabling an active form control moves focus to the body. Restore only that
  // displaced focus; a deliberate move elsewhere while waiting wins. Access loss
  // releases controls without restoring any focus from the previous session.
  if (restoreFocus && finished?.focus?.isConnected && !finished.focus.disabled && document.activeElement === document.body) {
    finished.focus.focus({ preventScroll: true });
  }
}
async function submit(form, fn, { failureHint } = {}) {
  if (busy) return;
  busy = true; const controls = [...form.querySelectorAll("button, input, select, textarea")];
  const focus = form.contains(document.activeElement) ? document.activeElement : null;
  const disabled = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
  form.setAttribute("aria-busy", "true");
  const ticket = submission = { form, controls, disabled, focus, generation: client.generation };
  const current = () => submission === ticket && (form.id === "auth-form" || ticket.generation === client.generation);
  const local = form.querySelector(".form-status");
  if (form.id === "message-form") setComposerError("");
  else if (local) { local.textContent = ""; local.classList.remove("visible", "error"); }
  try { await fn(current); }
  catch (error) {
    if (!current()) return;
    const text = `${error.message}. ${failureHint ?? (state ? "Your entries were kept; try again." : "Sign in again.")}`;
    // One live-announcement owner per send result: when the form has its own status region
    // it owns the announcement (the visible composer error); the page-level region stays
    // silent so a screen reader announces the failure exactly once.
    if (local) clearNotice();
    if (form.id === "message-form") setComposerError(text);
    else if (local) setFormStatus(local, text, true);
    else notice(text, true);
  }
  finally { if (current()) { releaseSubmission(true); if (state) render(); } }
}
$("#auth-form").addEventListener("submit", async e => {
  if (signoutLoading) { e.preventDefault(); return; }
  e.preventDefault(); setFormStatus($("#auth-error"), "");
  const accessKey = $("#access-key").value.trim();
  await submit(e.currentTarget, async current => {
    const identity = await client.login(accessKey);
    if (!current() || !identity || !state || session?.member.id !== identity.member.id || session?.roomId !== identity.roomId) return;
    $("#access-key").value = ""; $("#message-input").focus(); notice("Signed in. Welcome to your room.");
  }, { failureHint: "Check the access key and try again." });
  if (state) revealLocationHash();
});
$("#signout-button").addEventListener("click", async () => {
  if (busy || signoutLoading || !state || !session) return;
  saveComposer();
  if (drafts.hasText() || !$("#new-work-form").hidden || $("#action-dialog").open) {
    if (!window.confirm("Sign out and clear unsent drafts on this device?")) return;
  }
  const operationId = ++signoutOperationId;
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const isCurrentOperation = () => operationId === signoutOperationId && sameSession(generation, roomId, memberId);
  signoutLoading = true; $("#signout-button").disabled = true;
  try { await client.logout(); }
  catch (error) {
    if (!isCurrentOperation()) return;
    if ([401, 403].includes(error.status)) client.endAccess();
    else notice("Sign-out could not be confirmed. Session may still be active; retry when connected.", true);
  } finally {
    if (operationId === signoutOperationId) {
      signoutLoading = false;
      $("#auth-panel").setAttribute("aria-busy", "false");
      for (const control of document.querySelectorAll("#auth-form input, #auth-form button")) control.disabled = false;
      if (state) $("#signout-button").disabled = false;
      else {
        const ended = "Sign in with an active room key. Session ended; private drafts were cleared.";
        if ($("#auth-error").textContent !== ended) setFormStatus($("#auth-error"), ended, true);
        queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
      }
    }
  }
});
$("#refresh-button").addEventListener("click", async () => {
  const operationId = ++refreshOperationId;
  const generation = client.generation, roomId = session?.roomId, memberId = session?.member.id;
  try {
    if (!client.session) await client.restore();
    else {
      await client.refresh();
      if (operationId !== refreshOperationId || !sameSession(generation, roomId, memberId)) return;
      client.connect();
    }
  }
  catch (error) {
    if (operationId !== refreshOperationId) return;
    if (roomId && !sameSession(generation, roomId, memberId)) return;
    if (!roomId && client.session) return;
    if (!roomId) {
      const signedOut = [401, 403].includes(error.status);
      setFormStatus($("#auth-error"), signedOut ? "Use a provisioned human room key to enter. No demo identity is selected for you." : "Room service unavailable. Check the service and retry; no connection is claimed.", true);
      setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
      return;
    }
    handleFailureNotice(error);
  }
});
$("#caught-up-button").addEventListener("click", () => briefView.acknowledge(client.sequence));
$("#message-form").addEventListener("submit", e => {
  e.preventDefault(); if (!state) return;
  const content = { body: $("#message-input").value.trim(), toMemberId: $("#message-to-select").value || null, replyToId };
  if (!content.body) return;
  const previous = pendingMessage?.command?.data;
  const unchanged = previous && previous.body === content.body && previous.toMemberId === content.toMemberId && previous.replyToId === content.replyToId;
  const data = { messageId: unchanged ? previous.messageId : crypto.randomUUID(), ...content };
  pendingMessage = draftCommand(pendingMessage, T.MESSAGE_POSTED, data);
  saveComposer();
  const generation = client.generation, threadId = currentThreadId;
  submit(e.currentTarget, async () => {
    // Ownership must outlive pendingMessage: the command can commit while its immediate
    // snapshot fails, then first appear on a later refresh after the draft was cleared.
    locallyOwnedMessageIds.add(data.messageId || pendingMessage.command.id);
    const receipt = await client.send(pendingMessage.command);
    if (generation !== client.generation || !state) return;
    drafts.clear(threadId);
    $("#message-input").value = ""; pendingMessage = null; clearReply();
    persistDrafts();
    notice(`Message saved${threadId ? " in this thread" : " to the room"}.`);
  }, { failureHint: "Draft kept; press Send to retry." });
});
$("#message-list").addEventListener("click", e => {
  const button = e.target.closest("[data-message-id]"); if (!button || !state || busy) return;
  const id = button.dataset.messageId;
  if (button.dataset.messageAction === "work") openWork(id);
  else if (button.dataset.messageAction === "react") setReaction(id, button.dataset.reaction);
  else {
    switchThread(conversation.rootById.get(id), button.dataset.messageAction === "reply");
    if (button.dataset.messageAction === "reply") { replyToId = id; updateReply(); saveComposer(); }
  }
});
function updateReply() {
  const target = conversation?.byId.get(replyToId);
  $("#reply-bar").hidden = !target || replyToId === currentThreadId;
  $("#reply-context").textContent = target ? `Replying to ${name(target.authorId)}: ${target.body.slice(0, 100)}` : "";
}
function clearReply() { replyToId = currentThreadId; updateReply(); }
$("#cancel-reply").addEventListener("click", () => { clearReply(); $("#message-input").focus({ preventScroll: true }); });
$("#thread-back").addEventListener("click", () => switchThread(null));
$("#message-input").addEventListener("input", saveComposer);
$("#remember-drafts").addEventListener("change", () => {
  if ($("#remember-drafts").checked) saveComposer();
  else { recovery.clear(); $("#draft-recovery-status").textContent = "Draft recovery off. Drafts stay only while this page is open."; }
});
$("#message-to-select").addEventListener("change", saveComposer);
$("#message-input").addEventListener("keydown", e => {
  // Some IME confirmation keys arrive after compositionend; keyCode 229 is the
  // legacy IME signal in UI Events. Neither confirmation nor key repeat sends.
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229 && !e.repeat) { e.preventDefault(); $("#message-form").requestSubmit(); }
});
$("#search-form").addEventListener("submit", e => { e.preventDefault(); if (state) renderSearch(); });
$("#message-search").addEventListener("input", () => { if (state) renderSearch(); });
$("#clear-search").addEventListener("click", () => { $("#message-search").value = ""; renderSearch(); $("#message-search").focus(); });
$("#main").addEventListener("click", e => {
  const link = e.target.closest("[data-open-message], [data-open-work], [data-open-member], [data-open-event], [data-open-room]");
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (busy) return;
  if (link.dataset.openMessage) {
    history.replaceState(null, "", recordHref("message", link.dataset.openMessage));
    revealMessage(link.dataset.openMessage);
  } else if (link.dataset.openWork) {
    history.replaceState(null, "", recordHref("work", link.dataset.openWork));
    revealWork(link.dataset.openWork);
  } else if (link.dataset.openMember) {
    history.replaceState(null, "", recordHref("member", link.dataset.openMember));
    revealMember(link.dataset.openMember);
  } else if (link.dataset.openEvent) {
    history.replaceState(null, "", recordHref("event", link.dataset.openEvent));
    revealEvent(link.dataset.openEvent);
  } else {
    history.replaceState(null, "", recordHref("room", state.room.id));
    revealRoom();
  }
});
window.addEventListener("hashchange", revealLocationHash);
$("#new-messages-button").addEventListener("click", () => {
  const list = $("#message-list"); list.scrollTop = list.scrollHeight; newVisibleMessages = 0;
  $("#new-messages-button").hidden = true; list.focus({ preventScroll: true });
});
async function setReaction(messageId, reaction) {
  const key = `${messageId}:${reaction}`, previous = pendingReactions.get(key);
  if (previous?.busy || !Object.hasOwn(REACTIONS, reaction)) return;
  const active = !(conversation.byId.get(messageId).reactions?.[reaction] || []).includes(session.member.id);
  const pending = previous || draftCommand(null, T.MESSAGE_REACTION_SET, { messageId, reaction, active });
  pending.busy = true; pendingReactions.set(key, pending); renderMessages();
  const generation = client.generation;
  try {
    const receipt = await client.send(pending.command);
    if (generation !== client.generation || !state) return;
    // A successful command receipt can update this member's choice while a snapshot is delayed.
    if (client.sequence < receipt.sequence) {
      const message = conversation.byId.get(messageId), ids = new Set(message.reactions?.[reaction] || []);
      if (receipt.event.data.active) ids.add(session.member.id); else ids.delete(session.member.id);
      message.reactions ||= {}; message.reactions[reaction] = [...ids].sort();
    }
    pendingReactions.delete(key); notice("Reaction saved.");
  } catch (error) {
    if (generation === client.generation && state) { pending.busy = false; notice(`${error.message}. Retry keeps the same reaction choice.`, true); }
  } finally { if (state && generation === client.generation) renderMessages(); }
}
function openWork(sourceId = null) {
  if (!can("steer") || busy) return;
  if (!$("#new-work-form").hidden) { $("#work-title-input").focus(); return; }
  workFormOpener = document.activeElement;
  $("#new-work-form").hidden = false; workDraftId = `work-${crypto.randomUUID()}`;
  $("#source-message-id").value = sourceId || "";
  $("#source-context").textContent = sourceId ? `Source: ${state.messages.find(m => m.id === sourceId)?.body || ""}` : "";
  $("#source-context").hidden = !sourceId; $("#work-title-input").focus();
}
function closeWorkForm({ returnFocus = true } = {}) {
  $("#new-work-form").hidden = true; $("#new-work-form").reset();
  setFormStatus($("#new-work-status"), "");
  pendingWork = null; workDraftId = null;
  const opener = workFormOpener; workFormOpener = null;
  if (returnFocus) setTimeout(() => {
    const usable = node => node?.isConnected && !node.disabled && !node.hidden && node.getClientRects().length > 0;
    const target = [opener, $("#new-work-button"), $("#composer-work-button")].find(usable) || $("#work-title");
    target.focus({ preventScroll: true });
  }, 0);
}
$("#new-work-button").addEventListener("click", () => openWork());
$("#composer-work-button").addEventListener("click", () => openWork());
$("#cancel-work-button").addEventListener("click", () => closeWorkForm());
$("#new-work-form").addEventListener("submit", e => {
  e.preventDefault(); if (!state) return;
  const data = { workItemId: workDraftId, title: $("#work-title-input").value.trim(), definitionOfDone: $("#work-done-input").value.trim(), accountableMemberId: $("#assignee-select").value, verifierMemberId: $("#verifier-select").value, independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: state.room.ownerId, mode: $("#work-mode-select").value, sourceMessageId: $("#source-message-id").value || null };
  pendingWork = draftCommand(pendingWork, T.WORK_PROPOSED, data);
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  submit(e.currentTarget, async current => {
    await client.send(pendingWork.command);
    if (!current() || !sameSession(generation, roomId, memberId)) return;
    closeWorkForm(); notice("Work proposed. The accountable member must accept it; no external action was authorized.");
  }, { failureHint: "Your work proposal was kept; try again." });
});
const field = (name, label, type = "text") => `<label>${esc(label)}<input name="${name}" type="${type}" required maxlength="2000"></label>`;
const area = (name, label) => `<label>${esc(label)}<textarea name="${name}" required rows="3" maxlength="4000"></textarea></label>`;
function producerField() {
  const members = Object.values(state.members).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const self = members.find(member => member.id === session.member.id);
  const selfOption = self ? `<option value="${esc(self.id)}">I produced this — ${esc(memberLabel(self.id))}</option>` : "";
  const otherOptions = members.filter(member => member.id !== session.member.id).map(member => `<option value="${esc(member.id)}">${esc(memberLabel(member.id))} · ${esc(member.kind)}${member.active === false ? " · access revoked" : ""}</option>`).join("");
  return `<label>Primary producer of this result<select name="producerId" required aria-describedby="producer-attribution-help"><option value="">Choose producer attribution</option>${selfOption}<option value="__unknown__">Unknown / not reported</option>${otherOptions}</select></label><p id="producer-attribution-help" class="form-hint">The signed-in member remains the completion reporter. Choose the member who produced the result, or explicitly record that the producer is unknown.</p>`;
}
const actionSpecs = {
  accept: [T.WORK_ACCEPTED, "Accept this work?", "<p>Accept responsibility for the stated outcome. This does not run any tools.</p>"],
  start: [T.WORK_STARTED, "Record work starting", "<p>Record that you are starting this outcome. A record is not proof of external execution.</p>"],
  block: [T.WORK_BLOCKED, "Report a blocker", area("reason", "What is blocked?") + area("nextAction", "What is needed next?")],
  resolve: [T.WORK_BLOCKER_RESOLVED, "Resolve the blocker", area("resolution", "What changed or which direction did you accept?")],
  complete: [T.WORK_COMPLETED, "Post actual evidence", area("summary", "What did you complete?") + field("evidenceUrl", "Evidence URL (HTTPS)", "url") + field("evidenceVersion", "Exact commit or artifact version") + area("nextAction", "Next handoff")],
  claim: [T.CLAIM_ACQUIRED, "Record authorized write scope", field("repository", "Repository (owner/name)") + field("ref", "Branch or exact revision") + area("paths", "Exact paths, one per line") + field("expiresAt", "Expiry (ISO timestamp, with timezone)") + "<p>This records scope; it does not grant permission or execute tools.</p>"],
  verify: [T.VERIFICATION_RECORDED, "Record an evidence check", '<label>Result<select name="result" required><option value="">Choose after checking</option><option value="pass">Pass</option><option value="fail">Finding / fail</option></select></label>' + area("summary", "What did you check at this exact version?")],
  decide: [T.OWNER_DECISION_RECORDED, "Record your decision", '<label>Decision<select name="decision" required><option value="">Choose</option><option value="approved">Approve</option><option value="changes_requested">Request changes</option><option value="rejected">Reject</option></select></label>' + area("reason", "Reason") + "<p>Approval does not merge, deploy, or spend money.</p>" ]
};
$("#work-list").addEventListener("click", e => {
  const button = e.target.closest("[data-action]"); if (!button || busy) return;
  const item = state.workItems[button.dataset.workId], action = button.dataset.action;
  const [type, defaultTitle, fields] = actionSpecs[action];
  const title = action === "block" && item.state === S.COMPLETED ? "Reopen for rework"
    : action === "verify" && item.independentVerificationRequired && hasIndependentProducer(item) ? "Record an independent check" : defaultTitle;
  pendingAction = { type, action, workId: item.id, revision: item.revision, receipt: item.receipt ? { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion } : null, retry: null };
  $("#action-title").textContent = title;
  setFormStatus($("#action-error"), "");
  $("#action-context").textContent = `${item.title} · revision ${item.revision}${item.receipt ? ` · evidence ${item.receipt.evidenceVersion}` : ""}`;
  const verificationBoundary = action === "verify" && item.independentVerificationRequired && !hasReportedProducer(item)
    ? '<p id="verification-boundary" class="form-hint"><strong>Producer identity is unknown.</strong> This records an evidence check only. It cannot satisfy required independent verification or unlock approval.</p>'
    : "";
  $("#action-fields").innerHTML = action === "complete" ? producerField() + fields : verificationBoundary + fields;
  $("#action-dialog").setAttribute("aria-describedby", verificationBoundary ? "action-context verification-boundary" : "action-context");
  if (verificationBoundary) $("#action-fields select[name='result']")?.setAttribute("aria-describedby", "verification-boundary");
  $("#action-dialog").showModal();
});
function restoreActionFocus(entry) {
  if (!entry) return;
  setTimeout(() => {
    if (!state) return;
    const card = workRecord(entry.workId);
    const key = `work-action:${entry.workId}:${entry.action}`;
    const action = card ? [...card.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key) : null;
    focusRecord(action || card);
  }, 0);
}
function closeActionDialog({ returnFocus = true } = {}) {
  const entry = pendingAction;
  if ($("#action-dialog").open) $("#action-dialog").close();
  pendingAction = null;
  if (returnFocus) restoreActionFocus(entry);
}
$("#cancel-action").addEventListener("click", () => closeActionDialog());
$("#action-dialog").addEventListener("cancel", e => {
  e.preventDefault();
  if (!busy) closeActionDialog();
});
$("#action-form").addEventListener("submit", e => {
  e.preventDefault(); if (!pendingAction || !state) return;
  const entry = pendingAction, fields = Object.fromEntries(new FormData(e.currentTarget));
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const data = { workItemId: entry.workId, expectedRevision: entry.revision, ...fields };
  if (entry.action === "complete") data.producerId = fields.producerId === "__unknown__" ? null : fields.producerId;
  if (entry.action === "claim") data.paths = fields.paths.split("\n").map(p => p.trim()).filter(Boolean);
  if (["verify", "decide"].includes(entry.action)) Object.assign(data, entry.receipt);
  entry.retry = draftCommand(entry.retry, entry.type, data);
  submit(e.currentTarget, async current => {
    await client.send(entry.retry.command);
    if (!current() || !sameSession(generation, roomId, memberId)) return;
    closeActionDialog({ returnFocus: false }); notice("Record saved. External execution and independent verification are separate facts."); setTimeout(() => revealWork(entry.workId), 0);
  }, { failureHint: "Your entries were kept; try again." });
});
window.addEventListener("beforeunload", e => {
  if (!state) return;
  saveComposer();
  if (drafts.hasText() || !$("#new-work-form").hidden || $("#action-dialog").open) { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state) saveComposer(); });
window.addEventListener("pagehide", () => {
  if (state) saveComposer();
  leavingPage = true;
  try { client.endAccess(); } finally { leavingPage = false; }
});
window.addEventListener("pageshow", e => { if (e.persisted) client.restore().catch(handleFailureNotice); });
// Return brief (disposition 5557850637): compact expandable rail entry. Fetch on return and
// on open; history stays fixed through the frozen horizon H, the action sections are live
// through N, and only the explicit button acknowledges - exactly H, never the latest event.
function loadReturnBrief() { return briefView.refresh(); }
const roleLabel = role => ({ accountableMemberId: "accountable", verifierMemberId: "verifier", humanDecisionMakerId: "decision maker" }[role] ?? humanize(role));
function briefEventTarget(event) {
  if (event.type === T.MESSAGE_POSTED) return { kind: "message", id: event.data.messageId || event.id };
  if (event.type === T.MESSAGE_REACTION_SET) return { kind: "message", id: event.data.messageId };
  if (event.data.workItemId) return { kind: "work", id: event.data.workItemId };
  if ([T.MEMBER_ADDED, T.MEMBER_ACCESS_CHANGED].includes(event.type) && event.data.memberId) return { kind: "member", id: event.data.memberId };
  if (event.type === T.ROOM_CREATED) return { kind: "room", id: state.room.id };
  return { kind: "event", id: event.id };
}
function describeBriefEvent({ sequence, event }) {
  const actor = esc(memberLabel(event.actorId));
  const type = esc(humanize(event.type));
  const actorRole = event.type === T.WORK_COMPLETED ? `reporter ${actor}` : actor;
  let detail = "";
  if (event.type === T.MESSAGE_POSTED) detail = esc((event.data.body || "").slice(0, 80));
  else if (event.type === T.VERIFICATION_RECORDED) detail = esc(`${event.data.result} · ${(event.data.summary || "").slice(0, 60)}`);
  else if (event.type === T.OWNER_DECISION_RECORDED) detail = esc(humanize(event.data.decision));
  else if (event.type === T.WORK_COMPLETED) {
    const title = state.workItems[event.data.workItemId]?.title ?? event.data.workItemId ?? "";
    const producer = event.data.producerId ? memberLabel(event.data.producerId) : "unknown — not reported";
    detail = esc(`${title} · producer ${producer}`);
  }
  else if (event.type?.startsWith("work.")) detail = esc(state.workItems[event.data.workItemId]?.title ?? event.data.workItemId ?? "");
  const target = briefEventTarget(event);
  const href = esc(recordHref(target.kind, target.id));
  const attribute = target.kind === "room" ? `data-open-room="${esc(target.id)}"`
    : `data-open-${target.kind}="${esc(target.id)}"`;
  return `<li class="rb-event"><a class="rb-event-link" href="${href}" ${attribute} data-brief-key="history:${esc(event.id)}"><span class="rb-seq">#${sequence}</span> <span class="rb-type">${type}</span> <span class="rb-actor">${actorRole}</span>${detail ? ` <span class="rb-detail">${detail}</span>` : ""}</a></li>`;
}
function renderBriefList(selector, html) {
  const list = $(selector);
  const focusedKey = list.contains(document.activeElement)
    ? document.activeElement.closest("[data-brief-key]")?.dataset.briefKey
    : null;
  const changed = list._content !== html;
  if (changed) {
    list.innerHTML = html;
    list._content = html;
  }
  if (focusedKey && changed) {
    const exact = [...list.querySelectorAll("[data-brief-key]")]
      .find(node => node.dataset.briefKey === focusedKey);
    const first = list.querySelector("[data-brief-key]");
    const acknowledgement = $("#rb-ack-button");
    const fallback = !acknowledgement.disabled && !acknowledgement.hidden
      ? acknowledgement
      : $("#return-brief-panel > summary");
    (exact || first || fallback).focus({ preventScroll: true });
  }
}
function renderReturnBrief() {
  const returnBrief = briefView.owns(briefView.chain) ? briefView.brief : null;
  $("#rb-status").textContent = state ? briefView.message : "";
  $("#rb-refresh-button").disabled = !state || briefView.busy;
  $("#caught-up-button").disabled = !state || briefView.busy;
  $("#return-brief-panel").setAttribute("aria-busy", briefView.busy ? "true" : "false");
  $("#rb-more-button").disabled = briefView.busy;
  $("#rb-ack-button").disabled = true;
  $("#rb-more-button").hidden = true;
  if (!returnBrief || !state) {
    for (const id of ["rb-current-boundary", "rb-history-boundary", "rb-attention-list", "rb-involving-list", "rb-history-list"]) $(`#${id}`).replaceChildren();
    for (const id of ["rb-attention-list", "rb-involving-list", "rb-history-list"]) delete $(`#${id}`)._content;
    $("#rb-ack-button").textContent = briefView.reconciliationRequired ? "Refresh brief before acknowledging" : "Mark caught up";
    return;
  }
  const { history, current } = returnBrief;
  $("#rb-current-boundary").textContent = `as of event ${current.evaluatedThrough}`;
  $("#rb-history-boundary").textContent = history.evaluatedThrough === history.cursor
    ? "· nothing new since your marker"
    : `since marker ${history.cursor} · through event ${history.evaluatedThrough}`;
  renderBriefList("#rb-attention-list", current.needsAttention.map(i =>
    `<li class="rb-event"><a class="work-link" href="${esc(workHref(i.workItemId))}" data-open-work="${esc(i.workItemId)}" data-brief-key="attention:${esc(i.workItemId)}:${esc(i.step)}">${esc(i.action ?? i.workItemId)}</a> <span class="rb-detail">your step: ${esc(humanize(i.step))}</span></li>`).join("")
    || '<li class="rb-empty">Nothing needs you right now.</li>');
  renderBriefList("#rb-involving-list", current.workInvolvingMe.map(i =>
    `<li class="rb-event"><a class="work-link" href="${esc(workHref(i.workItemId))}" data-open-work="${esc(i.workItemId)}" data-brief-key="involving:${esc(i.workItemId)}">${esc(i.action ?? i.workItemId)}</a> <span class="rb-detail">${esc(i.roles.map(roleLabel).join(", "))} · ${esc(i.state)}</span></li>`).join("")
    || '<li class="rb-empty">No open work involves you.</li>');
  renderBriefList("#rb-history-list", history.items.map(describeBriefEvent).join("")
    || '<li class="rb-empty">Nothing new since your marker.</li>');
  $("#rb-more-button").hidden = !history.hasMore;
  $("#rb-ack-button").textContent = history.evaluatedThrough === history.cursor ? "Already caught up" : `Mark caught up through event ${history.evaluatedThrough}`;
  $("#rb-ack-button").disabled = briefView.busy || history.evaluatedThrough === history.cursor;
}
$("#return-brief-panel").addEventListener("toggle", e => {
  if (e.currentTarget.open && state) loadReturnBrief(); // reopening replaces the pagination chain
});
$("#rb-refresh-button").addEventListener("click", loadReturnBrief);
$("#rb-more-button").addEventListener("click", async () => {
  const chain = briefView.chain, firstNewHistoryIndex = briefView.brief?.history.items.length ?? 0;
  const pagingButtonFocused = document.activeElement === $("#rb-more-button");
  await briefView.more();
  if (pagingButtonFocused && briefView.owns(chain) && briefView.brief && !briefView.brief.history.hasMore
      && (document.activeElement === document.body || document.activeElement === $("#rb-more-button"))) {
    focusRecord($("#rb-history-list").querySelectorAll("[data-brief-key]")[firstNewHistoryIndex] || $("#rb-ack-button"));
  }
});
$("#rb-ack-button").addEventListener("click", () => briefView.acknowledge());
client.restore().catch(error => {
  const signedOut = [401, 403].includes(error.status);
  if (signedOut) recovery.clear();
  setFormStatus($("#auth-error"), signedOut ? "Use a provisioned human room key to enter. No demo identity is selected for you." : "Room service unavailable. Check the service and retry; no connection is claimed.", true);
  setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
  $("#auth-panel").hidden = false;
  queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
});
