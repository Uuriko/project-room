import { InboxPreview } from "./model.mjs";
const model = new InboxPreview(), $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let place = "inbox", selected = null, layout = "split", share = null;
const pending = new Map(), statuses = new Map(), positions = new Map(), bases = new Map();
const key = () => place === "rooms" ? "room" : "reply:" + selected;
function transition(change) {
  const reader = document.querySelector(".reader"), before = key();
  if (reader) positions.set(before, reader.scrollTop);
  const input = $("compose"), focus = document.activeElement === input ? { start: input.selectionStart, end: input.selectionEnd } : null;
  change(); render();
  const currentReader = document.querySelector(".reader");
  if (currentReader) currentReader.scrollTop = positions.get(key()) ?? 0;
  if (focus && before === key() && $("compose")) { $("compose").focus(); $("compose").setSelectionRange(focus.start, focus.end); }
}
const list = () => `<section class="inbox-list"><h1>Inbox</h1>${model.threads.map(t =>
  `<button class="thread-row" data-thread="${t.id}" ${selected === t.id ? 'aria-current="true"' : ""}><div class="row-top"><strong>${escape(t.from)}</strong><span>${t.channel}</span></div><p>${escape(t.subject)}</p><small>${escape(t.paragraphs[0])}</small></button>`).join("")}</section>`;
function composer(thread = null) {
  const draftKey = thread ? "reply:" + thread.id : "room", locked = pending.has(draftKey);
  const changed = thread && bases.has(draftKey) && bases.get(draftKey) !== thread.revision;
  return `<section class="composer"><form id="compose-form"><label for="compose">${thread ? "Reply from " + escape(thread.account) + " to " + escape(thread.address) : "Message Launch studio · visible to You, Alex and Rin"}</label>
    <textarea id="compose" maxlength="4000" rows="3" ${locked ? "readonly" : ""} placeholder="${thread ? "Write a reply…" : "Message the room…"}">${escape(model.draft(draftKey))}</textarea>
    <p id="compose-status" role="status">${escape(statuses.get(draftKey) ?? "")}</p>
    <footer><small>${thread ? "Sample " + thread.channel.toLowerCase() + " · private" : "Room conversation"}</small>${changed && !locked ? '<button type="button" id="review-source">Review update</button>' : ""}<button class="primary" id="send" ${changed && !locked ? "disabled" : ""}>${locked ? "Check status" : thread ? "Send sample" : "Send"}</button></footer></form></section>`;
}
function render() {
  for (const [id, active] of [["nav-inbox", place === "inbox"], ["nav-rooms", place === "rooms"]]) {
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  const w = $("workspace"); w.className = [layout, selected && place === "inbox" ? "has-thread" : "", place === "rooms" ? "rooms" : ""].join(" ");
  if (place === "rooms") {
    const view = model.roomView();
    w.innerHTML = `<section class="conversation"><header class="conversation-header"><span class="eyebrow">Room</span><h1>${view.room.title}</h1><span class="audience">You, Alex, Rin · shared conversation</span></header>
    <div class="reader"><div class="reading-width">${view.messages.map(m => `<article class="room-message" data-room-message="${m.id}"><div class="sender"><span class="avatar">${m.by[0]}</span><strong>${m.by}</strong></div>
    <div class="${m.kind === "excerpt" ? "excerpt" : ""}">${m.label ? `<small>${escape(m.label)} · selected text only</small>` : ""}<p>${escape(m.body)}</p></div>
    ${model.shared.has(m.id) ? `<button class="quiet" data-source="${m.id}">Return to inbox</button>` : ""}</article>`).join("")}</div></div>${composer()}</section>`;
  } else if (!selected) w.innerHTML = list() + (layout === "split" ? '<p class="empty">Choose a conversation</p>' : "");
  else {
    const t = model.thread(selected);
    w.innerHTML = (layout === "split" ? list() : "") + `<section class="conversation">
    <header class="conversation-header"><button class="back quiet" id="back">← Inbox</button><div class="eyebrow">${t.channel} · your private conversation</div><h1>${escape(t.subject)}</h1><span class="audience">${escape(t.address)} → ${escape(t.account)}</span></header>
    <div class="reader"><div class="reading-width"><div class="sender"><span class="avatar">${t.from[0]}</span><div><strong>${escape(t.from)}</strong><small>Sample message</small></div></div>
    <div class="message-body">${t.paragraphs.map(p => `<p>${escape(p)}</p>`).join("")}</div><button class="quiet" id="ask-room">Ask room…</button></div></div>${composer(t)}</section>`;
  }
  $("compose")?.addEventListener("input", event => {
    model.setDraft(key(), event.target.value);
    if (place === "inbox" && !bases.has(key())) bases.set(key(), model.thread(selected).revision);
    statuses.delete(key()); $("compose-status").textContent = "";
  });
  $("review-source")?.addEventListener("click", () => {
    bases.set(key(), model.thread(selected).revision); statuses.set(key(), "Conversation updated. Review your draft before sending.");
    transition(() => {}); document.querySelector(".reader").scrollTop = 0; $("compose").focus();
  });
  $("compose")?.addEventListener("keydown", event => {
    // Email is deliberately multiline; desktop room chat sends on unmodified Enter.
    if (place === "rooms" && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !event.repeat && !matchMedia("(pointer: coarse)").matches) {
      event.preventDefault(); $("compose-form").requestSubmit();
    }
  });
  $("compose-form")?.addEventListener("submit", event => {
    event.preventDefault(); const k = key();
    try {
      if (place === "rooms") model.postChat(model.draft(k), crypto.randomUUID());
      else if (pending.has(k)) {
        const receipt = model.reconcile(pending.get(k).id);
        if (!receipt) { statuses.set(k, "Still unknown. Keep this draft; do not resend."); render(); return; }
        pending.delete(k); bases.delete(k); model.setDraft(k, ""); statuses.set(k, "Sample recorded. Nothing was delivered externally.");
      } else {
        const t = model.thread(selected);
        const command = { id: crypto.randomUUID(), threadId: t.id, revision: bases.get(k) ?? t.revision, body: model.draft(k), to: t.address, from: t.account };
        const receipt = model.reply(command, $("reply-behavior").value);
        if (!receipt) { pending.set(k, command); statuses.set(k, "Confirmation lost. Check this attempt before sending again."); }
        else { bases.delete(k); model.setDraft(k, ""); statuses.set(k, "Sample recorded. Nothing was delivered externally."); }
      }
    } catch (error) { statuses.set(k, error.message); }
    transition(() => {});
  });
}
$("workspace").addEventListener("click", event => {
  const thread = event.target.closest("[data-thread]"), source = event.target.closest("[data-source]");
  if (thread) transition(() => { selected = thread.dataset.thread; });
  if (source) transition(() => { selected = model.shared.get(source.dataset.source).threadId; place = "inbox"; });
  if (event.target.closest("#back")) transition(() => { selected = null; });
  if (event.target.closest("#ask-room")) {
    share = { ticket: model.shareTicket(selected), id: crypto.randomUUID(), opener: event.target, indexes: [] };
    renderShare(); $("share-dialog").showModal();
  }
});
function renderShare() {
  const t = model.thread(share.ticket.threadId);
  $("share-options").innerHTML = t.paragraphs.map((p, i) => `<label><input type="checkbox" value="${i}"><span>${escape(p)}</span></label>`).join("");
  $("share-status").textContent = ""; $("share-submit").disabled = true; $("share-refresh").hidden = true;
}
$("share-options").addEventListener("change", () => {
  share.indexes = [...$("share-options").querySelectorAll("input:checked")].map(input => Number(input.value));
  $("share-submit").disabled = !share.indexes.length;
});
function closeShare() { $("share-dialog").close(); share = null; transition(() => {}); $("ask-room")?.focus(); }
$("share-close").addEventListener("click", closeShare);
$("share-dialog").addEventListener("cancel", event => { event.preventDefault(); closeShare(); });
$("share-refresh").addEventListener("click", () => {
  share.ticket = model.shareTicket(share.ticket.threadId); share.indexes = []; renderShare();
});
$("share-form").addEventListener("submit", event => {
  event.preventDefault();
  try { model.share(share.ticket, share.indexes, share.id); closeShare(); transition(() => { place = "rooms"; }); }
  catch (error) { $("share-status").textContent = error.message; $("share-refresh").hidden = false; $("share-submit").disabled = true; }
});
$("nav-inbox").addEventListener("click", () => transition(() => { place = "inbox"; }));
$("nav-rooms").addEventListener("click", () => transition(() => { place = "rooms"; }));
$("layout").addEventListener("change", event => transition(() => { layout = event.target.value; }));
$("change-source").addEventListener("click", () => {
  const id = share?.ticket.threadId ?? selected; if (!id) return;
  model.thread(id).revision++; model.thread(id).paragraphs[0] += " Updated: Friday also works.";
  if (!share) transition(() => {});
});
render();
