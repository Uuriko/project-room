import { EVENT_TYPES as T, WORK_STATES as S } from "./events.js";
import { RoomClient, draftCommand } from "./client.js";

const $ = selector => document.querySelector(selector);
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
let workDraftId = null, replyToId = null, busy = false;
const client = new RoomClient({
  onSnapshot(snapshot, identity) {
    state = snapshot.state; session = identity;
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#signout-button").hidden = false;
    $("#identity-label").textContent = `${state.members[session.member.id].displayName} · ${session.member.kind}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
  },
  onStatus(text) { $("#connection-status").textContent = text; },
  onAccessEnded() {
    state = null; session = null; pendingMessage = null; pendingWork = null; pendingAction = null;
    workDraftId = null; replyToId = null;
    $("#main").hidden = true; $("#auth-panel").hidden = false; $("#signout-button").hidden = true;
    $("#identity-label").textContent = "Not signed in";
    for (const id of ["message-list", "work-list", "event-list", "presence-list", "member-stack", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "message-count", "event-count"]) $(`#${id}`).replaceChildren();
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) form.reset();
    $("#action-dialog").close(); $("#new-work-form").hidden = true; $("#reply-bar").hidden = true;
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
function render() {
  const members = Object.values(state.members), active = members.filter(m => m.active !== false);
  selectOptions("#message-to-select", active, "Everyone in this room");
  selectOptions("#assignee-select", active.filter(m => m.permissions.includes("accept_work") && m.permissions.includes("complete_work")), "Choose accountable member");
  selectOptions("#verifier-select", active.filter(m => m.permissions.includes("verify")), "Choose independent verifier");
  $("#presence-count").textContent = `${active.length} members · presence not measured`;
  $("#member-stack").innerHTML = active.map(m => `<div class="member-avatar ${m.kind}" title="${esc(m.displayName)}"><span>${initials(m.displayName)}</span></div>`).join("");
  $("#presence-list").innerHTML = members.map(m => `<div class="presence-member"><div class="member-avatar ${m.kind}"><span>${initials(m.displayName)}</span></div><div><strong>${esc(m.displayName)}</strong><span>${esc(m.kind)} · ${m.active === false ? "access revoked" : "presence unknown"}</span><details><summary>Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p></details></div></div>`).join("");
  $("#new-work-button").disabled = !can("steer"); $("#composer-work-button").disabled = !can("steer");
  const items = Object.values(state.workItems);
  const waiting = items.filter(i => readyForDecision(i) && i.humanDecisionMakerId === session.member.id).length;
  $("#summary-grid").innerHTML = `<article class="summary-card"><span>Your decisions</span><strong>${waiting}</strong><p>Completion, verification, and approval stay separate.</p></article><article class="summary-card"><span>Work in this room</span><strong>${items.length}</strong><p>${items.filter(i => i.state === S.BLOCKED).length} blocked. Conversation never creates work automatically.</p></article>`;
  renderMessages();
  $("#work-list").innerHTML = items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(workCard).join("") || '<p class="empty-note">Nothing assigned. A room is useful before it has a task.</p>';
  $("#event-count").textContent = `${client.sequence}`;
  $("#event-list").innerHTML = [...state.eventLog].reverse().map(e => `<li><span>${esc(humanize(e.type))}</span><strong>${esc(name(e.actorId))}</strong><time>${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join("");
}
function renderMessages() {
  const list = $("#message-list"), oldTop = list.scrollTop;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const focused = document.activeElement?.closest("[data-message-id]");
  const focusId = focused?.dataset.messageId, focusAction = focused?.dataset.messageAction;
  $("#message-count").textContent = state.messages.length;
  list.innerHTML = state.messages.map(m => {
    const author = state.members[m.authorId];
    const linked = Object.values(state.workItems).filter(i => i.sourceMessageId === m.id || i.id === m.workItemId);
    return `<li id="message-${esc(m.id)}" class="message"><div class="message-avatar ${author.kind}">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(author.displayName)}</strong><span>${esc(author.kind)}</span><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></div><span class="audience-chip">${m.toMemberId ? `to ${esc(name(m.toMemberId))} · no processing receipt` : "to everyone"}</span>${m.replyToId ? `<a class="source-link" href="#message-${esc(m.replyToId)}">In reply to a room message</a>` : ""}<p>${esc(m.body)}</p><div class="message-links">${linked.map(i => `<a class="work-link" href="#${esc(i.id)}">↳ ${esc(i.title)}</a>`).join("")}<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button">Reply</button>${can("steer") ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : ""}</div></div></li>`;
  }).join("") || '<li class="empty-note">Start with a hello, a thought, or a question. No task required.</li>';
  list.scrollTop = nearBottom ? list.scrollHeight : oldTop;
  if (focusId) [...list.querySelectorAll("[data-message-id]")].find(e => e.dataset.messageId === focusId && e.dataset.messageAction === focusAction)?.focus({ preventScroll: true });
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
  return `<article id="${esc(i.id)}" class="work-card"><div class="work-card-header"><span class="state state-${i.state}">${esc(i.state)}</span><span class="mode">${esc(i.mode)} · revision ${i.revision}</span></div><h3>${esc(i.title)}</h3>${i.sourceMessageId ? `<a class="source-link" href="#message-${esc(i.sourceMessageId)}">From this conversation</a>` : ""}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(name(i.accountableMemberId))}</dd></div><div><dt>Verifier</dt><dd>${esc(name(i.verifierMemberId))}</dd></div></dl>${i.receipt ? `<div class="receipt"><p class="receipt-label">REPORTED COMPLETION · NOT AUTOMATIC VERIFICATION</p><p>${esc(i.receipt.summary)}</p><a href="${safeUrl(i.receipt.evidenceUrl)}" target="_blank" rel="noreferrer">Open submitted evidence ↗</a><code>${esc(i.receipt.evidenceVersion)}</code><p>${esc(i.receipt.nextAction)}</p>${i.verification ? `<p>${esc(i.verification.result.toUpperCase())} reported by ${esc(name(i.verification.verifierId))}: ${esc(i.verification.summary)}</p>` : "<p>No verification recorded.</p>"}</div>` : ""}${i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : ""}${i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : ""}${i.claim ? `<details class="claim"><summary>Recorded scope · ${activeClaim(i) ? "not expired" : "expired or released"}</summary><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p><p>Expires ${esc(i.claim.expiresAt)}. This service does not execute external actions.</p></details>` : ""}<div class="work-actions">${actions(i)}</div></article>`;
}
async function submit(form, fn) {
  if (busy) return;
  busy = true; const controls = [...form.querySelectorAll("button, input, select, textarea")];
  const disabled = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
  try { await fn(); }
  catch (error) { notice(`${error.message}. ${state ? "Draft kept; refresh and review before retrying." : "Sign in again."}`, true); }
  finally { busy = false; controls.forEach((e, i) => e.disabled = disabled[i]); if (state) render(); }
}
$("#auth-form").addEventListener("submit", async e => {
  e.preventDefault(); $("#auth-error").textContent = "";
  const accessKey = $("#access-key").value.trim();
  await submit(e.currentTarget, async () => {
    try { await client.login(accessKey); $("#access-key").value = ""; notice("Signed in. This identifies your provisioned account, not a named remote runtime."); }
    catch (error) { $("#auth-error").textContent = error.message; throw error; }
  });
});
$("#signout-button").addEventListener("click", async () => {
  if (busy) return;
  if ($("#message-input").value || !$("#new-work-form").hidden || $("#action-dialog").open) {
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
  submit(e.currentTarget, async () => {
    const receipt = await client.send(pendingMessage.command);
    $("#message-input").value = ""; pendingMessage = null; clearReply();
    notice(`Message stored once at event ${receipt.sequence}. Recipient processing is not confirmed.`);
  });
});
$("#message-list").addEventListener("click", e => {
  const button = e.target.closest("[data-message-id]"); if (!button || !state || busy) return;
  if (button.dataset.messageAction === "work") openWork(button.dataset.messageId);
  else { replyToId = button.dataset.messageId; $("#reply-context").textContent = `Replying to ${name(state.messages.find(m => m.id === replyToId).authorId)}`; $("#reply-bar").hidden = false; $("#message-input").focus(); }
});
function clearReply() { replyToId = null; $("#reply-bar").hidden = true; $("#reply-context").textContent = ""; }
$("#cancel-reply").addEventListener("click", clearReply);
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
window.addEventListener("beforeunload", () => client.disconnect());
client.restore().catch(error => {
  $("#auth-error").textContent = [401, 403].includes(error.status) ? "Use a provisioned human room key to enter. No demo identity is selected for you." : "Room service unavailable. Check the service and retry; no connection is claimed.";
  $("#auth-panel").hidden = false;
});
