import { EVENT_TYPES, WORK_STATES, event, replay } from "./events.js";
import { seedEvents } from "./seed.js";
import { loadEvents, openRoomChannel, resetEvents, saveEvents } from "./storage.js";

let events = loadEvents(seedEvents);
let state = replay(events);
let activeActorId = state.room.ownerId;

const $ = (selector) => document.querySelector(selector);
const actorSelect = $("#actor-select");
const channel = openRoomChannel((incoming) => {
  events = incoming;
  state = replay(events);
  render();
  announce("Room updated from another tab");
});

function append(next) {
  try {
    const nextState = replay([...events, next]);
    events = [...events, next];
    state = nextState;
    saveEvents(events);
    channel.publish(events);
    render();
    announce(humanize(next.type));
  } catch (error) {
    announce(error.message, true);
  }
}

function render() {
  renderActors();
  renderMembers();
  renderSummary();
  renderMessages();
  renderWork();
  renderEvents();
}

function renderActors() {
  const previous = activeActorId;
  actorSelect.innerHTML = Object.values(state.members)
    .map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.displayName)} · ${escapeHtml(member.kind)}</option>`)
    .join("");
  if (state.members[previous]) actorSelect.value = previous;

  const agents = Object.values(state.members).filter((member) => member.kind === "agent");
  $("#assignee-select").innerHTML = agents.map(optionForMember).join("");
  $("#verifier-select").innerHTML = agents.map(optionForMember).join("");
  if (agents.length > 1) $("#verifier-select").value = agents[1].id;
}

function renderMembers() {
  $("#member-stack").innerHTML = Object.values(state.members).map((member) => `
    <div class="member-avatar ${member.kind}" title="${escapeHtml(member.displayName)} · ${escapeHtml(member.kind)}">
      <span>${initials(member.displayName)}</span>
      <i class="availability ${member.availability}" aria-hidden="true"></i>
    </div>
  `).join("");
}

function renderSummary() {
  const items = Object.values(state.workItems);
  const waiting = items.filter((item) => ownerDecisionIsReady(item)).length;
  const moving = items.filter((item) => [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED].includes(item.state) || (item.state === WORK_STATES.COMPLETED && !item.decision)).length;
  const blocked = items.filter((item) => item.state === WORK_STATES.BLOCKED).length;
  const evidence = items.filter((item) => item.receipt).length;
  $("#summary-grid").innerHTML = [
    summaryCard("Waiting on you", waiting, waiting ? "Verified work is ready for an owner decision" : "No owner decisions are waiting", "attention"),
    summaryCard("In motion", moving, `${blocked} blocked · ${items.length} total work items`, "motion"),
    summaryCard("Evidence", evidence, "Exact versions attached to completion receipts", "evidence")
  ].join("");
}

function renderMessages() {
  $("#message-count").textContent = String(state.messages.length);
  $("#message-list").innerHTML = state.messages.map((message) => {
    const member = state.members[message.authorId];
    const linked = message.workItemId ? state.workItems[message.workItemId] : null;
    return `<li class="message">
      <div class="message-avatar ${member.kind}">${initials(member.displayName)}</div>
      <div class="message-content">
        <div class="message-meta"><strong>${escapeHtml(member.displayName)}</strong><span>${escapeHtml(member.kind)}</span><time>${formatTime(message.createdAt)}</time></div>
        <p>${escapeHtml(message.body)}</p>
        ${linked ? `<a class="work-link" href="#${escapeHtml(linked.id)}">↳ ${escapeHtml(linked.title)}</a>` : ""}
      </div>
    </li>`;
  }).join("");
  const list = $("#message-list");
  list.scrollTop = list.scrollHeight;
}

function renderWork() {
  const items = Object.values(state.workItems).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $("#work-list").innerHTML = items.map(renderWorkCard).join("");
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", handleWorkAction));
}

function renderWorkCard(item) {
  const accountable = state.members[item.accountableMemberId];
  const verifier = state.members[item.verifierMemberId];
  const isOwnerGate = ownerDecisionIsReady(item);
  return `<article id="${escapeHtml(item.id)}" class="work-card ${isOwnerGate ? "owner-gate" : ""}">
    <div class="work-card-header">
      <span class="state state-${escapeHtml(item.state)}">${escapeHtml(humanize(item.state))}</span>
      <span class="mode">${item.mode === "write" ? "write-scoped" : "read-only"} · r${item.revision}</span>
    </div>
    <h3>${escapeHtml(item.title)}</h3>
    <p class="definition">${escapeHtml(item.definitionOfDone)}</p>
    <dl class="work-facts">
      <div><dt>Accountable</dt><dd>${escapeHtml(accountable.displayName)}</dd></div>
      <div><dt>Verifier</dt><dd>${escapeHtml(verifier.displayName)}</dd></div>
      <div><dt>Next action</dt><dd>${escapeHtml(nextAction(item))}</dd></div>
    </dl>
    ${item.receipt ? renderReceipt(item) : ""}
    ${item.decision ? `<div class="decision"><strong>${escapeHtml(humanize(item.decision.decision))}</strong><p>${escapeHtml(item.decision.reason)}</p></div>` : ""}
    ${item.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${escapeHtml(item.blocker.reason)}</p></div>` : ""}
    ${item.claim?.status === "active" ? `<details class="claim"><summary>Active write claim</summary><p>${escapeHtml(item.claim.repository)}:${escapeHtml(item.claim.ref)}</p><p>${item.claim.paths.map(escapeHtml).join(", ")}</p></details>` : ""}
    <div class="work-actions">${actionsFor(item).join("") || `<span class="no-action">No valid action for ${escapeHtml(state.members[activeActorId].displayName)}</span>`}</div>
  </article>`;
}

function renderReceipt(item) {
  const producer = state.members[item.receipt.producerId];
  const verifier = item.verification ? state.members[item.verification.verifierId] : null;
  return `<div class="receipt">
    <p class="receipt-label">EVIDENCE RECEIPT</p>
    <p>${escapeHtml(item.receipt.summary)}</p>
    <a href="${safeUrl(item.receipt.evidenceUrl)}" target="_blank" rel="noreferrer">Open exact evidence ↗</a>
    <code>${escapeHtml(shortVersion(item.receipt.evidenceVersion))}</code>
    <div class="receipt-checks"><span>Reported by ${escapeHtml(producer.displayName)}</span>${verifier ? `<span class="verified">${item.verification.result.toUpperCase()} · ${escapeHtml(verifier.displayName)}</span>` : `<span>Awaiting ${escapeHtml(state.members[item.verifierMemberId].displayName)}</span>`}</div>
  </div>`;
}

function actionsFor(item) {
  const buttons = [];
  if (item.state === WORK_STATES.PROPOSED && activeActorId === item.accountableMemberId) buttons.push(actionButton("accept", "Accept"));
  if (item.state === WORK_STATES.ACCEPTED && activeActorId === item.accountableMemberId) {
    if (item.mode === "write" && !item.claim) buttons.push(actionButton("claim", "Claim write scope"));
    if (item.mode === "read" || item.claim?.status === "active") buttons.push(actionButton("start", "Start"));
  }
  if (item.state === WORK_STATES.BLOCKED && activeActorId === item.accountableMemberId) buttons.push(actionButton("resolve", "Accept revised direction"));
  if (item.state === WORK_STATES.WORKING && activeActorId === item.accountableMemberId) buttons.push(actionButton("complete", "Post receipt"));
  if (item.state === WORK_STATES.COMPLETED && !item.verification && activeActorId === item.verifierMemberId) {
    buttons.push(actionButton("verify-pass", "Verify pass", "primary"));
    buttons.push(actionButton("verify-fail", "Report finding"));
  }
  if (ownerDecisionIsReady(item) && activeActorId === item.humanDecisionMakerId) {
    buttons.push(actionButton("approve", "Approve", "primary"));
    buttons.push(actionButton("changes", "Request changes"));
  }
  return buttons.map((button) => button.replace("<button", `<button data-work-id="${escapeHtml(item.id)}"`));
}

function handleWorkAction({ currentTarget }) {
  const item = state.workItems[currentTarget.dataset.workId];
  const action = currentTarget.dataset.action;
  const base = { roomId: state.room.id, actorId: activeActorId, causationId: latestEventId(item.id), data: { workItemId: item.id, expectedRevision: item.revision } };
  if (action === "accept") append(event({ ...base, type: EVENT_TYPES.WORK_ACCEPTED }));
  if (action === "claim") append(event({ ...base, type: EVENT_TYPES.CLAIM_ACQUIRED, data: { ...base.data, repository: "Uuriko/project-room", ref: "demo/claimed-work", paths: ["src/**"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }));
  if (action === "start") append(event({ ...base, type: EVENT_TYPES.WORK_STARTED }));
  if (action === "resolve") append(event({ ...base, type: EVENT_TYPES.WORK_BLOCKER_RESOLVED, data: { ...base.data, resolution: "Accepted the revised direction for a new attempt." } }));
  if (action === "complete") append(event({ ...base, type: EVENT_TYPES.WORK_COMPLETED, data: { ...base.data, summary: "Accountable member reports the defined outcome is complete.", evidenceUrl: "https://github.com/Uuriko/project-room", evidenceVersion: `demo-${Date.now()}`, checksClaimed: ["definition of done"], nextAction: `${state.members[item.verifierMemberId].displayName} independently checks this version` } }));
  if (action === "verify-pass") append(event({ ...base, type: EVENT_TYPES.VERIFICATION_RECORDED, data: { ...base.data, result: "pass", completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion, summary: "Exact evidence version independently checked." } }));
  if (action === "verify-fail") append(event({ ...base, type: EVENT_TYPES.VERIFICATION_RECORDED, data: { ...base.data, result: "fail", completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion, summary: "Evidence does not yet satisfy the definition of done.", nextAction: `${state.members[item.accountableMemberId].displayName} addresses the finding` } }));
  if (action === "approve") append(event({ ...base, type: EVENT_TYPES.OWNER_DECISION_RECORDED, data: { ...base.data, decision: "approved", completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion, reason: "Verified result accepted." } }));
  if (action === "changes") append(event({ ...base, type: EVENT_TYPES.OWNER_DECISION_RECORDED, data: { ...base.data, decision: "changes_requested", completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion, reason: "Revise against the owner feedback." } }));
}

function renderEvents() {
  const recent = [...state.eventLog].reverse().slice(0, 12);
  $("#event-count").textContent = String(state.eventLog.length);
  $("#event-list").innerHTML = recent.map((item) => {
    const actor = state.members[item.actorId];
    return `<li><span class="event-node" aria-hidden="true"></span><div><strong>${escapeHtml(humanize(item.type))}</strong><p>${escapeHtml(actor?.displayName || item.actorId)} · ${formatTime(item.at)}</p></div></li>`;
  }).join("");
}

actorSelect.addEventListener("change", () => {
  activeActorId = actorSelect.value;
  renderWork();
  announce(`Acting as ${state.members[activeActorId].displayName}`);
});

$("#message-form").addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const input = $("#message-input");
  append(event({ roomId: state.room.id, type: EVENT_TYPES.MESSAGE_POSTED, actorId: activeActorId, data: { body: input.value.trim() } }));
  input.value = "";
});

$("#new-work-button").addEventListener("click", () => {
  $("#new-work-form").hidden = false;
  $("#work-title-input").focus();
});

$("#cancel-work-button").addEventListener("click", () => {
  $("#new-work-form").hidden = true;
});

$("#new-work-form").addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  append(event({
    roomId: state.room.id,
    type: EVENT_TYPES.WORK_PROPOSED,
    actorId: activeActorId,
    data: {
      workItemId: `work-${Date.now()}`,
      title: $("#work-title-input").value.trim(),
      definitionOfDone: $("#work-done-input").value.trim(),
      accountableMemberId: $("#assignee-select").value,
      verifierMemberId: $("#verifier-select").value,
      independentVerificationRequired: true,
      ownerDecisionRequired: true,
      humanDecisionMakerId: state.room.ownerId,
      mode: "read"
    }
  }));
  submitEvent.currentTarget.reset();
  submitEvent.currentTarget.hidden = true;
});

$("#reset-button").addEventListener("click", () => {
  events = resetEvents(seedEvents);
  state = replay(events);
  activeActorId = state.room.ownerId;
  channel.publish(events);
  render();
  announce("Demo reset");
});

window.addEventListener("beforeunload", () => channel.close());
render();

function latestEventId(workItemId) {
  return [...state.eventLog].reverse().find((item) => item.data?.workItemId === workItemId)?.id || null;
}

function nextAction(item) {
  if (item.blocker) return item.blocker.nextAction;
  if (item.state === WORK_STATES.PROPOSED) return `${state.members[item.accountableMemberId].displayName} accepts or declines`;
  if (item.state === WORK_STATES.ACCEPTED) return `${state.members[item.accountableMemberId].displayName} starts work`;
  if (item.state === WORK_STATES.WORKING) return `${state.members[item.accountableMemberId].displayName} posts evidence`;
  if (item.state === WORK_STATES.COMPLETED && !item.verification) return `${state.members[item.verifierMemberId].displayName} checks ${shortVersion(item.receipt.evidenceVersion)}`;
  if (ownerDecisionIsReady(item)) return `${state.members[item.humanDecisionMakerId].displayName} decides`;
  if (item.decision?.decision === "approved") return "Loop complete; merge or deploy remains a separate action";
  if (item.state === WORK_STATES.SUPERSEDED) return "Follow the replacement Work Item";
  return "Review the latest event";
}

function ownerDecisionIsReady(item) {
  if (!item.ownerDecisionRequired || item.decision || item.state !== WORK_STATES.COMPLETED) return false;
  return !item.independentVerificationRequired || item.verification?.result === "pass";
}

function actionButton(action, label, style = "secondary") {
  return `<button class="button ${style}" data-action="${action}" type="button">${label}</button>`;
}

function summaryCard(label, value, copy, tone) {
  return `<article class="summary-card ${tone}"><span>${escapeHtml(label)}</span><strong>${value}</strong><p>${escapeHtml(copy)}</p></article>`;
}

function optionForMember(member) {
  return `<option value="${escapeHtml(member.id)}">${escapeHtml(member.displayName)}</option>`;
}

function announce(message, error = false) {
  const status = $("#status");
  status.textContent = message;
  status.classList.toggle("error", error);
  status.classList.add("visible");
  clearTimeout(announce.timeout);
  announce.timeout = setTimeout(() => status.classList.remove("visible"), 2600);
}

function humanize(value) {
  return String(value).replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function initials(name) {
  return name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
}

function shortVersion(version) {
  return version.length > 14 ? `${version.slice(0, 10)}…` : version;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? escapeHtml(parsed.href) : "#";
  } catch {
    return "#";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}
