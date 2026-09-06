import { EVENT_TYPES as T, WORK_STATES as S } from "./events.js";
import { RoomClient, draftCommand } from "./client.js";
import { REACTIONS, conversationIndex, searchMessages, ConversationDrafts } from "./conversation.js";

const $ = selector => document.querySelector(selector);
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
let workDraftId = null, replyToId = null, busy = false;
let currentThreadId = null, conversation = null, drafts = new ConversationDrafts();
const viewPositions = new Map(), pendingReactions = new Map();
let newVisibleMessages = 0;
const client = new RoomClient({
  onSnapshot(snapshot, identity) {
    const firstSnapshot = !state;
    state = snapshot.state; session = identity;
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#signout-button").hidden = false;
    $("#identity-label").textContent = `${state.members[session.member.id].displayName} · ${session.member.kind}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
    if (firstSnapshot && location.hash.startsWith("#message-")) revealMessage(location.hash.slice(9));
  },
  onStatus(text) { $("#connection-status").textContent = text; },
  onAccessEnded() {
    state = null; session = null; pendingMessage = null; pendingWork = null; pendingAction = null;
    workDraftId = null; replyToId = null;
    currentThreadId = null; conversation = null; drafts = new ConversationDrafts();
    viewPositions.clear(); pendingReactions.clear(); newVisibleMessages = 0;
    $("#main").hidden = true; $("#auth-panel").hidden = false; $("#signout-button").hidden = true;
    $("#identity-label").textContent = "Not signed in";
    for (const id of ["message-list", "work-list", "event-list", "presence-list", "member-stack", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "message-count", "event-count"]) $(`#${id}`).replaceChildren();
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) form.reset();
    $("#action-dialog").close(); $("#new-work-form").hidden = true; $("#reply-bar").hidden = true;
    $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = "";
    $("#thread-title").textContent = ""; $("#thread-context").textContent = "";
    $("#thread-bar").hidden = true; $("#search-results").hidden = true; $("#new-messages-button").hidden = true;
    $("#conversation-announcement").textContent = ""; delete $("#message-list").dataset.view;
    $("#status").textContent = ""; $("#status").classList.remove("visible", "error");
    $("#auth-error").textContent = "Sign in with an active room key. Session ended; private drafts were cleared.";
    $("#connection-status").textContent = "Not connected";
  }
});
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const humanize = value => String(value).replaceAll("_", " ").replaceAll(".", " ");
const name = id => state.members[id]?.displayName || "Unassigned";
const can = capability => state?.members[session?.member.id]?.permissions.includes(capability);
const initials = text => esc(text.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase());
const time = value => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
function safeUrl(value) { try { const u = new URL(value); return u.protocol === "https:" ? esc(u.href) : "#"; } catch { return "#"; } }
function notice(text, error = false) { $("#status").textContent = text; $("#status").classList.add("visible"); $("#status").classList.toggle("error", error); if ($("#action-dialog").open) $("#action-error").textContent = error ? text : ""; }
function selectOptions(selector, members, blank) {
  const select = $(selector), previous = select.value;
  const signature = JSON.stringify(members.map(m => [m.id, m.displayName]));
  if (select.dataset.signature === signature) return;
  select.innerHTML = `<option value="">${esc(blank)}</option>${members.map(m => `<option value="${esc(m.id)}">${esc(m.displayName)} · ${esc(m.kind)}</option>`).join("")}`;
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
  let focusSelector = null;
  if (active && container.contains(active)) {
    const host = active.closest("[data-disclosure-host]");
    const tag = active.tagName.toLowerCase();
    focusSelector = host ? `[data-disclosure-host="${host.dataset.disclosureHost}"] ${tag}` : null;
  }
  return { openKeys, focusSelector };
}
function restoreDisclosures(container, snap) {
  container.querySelectorAll("details").forEach(d => { if (snap.openKeys.has(disclosureKey(d))) d.open = true; });
  if (snap.focusSelector) {
    const target = container.querySelector(snap.focusSelector);
    if (target) target.focus({ preventScroll: true });
  }
}
function render() {
  conversation = conversationIndex(state.messages);
  const members = Object.values(state.members), active = members.filter(m => m.active !== false);
  selectOptions("#message-to-select", active, "Everyone in this room");
  selectOptions("#assignee-select", active.filter(m => m.permissions.includes("accept_work") && m.permissions.includes("complete_work")), "Choose accountable member");
  selectOptions("#verifier-select", active.filter(m => m.permissions.includes("verify")), "Choose independent verifier");
  $("#presence-count").textContent = `${active.length} members · presence not measured`;
  $("#member-stack").innerHTML = active.map(m => `<div class="member-avatar ${m.kind}" title="${esc(m.displayName)}"><span>${initials(m.displayName)}</span></div>`).join("");
  const presenceSnap = captureDisclosures($("#presence-list")), workSnap = captureDisclosures($("#work-list"));
  $("#presence-list").innerHTML = members.map(m => `<div class="presence-member" data-disclosure-host="${esc(m.id)}"><div class="member-avatar ${m.kind}"><span>${initials(m.displayName)}</span></div><div><strong>${esc(m.displayName)}</strong><span>${esc(m.kind)} · ${m.active === false ? "access revoked" : "presence unknown"}</span><details><summary>Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p></details></div></div>`).join("");
  $("#new-work-button").disabled = !can("steer"); $("#composer-work-button").disabled = !can("steer");
  const items = Object.values(state.workItems);
  const waiting = items.filter(i => readyForDecision(i) && i.humanDecisionMakerId === session.member.id).length;
  $("#summary-grid").innerHTML = `<article class="summary-card"><span>Your decisions</span><strong>${waiting}</strong><p>Completion, verification, and approval stay separate.</p></article><article class="summary-card"><span>Work in this room</span><strong>${items.length}</strong><p>${items.filter(i => i.state === S.BLOCKED).length} blocked. Conversation never creates work automatically.</p></article>`;
  renderMessages();
  renderSearch();
  $("#work-list").innerHTML = items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(workCard).join("") || '<p class="empty-note">Nothing assigned. A room is useful before it has a task.</p>';
  restoreDisclosures($("#presence-list"), presenceSnap);
  restoreDisclosures($("#work-list"), workSnap);
  $("#event-count").textContent = `${client.sequence}`;
  $("#event-list").innerHTML = [...state.eventLog].reverse().map(e => `<li><span>${esc(humanize(e.type))}</span><strong>${esc(name(e.actorId))}</strong><time>${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join("");
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
  const newCount = sameView ? messages.filter(m => !previous.has(m.id)).length : 0;
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
    node.id = `message-${message.id}`; node.dataset.key = message.id;
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
  if (newCount) $("#conversation-announcement").textContent = `${newCount} new ${newCount === 1 ? "message" : "messages"} in ${currentThreadId ? "this thread" : "the room"}.`;
}
function messageContent(m) {
  const author = state.members[m.authorId];
  const linked = Object.values(state.workItems).filter(i => i.sourceMessageId === m.id || i.id === m.workItemId);
  const parent = conversation.byId.get(m.replyToId);
  const count = (conversation.threads.get(m.id)?.length || 1) - 1;
  const reactionButtons = Object.entries(REACTIONS).map(([reaction, symbol]) => {
    const members = m.reactions?.[reaction] || [], selected = members.includes(session.member.id);
    const pending = pendingReactions.get(`${m.id}:${reaction}`);
    const label = `${pending && !pending.busy ? "Retry " : ""}${reaction}`;
    return `<button type="button" class="reaction" aria-pressed="${selected}" aria-label="${esc(label)} reaction, ${members.length}" title="${esc(members.map(name).join(", ") || `React with ${reaction}`)}" data-message-action="react" data-message-id="${esc(m.id)}" data-reaction="${reaction}"${pending?.busy ? " disabled" : ""}><span aria-hidden="true">${symbol}</span><span>${members.length || ""}</span>${pending && !pending.busy ? " Retry" : ""}</button>`;
  }).join("");
  return `<div class="message-avatar ${author.kind}">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(author.displayName)}</strong><span>${esc(author.kind)}</span><a class="message-time" href="#message-${esc(m.id)}" data-open-message="${esc(m.id)}" aria-label="Link to message by ${esc(author.displayName)} at ${esc(time(m.createdAt))}"><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a></div><div class="message-context">${m.toMemberId ? `<span class="audience-chip">To ${esc(name(m.toMemberId))} · room-visible</span>` : ""}${parent && parent.id !== currentThreadId ? `<a class="source-link reply-preview" href="#message-${esc(parent.id)}" data-open-message="${esc(parent.id)}">↳ ${esc(name(parent.authorId))}: ${esc(parent.body.slice(0,90))}</a>` : ""}</div><p>${esc(m.body)}</p><div class="reactions" aria-label="Reactions to message by ${esc(author.displayName)}">${reactionButtons}</div><div class="message-links">${linked.map(i => `<a class="work-link" href="#${esc(i.id)}">↳ ${esc(i.title)}</a>`).join("")}<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button">Reply</button>${!currentThreadId && count ? `<button class="thread-link" data-message-action="thread" data-message-id="${esc(m.id)}" type="button">${count} ${count === 1 ? "reply" : "replies"} ↗</button>` : ""}${can("steer") ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : ""}</div></div>`;
}
function renderSearch() {
  const query = $("#message-search").value;
  $("#search-results").hidden = !query.trim();
  if (!query.trim()) { $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = ""; return; }
  const result = searchMessages(state, query);
  $("#search-count").textContent = `${result.total} ${result.total === 1 ? "match" : "matches"}${result.total > result.messages.length ? ` · latest ${result.messages.length} shown` : ""} in this room`;
  const list = $("#search-list"), focused = list.contains(document.activeElement) ? document.activeElement.dataset.openMessage : null;
  const html = result.messages.map(m => `<li><a href="#message-${esc(m.id)}" data-open-message="${esc(m.id)}"><strong>${esc(name(m.authorId))}</strong><span>${esc(m.body.slice(0, 240))}</span><small>${m.replyToId ? "Open thread at this reply" : "Open in room"}</small></a></li>`).join("") || '<li class="empty-note">No matches. Try a name or another phrase.</li>';
  if (list._content !== html) { list.innerHTML = html; list._content = html; }
  if (focused) [...list.querySelectorAll("[data-open-message]")].find(e => e.dataset.openMessage === focused)?.focus({ preventScroll: true });
}
function saveComposer() {
  drafts.save(currentThreadId, { body: $("#message-input").value, toMemberId: $("#message-to-select").value, replyToId, pending: pendingMessage });
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
  updateReply(); renderMessages();
  if (focusComposer) $("#message-input").focus();
  else (currentThreadId ? $("#thread-title") : $("#conversation-title")).focus({ preventScroll: true });
}
function revealMessage(id) {
  if (!state || busy || !conversation.byId.has(id)) return;
  const message = conversation.byId.get(id);
  switchThread(message.replyToId ? conversation.rootById.get(id) : null);
  const row = document.getElementById(`message-${id}`);
  row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function readyForDecision(i) { return i.ownerDecisionRequired && !i.decision && i.state === S.COMPLETED && (!i.independentVerificationRequired || i.verification?.result === "pass"); }
function activeClaim(i) { return i.claim?.status === "active" && Date.parse(i.claim.expiresAt) > Date.now(); }
function actions(i) {
  const a = [], own = i.accountableMemberId === session.member.id;
  if (own && i.state === S.PROPOSED && can("accept_work")) a.push(["accept", "Accept"]);
  if (own && [S.ACCEPTED, S.WORKING, S.BLOCKED].includes(i.state) && i.mode === "write" && !activeClaim(i) && can("write_external")) a.push(["claim", "Record write scope"]);
  if (own && i.state === S.ACCEPTED && can("accept_work") && (i.mode === "read" || (activeClaim(i) && can("write_external")))) a.push(["start", "Start"]);
  if (own && i.state === S.BLOCKED) a.push(["resolve", "Resolve blocker"]);
  if (own && [S.ACCEPTED, S.WORKING].includes(i.state)) {
    a.push(["block", "Report blocker"]);
    if (can("complete_work") && (i.mode === "read" || (activeClaim(i) && can("write_external")))) a.push(["complete", "Post evidence"]);
  }
  if (i.state === S.COMPLETED && session.member.id === i.verifierMemberId && can("verify") && !i.verification) a.push(["verify", "Record verification"]);
  if (readyForDecision(i) && session.member.id === i.humanDecisionMakerId && can("decide")) a.push(["decide", "Record decision"]);
  return a.map(([action, label]) => `<button type="button" class="button secondary" data-action="${action}" data-work-id="${esc(i.id)}"${busy ? " disabled" : ""}>${label}</button>`).join("");
}
function workCard(i) {
  return `<article id="${esc(i.id)}" class="work-card" data-disclosure-host="${esc(i.id)}"><div class="work-card-header"><span class="state state-${i.state}">${esc(i.state)}</span><span class="mode">${esc(i.mode)} · revision ${i.revision}</span></div><h3>${esc(i.title)}</h3>${i.sourceMessageId ? `<a class="source-link" href="#message-${esc(i.sourceMessageId)}" data-open-message="${esc(i.sourceMessageId)}">From this conversation</a>` : ""}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(name(i.accountableMemberId))}</dd></div><div><dt>Verifier</dt><dd>${esc(name(i.verifierMemberId))}</dd></div></dl>${i.receipt ? `<div class="receipt"><p class="receipt-label">REPORTED COMPLETION · NOT AUTOMATIC VERIFICATION</p><p>${esc(i.receipt.summary)}</p><a href="${safeUrl(i.receipt.evidenceUrl)}" target="_blank" rel="noreferrer">Open submitted evidence ↗</a><code>${esc(i.receipt.evidenceVersion)}</code><p>${esc(i.receipt.nextAction)}</p>${i.verification ? `<p>${esc(i.verification.result.toUpperCase())} reported by ${esc(name(i.verification.verifierId))}: ${esc(i.verification.summary)}</p>` : "<p>No verification recorded.</p>"}</div>` : ""}${i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : ""}${i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : ""}${i.claim ? `<details class="claim"><summary>Recorded scope · ${activeClaim(i) ? "not expired" : "expired or released"}</summary><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p><p>Expires ${esc(i.claim.expiresAt)}. This service does not execute external actions.</p></details>` : ""}<div class="work-actions">${actions(i)}</div></article>`;
}
// Quiet Focus A4: a failed send reports beside the composer that holds the draft,
// not only in the page-level status area; the Send button is the retry and the
// draft clears only after the service acknowledges the retry.
async function submit(form, fn) {
  if (busy) return;
  busy = true; const controls = [...form.querySelectorAll("button, input, select, textarea")];
  const disabled = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
  const local = form.querySelector(".form-status");
  if (local) { local.textContent = ""; local.classList.remove("visible", "error"); }
  try { await fn(); }
  catch (error) {
    const text = `${error.message}. ${state ? "Draft kept; press Send to retry." : "Sign in again."}`;
    notice(text, true);
    if (local) { local.textContent = text; local.classList.add("visible", "error"); }
  }
  finally { busy = false; controls.forEach((e, i) => e.disabled = disabled[i]); if (state) render(); }
}
$("#auth-form").addEventListener("submit", async e => {
  e.preventDefault(); $("#auth-error").textContent = "";
  const accessKey = $("#access-key").value.trim();
  await submit(e.currentTarget, async () => {
    try { await client.login(accessKey); $("#access-key").value = ""; $("#message-input").focus(); notice("Signed in. Welcome to your room."); }
    catch (error) { $("#auth-error").textContent = error.message; throw error; }
  });
  if (state && location.hash.startsWith("#message-")) revealMessage(location.hash.slice(9));
});
$("#signout-button").addEventListener("click", async () => {
  if (busy) return;
  saveComposer();
  if (drafts.hasText() || !$("#new-work-form").hidden || $("#action-dialog").open) {
    if (!window.confirm("Sign out and clear unsent drafts on this device?")) return;
  }
  try { await client.logout(); notice("Signed out. Private drafts cleared."); }
  catch (error) { if ([401, 403].includes(error.status)) client.endAccess(); else notice("Sign-out could not be confirmed. Session may still be active; retry when connected.", true); }
});
$("#refresh-button").addEventListener("click", async () => {
  try { if (!client.session) await client.restore(); else { await client.refresh(); client.connect(); } }
  catch (error) { client.handleFailure(error); notice(error.message, true); }
});
$("#caught-up-button").addEventListener("click", async () => {
  try { await client.caughtUp(); await client.refresh(); notice("Your caught-up position saved. No peer read or processing claim was created."); }
  catch (error) { client.handleFailure(error); notice(error.message, true); }
});
$("#message-form").addEventListener("submit", e => {
  e.preventDefault(); if (!state) return;
  const data = { body: $("#message-input").value.trim(), toMemberId: $("#message-to-select").value || null, replyToId };
  if (!data.body) return;
  pendingMessage = draftCommand(pendingMessage, T.MESSAGE_POSTED, data);
  saveComposer();
  const generation = client.generation, threadId = currentThreadId;
  submit(e.currentTarget, async () => {
    const receipt = await client.send(pendingMessage.command);
    if (generation !== client.generation || !state) return;
    drafts.clear(threadId);
    $("#message-input").value = ""; pendingMessage = null; clearReply();
    notice(`Message saved${threadId ? " in this thread" : " to the room"}.`);
  });
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
$("#cancel-reply").addEventListener("click", clearReply);
$("#thread-back").addEventListener("click", () => switchThread(null));
$("#message-input").addEventListener("input", saveComposer);
$("#message-to-select").addEventListener("change", saveComposer);
$("#message-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); $("#message-form").requestSubmit(); }
});
$("#search-form").addEventListener("submit", e => { e.preventDefault(); if (state) renderSearch(); });
$("#message-search").addEventListener("input", () => { if (state) renderSearch(); });
$("#clear-search").addEventListener("click", () => { $("#message-search").value = ""; renderSearch(); $("#message-search").focus(); });
$("#main").addEventListener("click", e => {
  const link = e.target.closest("[data-open-message]");
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (!busy) { history.replaceState(null, "", `#message-${link.dataset.openMessage}`); revealMessage(link.dataset.openMessage); }
});
window.addEventListener("hashchange", () => { if (location.hash.startsWith("#message-")) revealMessage(location.hash.slice(9)); });
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
  $("#new-work-form").hidden = false; workDraftId = `work-${crypto.randomUUID()}`;
  $("#source-message-id").value = sourceId || "";
  $("#source-context").textContent = sourceId ? `Source: ${state.messages.find(m => m.id === sourceId)?.body || ""}` : "";
  $("#source-context").hidden = !sourceId; $("#work-title-input").focus();
}
$("#new-work-button").addEventListener("click", () => openWork());
$("#composer-work-button").addEventListener("click", () => openWork());
$("#cancel-work-button").addEventListener("click", () => { $("#new-work-form").hidden = true; $("#new-work-form").reset(); pendingWork = null; workDraftId = null; });
$("#new-work-form").addEventListener("submit", e => {
  e.preventDefault(); if (!state) return;
  const data = { workItemId: workDraftId, title: $("#work-title-input").value.trim(), definitionOfDone: $("#work-done-input").value.trim(), accountableMemberId: $("#assignee-select").value, verifierMemberId: $("#verifier-select").value, independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: state.room.ownerId, mode: $("#work-mode-select").value, sourceMessageId: $("#source-message-id").value || null };
  pendingWork = draftCommand(pendingWork, T.WORK_PROPOSED, data);
  submit(e.currentTarget, async () => { await client.send(pendingWork.command); $("#new-work-form").reset(); $("#new-work-form").hidden = true; pendingWork = null; workDraftId = null; notice("Work proposed. The accountable member must accept it; no external action was authorized."); });
});
const field = (name, label, type = "text") => `<label>${esc(label)}<input name="${name}" type="${type}" required maxlength="2000"></label>`;
const area = (name, label) => `<label>${esc(label)}<textarea name="${name}" required rows="3" maxlength="4000"></textarea></label>`;
const actionSpecs = {
  accept: [T.WORK_ACCEPTED, "Accept this work?", "<p>Accept responsibility for the stated outcome. This does not run any tools.</p>"],
  start: [T.WORK_STARTED, "Record work starting", "<p>Record that you are starting this outcome. A record is not proof of external execution.</p>"],
  block: [T.WORK_BLOCKED, "Report a blocker", area("reason", "What is blocked?") + area("nextAction", "What is needed next?")],
  resolve: [T.WORK_BLOCKER_RESOLVED, "Resolve the blocker", area("resolution", "What changed or which direction did you accept?")],
  complete: [T.WORK_COMPLETED, "Post actual evidence", area("summary", "What did you complete?") + field("evidenceUrl", "Evidence URL (HTTPS)", "url") + field("evidenceVersion", "Exact commit or artifact version") + area("nextAction", "Next handoff")],
  claim: [T.CLAIM_ACQUIRED, "Record authorized write scope", field("repository", "Repository (owner/name)") + field("ref", "Branch or exact revision") + area("paths", "Exact paths, one per line") + field("expiresAt", "Expiry (ISO timestamp, with timezone)") + "<p>This records scope; it does not grant permission or execute tools.</p>"],
  verify: [T.VERIFICATION_RECORDED, "Record an independent check", '<label>Result<select name="result" required><option value="">Choose after checking</option><option value="pass">Pass</option><option value="fail">Finding / fail</option></select></label>' + area("summary", "What did you check at this exact version?")],
  decide: [T.OWNER_DECISION_RECORDED, "Record your decision", '<label>Decision<select name="decision" required><option value="">Choose</option><option value="approved">Approve</option><option value="changes_requested">Request changes</option><option value="rejected">Reject</option></select></label>' + area("reason", "Reason") + "<p>Approval does not merge, deploy, or spend money.</p>" ]
};
$("#work-list").addEventListener("click", e => {
  const button = e.target.closest("[data-action]"); if (!button || busy) return;
  const item = state.workItems[button.dataset.workId], action = button.dataset.action;
  const [type, title, fields] = actionSpecs[action];
  pendingAction = { type, action, workId: item.id, revision: item.revision, receipt: item.receipt ? { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion } : null, retry: null };
  $("#action-title").textContent = title;
  $("#action-error").textContent = "";
  $("#action-context").textContent = `${item.title} · revision ${item.revision}${item.receipt ? ` · evidence ${item.receipt.evidenceVersion}` : ""}`;
  $("#action-fields").innerHTML = fields; $("#action-dialog").showModal();
});
$("#cancel-action").addEventListener("click", () => { $("#action-dialog").close(); pendingAction = null; });
$("#action-dialog").addEventListener("cancel", e => { if (busy) e.preventDefault(); else pendingAction = null; });
$("#action-form").addEventListener("submit", e => {
  e.preventDefault(); if (!pendingAction || !state) return;
  const entry = pendingAction, fields = Object.fromEntries(new FormData(e.currentTarget));
  const data = { workItemId: entry.workId, expectedRevision: entry.revision, ...fields };
  if (entry.action === "claim") data.paths = fields.paths.split("\n").map(p => p.trim()).filter(Boolean);
  if (["verify", "decide"].includes(entry.action)) Object.assign(data, entry.receipt);
  entry.retry = draftCommand(entry.retry, entry.type, data);
  submit(e.currentTarget, async () => { await client.send(entry.retry.command); $("#action-dialog").close(); pendingAction = null; notice("Record saved. External execution and independent verification are separate facts."); });
});
window.addEventListener("beforeunload", e => {
  if (!state) return;
  saveComposer();
  if (drafts.hasText() || !$("#new-work-form").hidden || $("#action-dialog").open) { e.preventDefault(); e.returnValue = ""; }
});
window.addEventListener("pagehide", () => client.endAccess());
window.addEventListener("pageshow", e => { if (e.persisted) client.restore().catch(error => client.handleFailure(error)); });
client.restore().catch(error => {
  $("#auth-error").textContent = [401, 403].includes(error.status) ? "Use a provisioned human room key to enter. No demo identity is selected for you." : "Room service unavailable. Check the service and retry; no connection is claimed.";
  $("#auth-panel").hidden = false;
});
