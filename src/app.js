import { EVENT_TYPES as T, WORK_STATES as S } from "./events.js";
import { AccountClient, RoomClient, draftCommand, retryUnconfirmed } from "./client.js";
import { ReturnBrief } from "./return-brief.js";
import { needsAttention, workInvolvingMe, contributionSteps, searchWork, draftFeedback, completedResults, currentResult } from "./work-selectors.js";
import { REACTIONS, conversationIndex, searchMessages, ConversationDrafts, DraftRecovery, draftRecoveryScope, sendsOnEnter, messageCluster, mentionQuery, mentionMatches, mentionHtml, kindLabel, memberStatus, addressMember, shouldAddressPresenceClick } from "./conversation.js";
import { nextWorkStep, workStatus, workActions, activeClaim, terminalWork, reusableWorkDefinition, confirmsWorkProposal, confirmsWorkAction, matchesReceipt, producerKnown as hasReportedProducer } from "./workflow.js";
import { consumeJoinFragment, installShareLinks, canRetryInvitation } from "./share-links.js";
import { installAgentConnections } from "./agent-connections.js";
import { installRoomInstructions } from "./room-instructions.js";
import { installReminders } from "./reminders.js";
import { installPortableWork, installResultCopy } from "./portable-work.js";
import { replyDraftKey, replyDraftData, validReplyDraft, creditQuestion, confirmsReplyCommand, REPLY_CANCELLED } from "./reply-requests.js";
import { workHelpContext, validateHelpData } from "./work-help.js";
import { workOffersContext, validateHelpOfferData } from "./help-offers.js";
import { installInbox } from "./inbox-ui.js";

const $ = selector => document.querySelector(selector);
$("#skip-link").addEventListener("click", event => {
  event.preventDefault();
  const target = !$("#inbox-panel").hidden ? "#inbox-heading"
    : $("#auth-panel").hidden ? "#connection-status"
    : "#auth-title";
  $(target).focus();
});
const setText = (selector, text) => { const node = $(selector); if (node.textContent !== text) node.textContent = text; };
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const roomIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function consumeInvitationFragment() {
  if (!location.hash.startsWith("#invite/")) return null;
  const candidate = location.hash.slice("#invite/".length);
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return invitationTokenPattern.test(candidate)
    ? { valid: true, secret: candidate }
    : { valid: false, secret: null };
}
function selectedRoomFromLocation() {
  const values = new URLSearchParams(location.search).getAll("room");
  return values.length === 1 && roomIdPattern.test(values[0]) ? values[0] : null;
}
function accountHomeFromLocation() {
  const values = new URLSearchParams(location.search).getAll("account");
  return values.length === 1 && values[0] === "1";
}
function storedAuthKind() {
  try { return sessionStorage.getItem("pr-auth-kind"); } catch { return null; }
}
let authKind = accountHomeFromLocation() || selectedRoomFromLocation()
  ? "account"
  : storedAuthKind() === "account" ? "account" : "room";
function accountSignIn() {
  return authKind === "account" || accountHomeFromLocation();
}
const initialJoinFragment = consumeJoinFragment();
const initialInvitationFragment = consumeInvitationFragment();
let shareLinksUI = null;
let portableWorkUI = null;
let resultCopyUI = null;
let remindersUI = null;
let agentConnectionsUI = null;
let instructionsUI = null;
let inboxUI = null;
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
let workDraftId = null, replyToId = null, busy = false;
let workFormEpoch = 0, workRetryLocked = false;
let actionEpoch = 0;
let offerContextVersion = null;
let currentThreadId = null, conversation = null, drafts = new ConversationDrafts();
let requestMode = null, requestReading = false, requestEpoch = 0;
const composerKey = () => replyDraftKey(requestMode, currentThreadId);
const viewPositions = new Map(), pendingReactions = new Map(), locallyOwnedMessageIds = new Set();
let newVisibleMessages = 0, unreadAnchorId = null, mentionIndex = 0;
let roomCursor = 0, roomGeneration = -1, showAllAttention = false, returnClock = null;
let signoutOperationId = 0, signoutLoading = false;
let refreshOperationId = 0, submitOperationId = 0;
let submitControls = null, noticeTimer = null, noticeVersion = 0, workFormOpener = null;
let accessEndContext = null;
let lastComposerSelection = null;
let lastInvitationOpener = null;
let roomActionsContext = null;
let selectedWorkView = "work";
const invitation = {
  phase: "idle", version: 0, secret: null, preview: null, redemptionId: null,
  opener: null, openerSelection: null
};
const invitationIsCommitting = () => ["authenticating", "accepting", "opening"].includes(invitation.phase);
const accountClient = new AccountClient();
document.addEventListener("focusin", event => {
  if (!$("#invitation-dialog").contains(event.target)
    && event.target.matches?.("button, input, textarea, select, a[href], [tabindex]")) lastInvitationOpener = event.target;
});
document.addEventListener("pointerdown", event => {
  if (event.target !== $("#message-input") && !$("#invitation-dialog").contains(event.target)) lastComposerSelection = null;
});
document.addEventListener("keydown", event => {
  if (event.key === "Tab" && event.target === $("#message-input")) lastComposerSelection = null;
});
let recovery;
let leavingPage = false;
try { recovery = new DraftRecovery(window.sessionStorage); } catch { recovery = new DraftRecovery(null); }
const draftScope = draftRecoveryScope;
const client = new RoomClient({
  accountClient,
  onSnapshot(snapshot, identity) {
    const firstSnapshot = !state;
    state = snapshot.state; session = identity;
    offerContextVersion = snapshot.offerContextVersion === 1 ? 1 : null;
    roomCursor = snapshot.cursor;
    roomGeneration = client.generation;
    const roomId = state.room?.id ?? identity.roomId;
    $("#room-title").textContent = state.room?.title ?? roomId;
    $(".room-purpose").textContent = state.room?.purpose ?? "";
    $("#conversation-title").textContent = `# ${roomId}`;
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#auth-panel").setAttribute("aria-busy", "false");
    $("#account-rooms-panel").hidden = true;
    $(".connection-bar").hidden = false;
    $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
    $("#identity-label").textContent = displayName(session.member.id);
    $("#identity-label").title = `${memberLabel(session.member.id)} · ${kindLabel(session.member.kind)}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
    shareLinksUI?.sync();
    remindersUI?.sync();
    agentConnectionsUI?.sync();
    updatePeopleHint();
    if (firstSnapshot) showRoomGuide();
    instructionsUI?.sync();
    resultCopyUI?.sync();
    portableWorkUI?.sync();
    inboxUI?.sync();
    if (firstSnapshot) {
      const saved = recovery.read(draftScope(identity), state);
      if (saved) {
        drafts = saved.drafts; currentThreadId = saved.threadId;
        const draft = drafts.get(saved.activeKey);
        requestMode = draft.mode ?? null;
        restoreComposer(draft);
        $("#remember-drafts").checked = true;
        updateReply(); renderMessages(); syncRequestComposer(); renderComposerError();
        $("#draft-recovery-status").textContent = "Recovered drafts for this room. Review before sending.";
      }
    }
    if (!briefView.owns(briefView.chain)) loadReturnBrief();
    if (firstSnapshot) revealLocationHash();
  },
  onStatus(text) { setConnectionStatus(text); },
  onAccessEnded() {
    closeRoomActions(false);
    const endedContext = accessEndContext;
    accessEndContext = null;
    const pendingSignout = signoutLoading;
    const keepAccount = !leavingPage && !pendingSignout && endedContext !== "account-switch" && accountClient.session?.authenticated;
    if (!leavingPage) recovery.clear();
    releaseSubmission(submitControls);
    submitOperationId += 1; busy = false;
    state = null; session = null; pendingMessage = null; pendingWork = null; pendingAction = null; offerContextVersion = null; actionEpoch++;
    $("#resume-action").hidden = true; $("#refresh-action").hidden = true;
    $("#action-evidence").hidden = true; $("#action-evidence").removeAttribute("href");
    $("#action-text").hidden = true; $("#action-text-body").textContent = ""; $("#action-text-origin").textContent = "";
    closeResult(false);
    selectWorkView("work");
    renderContent("#room-results-list", "");
    roomCursor = 0; roomGeneration = -1; showAllAttention = false; clearTimeout(returnClock); returnClock = null;
    shareLinksUI?.resetManagement();
    portableWorkUI?.reset();
    resultCopyUI?.reset();
    remindersUI?.reset();
    agentConnectionsUI?.reset();
    instructionsUI?.reset();
    if (!keepAccount) clearPrivateWorkspace({ preservePending: leavingPage });
    else inboxUI?.detachRoom();
    workDraftId = null; replyToId = null; workFormEpoch++; setWorkRetry(false);
    $("#work-reuse-hint").hidden = true;
    currentThreadId = null; conversation = null; drafts = new ConversationDrafts();
    requestMode = null; requestReading = false; requestEpoch++; syncRequestComposer();
    renderComposerError();
    viewPositions.clear(); pendingReactions.clear(); locallyOwnedMessageIds.clear(); newVisibleMessages = 0; briefView.reset();
    if (!pendingSignout) signoutOperationId += 1;
    refreshOperationId += 1;
    $("#signout-button").disabled = pendingSignout;
    workFormOpener = null; clearNotice();
    $("#main").hidden = true; $("#auth-panel").hidden = false; $("#signout-button").hidden = true;
    $("#auth-panel").setAttribute("aria-busy", pendingSignout ? "true" : "false");
    $("#identity-label").textContent = "Not signed in";
    $("#identity-label").removeAttribute("title");
    for (const id of ["message-list", "work-list", "event-list", "presence-list", "member-stack", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "message-count", "event-count", "rb-attention-list", "rb-involving-list", "rb-history-list"]) {
      const node = $(`#${id}`); node.replaceChildren(); delete node._content;
    }
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) {
      if (!keepAccount || !form.closest("#inbox-panel")) form.reset();
    }
    $("#work-dialog").close();
    for (const id of ["people-panel", "composer-options", "work-options", "room-about", "connection-details", "rb-history-section", "rb-involving-section"]) $(`#${id}`).open = false;
    if ($("#room-guide")) $("#room-guide").hidden = true;
    if ($("#people-hint")) $("#people-hint").textContent = "";
    for (const control of document.querySelectorAll("#auth-form input, #auth-form button")) control.disabled = pendingSignout;
    setFormStatus($("#new-work-status"), ""); setFormStatus($("#action-error"), ""); setFormStatus($("#composer-status"), "");
    $("#action-dialog").close(); $("#new-work-form").hidden = true; $("#reply-bar").hidden = true;
    for (const id of ["review-criteria", "review-summary", "review-next", "decision-review-label", "decision-review-by", "decision-review-text", "decision-review-version"]) setText(`#${id}`, "");
    $("#review-brief").hidden = true; $("#review-notes").open = false;
    $("#decision-review").hidden = true; $("#decision-review").open = false;
    $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = "";
    $("#thread-title").textContent = ""; $("#thread-context").textContent = "";
    $("#thread-bar").hidden = true; $("#search-results").hidden = true; $("#new-messages-button").hidden = true;
    $("#conversation-announcement").textContent = ""; delete $("#message-list").dataset.view;
    for (const id of ["rb-attention-list", "rb-involving-list", "rb-history-list"]) delete $(`#${id}`)._content;
    $("#rb-current-boundary").textContent = ""; $("#rb-history-boundary").textContent = "";
    $("#rb-ack-button").textContent = "Mark caught up"; $("#return-brief-panel").open = false;
    renderReturnBrief();
    if (keepAccount) {
      showAccountWorkspace();
      if (!["accepted-room-switch", "invited-room-switch"].includes(endedContext)) confirmAccount();
      return;
    }
    const openingAcceptedRoom = endedContext === "accepted-room-switch";
    const openingInvitedRoom = endedContext === "invited-room-switch";
    const switchedAccount = endedContext === "account-switch";
    setFormStatus($("#auth-error"), openingAcceptedRoom || openingInvitedRoom || $("#invitation-dialog").open ? ""
      : switchedAccount ? "The browser account changed; private Room state and drafts were cleared."
        : "Session ended; private drafts were cleared.", true);
    setConnectionStatus(openingAcceptedRoom || openingInvitedRoom ? "Opening Room…" : "Not connected");
    if ($("#invitation-dialog").open && invitation.preview) {
      if (!accountClient.session?.authenticated && ["ready", "wrong-account", "changed-account"].includes(invitation.phase)) invitation.phase = "needs-account";
      renderInvitation();
    }
    if (!pendingSignout) queueMicrotask(() => {
      if (!$("#invitation-dialog").open) $("#access-key").focus({ preventScroll: true });
    });
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
remindersUI = installReminders({ client, getState: () => state, onSaved: text => notice(text) });
agentConnectionsUI = installAgentConnections({ client, getState: () => state });
instructionsUI = installRoomInstructions({ client, getState: () => state, onSaved: text => notice(text) });
portableWorkUI = installPortableWork({ client, getState: () => state, onSaved: messageId => {
  const visible = conversation?.byId.has(messageId);
  if (visible) revealMessage(messageId);
  notice(visible ? "Draft posted. Work status is unchanged." : "Draft posted. Refresh to view it. Work status is unchanged.");
} });
resultCopyUI = installResultCopy({ client, getState: () => state });
inboxUI = installInbox({ account: accountClient, room: client, getRoom: () => state, onOpenWork: id => revealWork(id),
  onAccountEnded: endAccountAccess, onRooms: () => loadAccountRooms(),
  onNavigate: () => { if (!$("#status").classList.contains("error")) clearNotice(); },
  onShared: async (receipt, isCurrent) => {
  try { await client.refresh(); if (state && isCurrent()) revealMessage(receipt.messageId); }
  catch { if (isCurrent()) notice("Shared. Refresh the room to view it.", true); }
} });
let accountCheckFlight = null, roomListVersion = 0, roomListCursor = null;
function clearPrivateWorkspace(options) {
  inboxUI?.reset(options); roomListVersion++;
  $("#account-rooms-list").replaceChildren(); $("#account-rooms-status").textContent = "";
  $("#account-status").textContent = ""; $("#account-status").hidden = true;
}
function endAccountAccess() {
  const current = accountClient.session;
  if (current) accountClient.invalidate(accountClient.generation, current);
  $(".connection-bar").hidden = false;
  accessEndContext = "account-switch"; client.endAccess();
  configureAuthPanel();
}
function showAccountWorkspace() {
  if (!accountClient.session?.authenticated) return;
  $("#auth-panel").hidden = true; $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
  if (!state) {
    $("#identity-label").textContent = "Personal account";
    $("#identity-label").title = accountClient.session.account.id;
    setConnectionStatus("Room not open");
    $(".connection-bar").hidden = true;
  }
  inboxUI.sync();
  if (!state) {
    if (location.hash === "#pr-view/rooms") inboxUI.showRoomList();
    else inboxUI.open();
  }
}
async function confirmAccount() {
  if (accountCheckFlight || !accountClient.session?.authenticated || signoutLoading || invitationIsCommitting() || leavingPage) return accountCheckFlight;
  const owned = accountClient.session;
  accountCheckFlight = (async () => {
    try {
      const confirmed = await accountClient.confirm();
      if (confirmed === false && accountClient.session === null) endAccountAccess();
      else if (confirmed && $("#account-status").textContent === "Couldn’t confirm account. Refresh to retry.") {
        $("#account-status").textContent = ""; $("#account-status").hidden = true;
      }
      return confirmed;
    } catch {
      if (accountClient.session === owned) { $("#account-status").textContent = "Couldn’t confirm account. Refresh to retry."; $("#account-status").hidden = false; }
      return null;
    }
  })().finally(() => { accountCheckFlight = null; });
  return accountCheckFlight;
}
async function loadAccountRooms(more = false) {
  const version = ++roomListVersion, owned = accountClient.session;
  if (!owned?.authenticated) return;
  if (!more) { roomListCursor = null; $("#account-rooms-list").replaceChildren(); }
  $("#account-rooms-more").hidden = true; $("#account-rooms-status").textContent = "Loading…";
  try {
    const value = await accountClient.rooms(more ? roomListCursor : null);
    if (version !== roomListVersion || accountClient.session !== owned || !value) return;
    for (const room of value.rooms) {
      const button = document.createElement("button"); button.type = "button"; button.className = "inbox-row";
      button.dataset.accountRoom = room.id;
      const title = typeof room.title === "string" ? room.title.trim() : "";
      const named = title && title !== room.id;
      const heading = document.createElement("strong");
      heading.textContent = named ? title : room.id;
      const action = document.createElement("span");
      action.textContent = "Open";
      button.append(heading, action);
      button.setAttribute("aria-label", `Open ${named ? title : room.id}`);
      button.addEventListener("click", () => openAccountRoom(room.id)); $("#account-rooms-list").append(button);
    }
    roomListCursor = value.nextCursor; $("#account-rooms-more").hidden = !roomListCursor;
    $("#account-rooms-status").textContent = $("#account-rooms-list").children.length ? "" : roomListCursor ? "No available rooms on this page." : "No rooms yet.";
  } catch (error) {
    if (version !== roomListVersion || (accountClient.session && accountClient.session !== owned)) return;
    if ([401, 403].includes(error.status) || !accountClient.session) endAccountAccess();
    else $("#account-rooms-status").textContent = "Couldn’t load rooms. Choose Rooms to retry.";
  }
}
async function openAccountRoom(roomId) {
  if (invitationIsCommitting() || signoutLoading) return;
  if (state) saveComposer();
  if (state && (drafts.hasText() || pendingAction || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending()
      || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || !$("#new-work-form").hidden)
      && !window.confirm("Switch rooms and clear unsent room drafts and pending retries? Saved work stays.")) return;
  const owned = accountClient.session;
  if (await confirmAccount() !== true || accountClient.session !== owned) return;
  accessEndContext = "accepted-room-switch"; client.endAccess();
  history.replaceState(null, "", "?room=" + encodeURIComponent(roomId) + "#pr-view/rooms");
  try { await client.restore(roomId); }
  catch {
    if (accountClient.session !== owned) return;
    showAccountWorkspace(); inboxUI.showRoomList();
    $("#account-rooms-status").textContent = "Couldn’t open that room. Refresh rooms to retry.";
  }
}
$("#choose-room").addEventListener("click", () => inboxUI.showRoomList());
$("#account-rooms-more").addEventListener("click", () => loadAccountRooms(true));
window.addEventListener("focus", () => confirmAccount());
document.addEventListener("visibilitychange", () => { if (!document.hidden) confirmAccount(); });
setInterval(() => { if (!document.hidden) confirmAccount(); }, 5000);
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const humanize = value => String(value).replaceAll("_", " ").replaceAll(".", " ");
const memberLabel = id => id == null ? "Unassigned" : state.members[id] ? `${state.members[id].displayName} (${id})` : `Unknown member (${id})`;
// Keep ordinary conversation readable; exact IDs remain in details and decision
// controls. Duplicate names retain the full ID so attribution stays unambiguous.
const displayName = id => {
  const member = state.members[id];
  if (!member) return memberLabel(id);
  const duplicate = Object.values(state.members).some(other => other.id !== id
    && other.displayName.trim().toLocaleLowerCase() === member.displayName.trim().toLocaleLowerCase());
  return duplicate ? memberLabel(id) : member.displayName;
};
const name = displayName; // Ordinary summaries use the same duplicate-aware attribution as authors.
const can = capability => state?.members[session?.member.id]?.permissions.includes(capability);
const sameSession = (generation, roomId, memberId) => generation === client.generation && state
  && session?.roomId === roomId && session?.member.id === memberId;
const initials = text => esc(text.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase());
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const time = value => timeFormat.format(new Date(value));
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
  const connected = normalized === "Connected to room service · no peer read or processing receipt";
  const visible = connected ? "Connected" : normalized;
  status.dataset.state = connected ? "connected"
    : /^Not connected · (account )?sign.in required$/.test(normalized) ? "signed-out" : "other";
  if (status.textContent !== visible) status.textContent = visible;
  $("#connection-explanation").textContent = normalized;
}
function setFormStatus(status, text, error = false) {
  if (status.textContent === text && status.classList.contains("visible") === Boolean(text)
    && status.classList.contains("error") === (Boolean(text) && error)) return;
  status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text) && error);
}
function renderComposerError() {
  const text = drafts.get(composerKey()).error;
  const status = $("#composer-status");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text));
}
function setComposerError(text) {
  drafts.save(composerKey(), { error: text });
  renderComposerError();
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
let accountRestoreFlight = null;
function ensureAccountSession() {
  if (accountClient.session) return Promise.resolve(accountClient.session);
  if (accountRestoreFlight) return accountRestoreFlight;
  accountRestoreFlight = accountClient.restore().finally(() => { accountRestoreFlight = null; });
  return accountRestoreFlight;
}
function sameAccountTuple(left, right) {
  return Boolean(left?.account && right?.account)
    && left.account.id === right.account.id
    && left.account.authEpoch === right.account.authEpoch
    && left.sessionRevision === right.sessionRevision
    && left.sessionBinding === right.sessionBinding;
}
function currentInvitation(version, secret) {
  return invitation.version === version && invitation.secret === secret && $("#invitation-dialog").open;
}
function setInvitationFeedback(text, error = false) {
  $("#invitation-status").textContent = error ? "" : text;
  $("#invitation-error").textContent = error ? text : "";
  if (error && text) {
    const version = invitation.version;
    queueMicrotask(() => {
      if (version !== invitation.version || !$("#invitation-dialog").open || $("#invitation-error").textContent !== text) return;
      const usable = element => !element.disabled && element.getClientRects().length > 0;
      const target = [$("#invitation-account-key"), $("#invitation-accept"), $("#invitation-retry"), $("#invitation-dismiss")].find(usable) ?? $("#invitation-title");
      target.focus({ preventScroll: false });
    });
  }
}
function configureAuthPanel(roomId = selectedRoomFromLocation()) {
  const accountMode = accountSignIn();
  $("#auth-title").textContent = roomId && accountMode ? "Open this room" : "Welcome.";
  $("#access-key-label").textContent = accountMode ? "Account key" : "Room key";
  if ($("#auth-lead")) {
    $("#auth-lead").textContent = accountMode
      ? roomId ? `Paste the account key that can open #${roomId}. Have a room key? Choose Room key.` : "Paste your account key. Inbox does not need a room."
      : "Paste your room key. Same browser as last time? You may already be in.";
  }
  $("#auth-kind-room")?.setAttribute("aria-pressed", accountMode ? "false" : "true");
  $("#auth-kind-account")?.setAttribute("aria-pressed", accountMode ? "true" : "false");
  $("#auth-kind-room")?.classList.toggle("suggested", Boolean(accountMode && roomId));
  $("#auth-description").textContent = accountMode
    ? roomId ? "Use an account key with membership in this room." : "Use your account key. No room membership is needed."
    : "Ask the room owner for an invite link or room key.";
  $("#auth-hint").textContent = accountMode
    ? roomId ? "Need membership? Ask the room owner. Keep your key private." : "Keep your key private."
    : "Keep your key private. Lost guest access? Ask for a new invite.";
  $("#auth-form button[type='submit']").textContent = accountMode ? (roomId ? "Open room" : "Sign in") : "Enter room";
}
function setAuthKind(kind) {
  authKind = kind === "account" ? "account" : "room";
  try { sessionStorage.setItem("pr-auth-kind", authKind); } catch {}
  const url = new URL(location.href);
  if (authKind === "account" && !selectedRoomFromLocation()) url.searchParams.set("account", "1");
  else url.searchParams.delete("account");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  configureAuthPanel();
  $("#access-key").focus({ preventScroll: true });
}
function updatePeopleHint() {
  const hint = $("#people-hint");
  if (!hint) return;
  hint.textContent = $("#connect-agent-button")?.hidden
    ? "Agents join this chat as named people. Click a name to address them. The owner plugs agents in from here."
    : "Agents join this chat as named people. Click a name to address them. Roster fills the name; Create access issues the key.";
}
function showRoomGuide() {
  const guide = $("#room-guide");
  if (!guide) return;
  try { if (sessionStorage.getItem("pr-guide-dismissed") === "1") { guide.hidden = true; return; } } catch {}
  guide.hidden = false;
}
function inviteSecretFromText(value) {
  const text = String(value ?? "").trim();
  const fromLink = /#invite\/([A-Za-z0-9_-]{43})/.exec(text);
  if (fromLink) return fromLink[1];
  return invitationTokenPattern.test(text) ? text : null;
}
function renderInvitation() {
  const preview = invitation.preview;
  const phase = invitation.phase;
  const pending = preview?.status === "pending" && phase !== "terminal";
  const accepted = preview?.status === "accepted" && phase !== "terminal";
  const authenticated = Boolean(accountClient.session?.authenticated && accountClient.session.account);
  const switchingAccount = ["wrong-account", "changed-account"].includes(phase);
  const loading = ["previewing", "authenticating", "accepting", "opening"].includes(phase);
  $("#invitation-dialog").setAttribute("aria-busy", loading ? "true" : "false");
  $("#invitation-retry").hidden = phase !== "preview-failed";
  $("#invitation-details").hidden = !preview;
  if (preview) {
    $("#invitation-room").textContent = preview.roomTitle || preview.roomId;
    $("#invitation-purpose").textContent = preview.roomPurpose || "Not provided";
    $("#invitation-display-name").textContent = preview.displayName;
    $("#invitation-member-id").textContent = preview.memberId;
    $("#invitation-role").textContent = humanize(preview.role);
    $("#invitation-permissions").textContent = preview.permissions.length
      ? preview.permissions.map(humanize).join(", ")
      : "Conversation only";
    $("#invitation-issuer").textContent = preview.invitedByDisplayName || "Room administrator";
    const expiry = new Date(preview.expiresAt);
    $("#invitation-expires").dateTime = expiry.toISOString();
    $("#invitation-expires").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(expiry);
  }
  let summary = phase === "terminal" ? "This invitation is unavailable." : "Checking invitation…";
  if (preview && phase !== "terminal") summary = pending
    ? ""
    : accepted ? "This invitation has already been accepted. Sign in with an authorized account to open the Room."
      : preview.status === "expired" ? "This invitation has expired. Ask a current Room administrator for a new one."
        : preview.status === "revoked" ? "This invitation was revoked. Ask a current Room administrator if you still need access."
          : "The inviter’s authority changed. Ask a current Room administrator for a new invitation.";
  if (phase === "unknown") summary = "Acceptance has not been confirmed. Check the result before leaving this invitation.";
  if (phase === "preview-failed") summary = "Could not check this invitation.";
  $("#invitation-summary").textContent = summary;
  const mayAuthenticate = Boolean(preview && (pending || accepted));
  $("#invitation-account-form").hidden = !mayAuthenticate || (authenticated && !switchingAccount) || phase === "accepting" || phase === "opening";
  for (const control of $("#invitation-account-form").querySelectorAll("input, button")) control.disabled = loading;
  $("#invitation-account-hint").textContent = accepted
    ? "Use an account key with membership in this room."
    : "Use your own account key to accept this membership.";
  $("#invitation-account-form button").textContent = accepted ? "Sign in to open room" : "Sign in to review acceptance";
  $("#invitation-account-warning").hidden = !state;
  const action = $("#invitation-accept");
  action.hidden = !(authenticated && (pending || accepted) && !switchingAccount);
  action.disabled = loading;
  action.textContent = accepted ? "Open room" : phase === "unknown" ? "Check acceptance again" : "Accept and open room";
  $("#invitation-dismiss").disabled = invitationIsCommitting();
}
function closeInvitation({ returnFocus = true } = {}) {
  if (invitationIsCommitting()) return;
  if (invitation.phase === "unknown" && !window.confirm("Acceptance may already have completed. Closing clears this tab’s retry information. To check later, reopen the original invitation link and sign in with the same account. Close anyway?")) {
    $("#invitation-accept").focus({ preventScroll: false });
    return;
  }
  const opener = invitation.opener;
  invitation.version += 1;
  const selection = invitation.openerSelection;
  Object.assign(invitation, { phase: "idle", secret: null, preview: null, redemptionId: null, opener: null, openerSelection: null });
  setInvitationFeedback("");
  $("#invitation-account-form").reset();
  if ($("#invitation-dialog").open) $("#invitation-dialog").close();
  $("#connection-status").setAttribute("aria-live", "polite");
  if (returnFocus) queueMicrotask(() => {
    const usable = node => node?.isConnected && !node.disabled && !node.hidden && node.getClientRects().length > 0;
    const fallback = state ? $("#message-input") : $("#access-key");
    const target = usable(opener) ? opener : fallback;
    target?.focus({ preventScroll: true });
    const retainedSelection = selection || (target === $("#message-input") ? lastComposerSelection : null);
    if (retainedSelection && typeof target?.setSelectionRange === "function" && target.value === retainedSelection.value) {
      target.setSelectionRange(retainedSelection.start, retainedSelection.end, retainedSelection.direction);
    }
  });
}
async function openInvitation(fragment) {
  // A newly opened fragment must not replace the owner of an in-flight account change.
  if (invitationIsCommitting()) return;
  if (invitation.phase === "unknown" && $("#invitation-dialog").open) {
    setInvitationFeedback("Check the current acceptance result or close it explicitly before reviewing another invitation.", true);
    return;
  }
  invitation.version += 1;
  const active = document.activeElement === document.body ? null : document.activeElement;
  const composer = $("#message-input");
  const selectedComposer = state && lastComposerSelection?.value === composer.value ? composer : null;
  const opener = selectedComposer || (lastInvitationOpener?.isConnected ? lastInvitationOpener : active);
  const liveSelection = opener && typeof opener.selectionStart === "number"
    ? { value: opener.value, start: opener.selectionStart, end: opener.selectionEnd, direction: opener.selectionDirection }
    : null;
  // Some browsers collapse a textarea selection as the hash changes, before the
  // hashchange handler runs. Retain the last non-collapsed user selection for this
  // exact composer value; user input/pointer/keyboard events clear stale captures.
  const openerSelection = opener === $("#message-input") && liveSelection?.start === liveSelection?.end
    && lastComposerSelection?.value === opener.value ? lastComposerSelection : liveSelection;
  Object.assign(invitation, {
    phase: fragment.valid ? "previewing" : "terminal",
    secret: fragment.secret,
    preview: null,
    redemptionId: null,
    opener,
    openerSelection
  });
  setInvitationFeedback(fragment.valid ? "Checking the invitation without joining the Room…" : "This invitation link is unavailable.", !fragment.valid);
  renderInvitation();
  $("#connection-status").setAttribute("aria-live", "off");
  if (!$("#invitation-dialog").open) $("#invitation-dialog").showModal();
  queueMicrotask(() => $("#invitation-title").focus({ preventScroll: true }));
  if (!fragment.valid) return;
  await previewCurrentInvitation();
}
async function previewCurrentInvitation() {
  const { version, secret } = invitation;
  const retryHadFocus = document.activeElement === $("#invitation-retry");
  invitation.phase = "previewing";
  setInvitationFeedback("Checking the invitation…");
  renderInvitation();
  try {
    const [preview] = await Promise.all([
      accountClient.previewInvitation(secret),
      ensureAccountSession().catch(() => null)
    ]);
    if (!currentInvitation(version, secret)) return;
    invitation.preview = preview;
    invitation.phase = ["pending", "accepted"].includes(preview.status)
      ? (accountClient.session?.authenticated ? "ready" : "needs-account") : "terminal";
    setInvitationFeedback(preview.status === "pending"
      ? (accountClient.session?.authenticated ? "Review the exact scope, then accept only if it is right." : "Sign in with the separately provisioned account key to continue.")
      : preview.status === "accepted" ? "This invitation has already been accepted. Sign in with an authorized account to open the Room."
        : preview.status === "expired" ? "This invitation has expired. Ask a current Room administrator for a new one."
          : preview.status === "revoked" ? "This invitation was revoked. Ask a current Room administrator if you still need access."
            : "The inviter’s authority changed. Ask a current Room administrator for a new invitation.", invitation.phase === "terminal");
    renderInvitation();
    if (retryHadFocus && [document.body, $("#invitation-retry")].includes(document.activeElement)) {
      const target = invitation.phase === "needs-account" ? "#invitation-account-key"
        : invitation.phase === "ready" ? "#invitation-accept" : "#invitation-title";
      $(target).focus({ preventScroll: true });
    }
  } catch (error) {
    if (!currentInvitation(version, secret)) return;
    invitation.phase = canRetryInvitation(error) ? "preview-failed" : "terminal";
    setInvitationFeedback(invitation.phase === "preview-failed" ? "Connection interrupted. Try again."
      : "This invitation is unavailable. It may be invalid, expired, revoked, or no longer authorized.", true);
    renderInvitation();
  }
}
async function moveCurrentRoomToAccount(loggedIn) {
  if (!state || !session) return;
  const roomId = session.roomId;
  const sameAccount = session.account?.id === loggedIn.account.id && session.account?.authEpoch === loggedIn.account.authEpoch;
  if (!sameAccount) {
    accessEndContext = "account-switch";
    client.endAccess();
    return;
  }
  try {
    const restored = await client.restore(roomId);
    if (!restored) throw new Error("The browser account changed while the Room was reopening");
  } catch (error) {
    accessEndContext = "account-switch";
    client.endAccess();
    throw error;
  }
}
async function openAcceptedRoom(roomId, message, { acceptanceConfirmed = true } = {}) {
  invitation.phase = "opening";
  invitation.secret = null;
  renderInvitation();
  setInvitationFeedback("");
  $("#invitation-dialog").close();
  $("#connection-status").setAttribute("aria-live", "polite");
  $("#invitation-account-form").reset();
  accessEndContext = acceptanceConfirmed ? "accepted-room-switch" : "invited-room-switch";
  client.endAccess();
  history.replaceState(history.state, "", `${location.pathname}?room=${encodeURIComponent(roomId)}`);
  configureAuthPanel(roomId);
  try {
    const restored = await client.restore(roomId);
    if (!restored) throw new Error("The browser account changed before the Room could open");
    inboxUI.showRooms();
    Object.assign(invitation, { phase: "idle", preview: null, redemptionId: null, opener: null, openerSelection: null });
    notice(message);
    queueMicrotask(() => $("#conversation-title").focus({ preventScroll: true }));
  } catch (error) {
    Object.assign(invitation, { phase: "terminal", preview: null, redemptionId: null, opener: null, openerSelection: null });
    setFormStatus($("#auth-error"), acceptanceConfirmed
      ? "Your membership was accepted, but the conversation could not be loaded. Refresh or sign in with the same account; do not accept the invitation again."
      : [401, 403].includes(error.status) ? "This account could not open the invited Room. Sign in with the account that accepted the invitation."
        : "This invitation was already accepted, but the Room could not be loaded. Refresh to try again; no new acceptance is needed.", true);
    setConnectionStatus(acceptanceConfirmed ? "Membership accepted · conversation not loaded" : "Invitation already accepted · Room not loaded");
    $("#auth-panel").hidden = false;
    queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
  }
}
function selectOptions(selector, members, blank) {
  const select = $(selector), previous = select.value;
  const signature = JSON.stringify(members.map(m => [m.id, m.displayName]));
  if (select.dataset.signature === signature) return;
  select.innerHTML = `<option value="">${esc(blank)}</option>${members.map(m => `<option value="${esc(m.id)}">${esc(memberLabel(m.id))} · ${esc(kindLabel(m.kind))}</option>`).join("")}`;
  if (previous && !members.some(m => m.id === previous)) select.insertAdjacentHTML("beforeend", `<option value="${esc(previous)}" disabled>Previously selected member unavailable — choose again</option>`);
  if (previous) select.value = previous;
  select.dataset.signature = signature;
}
function syncWorkForm() {
  if (!state || busy) return;
  setWorkRetry(workRetryLocked);
  if (workRetryLocked) {
    if ($("#work-dialog").open && [document.body, $("#new-work-form button[type='submit']")].includes(document.activeElement)) $("#retry-work-button").focus();
    return;
  }
  const active = Object.values(state.members).filter(member => member.active !== false);
  const writing = $("#work-mode-select").value === "write";
  const reviewing = $("#require-verification").checked;
  selectOptions("#assignee-select", active.filter(member => ["accept_work", "complete_work", ...(writing ? ["write_external"] : [])]
    .every(permission => member.permissions.includes(permission))), "Choose owner");
  const reviewers = active.filter(member => member.permissions.includes("verify") && member.id !== $("#assignee-select").value);
  selectOptions("#verifier-select", reviewers, "Choose reviewer");
  $("#reviewer-unavailable").hidden = !reviewing || !$("#assignee-select").value || reviewers.length > 0;
  $("#verifier-field").hidden = !reviewing;
  $("#verifier-select").disabled = !reviewing;
  $("#verifier-select").required = reviewing;
  const checks = [reviewing && "Review", $("#require-decision").checked && "approval"].filter(Boolean);
  $("#work-options-summary").textContent = `${checks.join(" + ") || "Evidence only"} · ${writing ? "external write" : "read only"}`;
  for (const id of ["assignee-select", "verifier-select"]) {
    const select = $(`#${id}`);
    select.setCustomValidity(!select.disabled && select.selectedOptions[0]?.disabled ? "This member is no longer eligible. Choose another member." : "");
  }
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
function renderContent(selector, html) {
  const container = $(selector);
  if (container._content === html) return;
  const saved = captureDisclosures(container);
  container.innerHTML = html; container._content = html;
  restoreDisclosures(container, saved);
}
function render() {
  conversation = conversationIndex(state.messages);
  const members = Object.values(state.members), active = members.filter(m => m.active !== false);
  selectOptions("#message-to-select", active, "Everyone");
  syncWorkForm();
  syncActionForm();
  setText("#presence-count", `${active.length} ${active.length === 1 ? "member" : "members"}`);
  renderContent("#member-stack", active.slice(0, 4).map(m => `<div class="member-avatar ${m.kind}" title="${esc(memberLabel(m.id))}" aria-hidden="true"><span>${initials(m.displayName)}</span></div>`).join(""));
  const presenceRow = m => `<div id="${recordDomId("member", m.id)}" class="presence-member" tabindex="-1" data-member-record-id="${esc(m.id)}" data-disclosure-host="${esc(m.id)}" data-focus-key="member:${esc(m.id)}" ${m.active === false ? "" : `title="${esc(`Address ${m.displayName} in chat`)}"`}><div class="member-avatar ${m.kind}" aria-hidden="true"><span>${initials(m.displayName)}</span></div><div><strong>${esc(memberLabel(m.id))}</strong><span>${esc(memberStatus(m))}</span><details><summary data-focus-key="member-capabilities:${esc(m.id)}">Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p></details></div></div>`;
  const byPresence = (a, b) => (a.active === false) - (b.active === false) || a.displayName.localeCompare(b.displayName);
  const people = members.filter(m => m.kind !== "agent").sort(byPresence);
  const agents = members.filter(m => m.kind === "agent").sort(byPresence);
  renderContent("#presence-list", `${people.length ? `<p class="presence-heading">People</p>${people.map(presenceRow).join("")}` : ""}${agents.length ? `<p class="presence-heading">Agents</p>${agents.map(presenceRow).join("")}` : ""}`);
  for (const id of ["new-work-button", "composer-work-button"]) {
    $("#" + id).hidden = !can("steer"); $("#" + id).disabled = !can("steer");
  }
  const items = Object.values(state.workItems);
  const openWork = items.map(item => nextWorkStep(item)).filter(step => !["complete", "superseded"].includes(step.action));
  const waiting = openWork.filter(step => step.needsAttention && step.memberId === session?.member?.id).length;
  setText("#room-work-count", openWork.length ? `(${openWork.length})` : "");
  setText("#room-attention-count", waiting ? `(${waiting} need you)` : "");
  renderMessages();
  syncRequestComposer();
  $("#event-count").textContent = `${client.sequence}`;
  renderReturnBrief();
  renderContent("#event-list", [...state.eventLog].reverse().map(e => `<li id="${recordDomId("event", e.id)}" tabindex="-1" data-event-record-id="${esc(e.id)}" data-focus-key="event:${esc(e.id)}"><span>${esc(humanize(e.type))}</span><strong>${esc(memberLabel(e.actorId))}</strong><time datetime="${esc(e.at)}">${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join(""));
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
  const focusedFeedback = focused?.closest(".draft-feedback");
  const focusedMessage = focused?.matches(".message");
  const newMessages = sameView ? messages.filter(m => !previous.has(m.id)) : [];
  const newCount = newMessages.length;
  if (!sameView || nearBottom) unreadAnchorId = null;
  else if (!unreadAnchorId && newMessages[0]) unreadAnchorId = newMessages[0].id;
  const pendingOutgoingId = pendingMessage?.command?.data?.messageId || pendingMessage?.command?.id;
  const announceCount = newMessages.filter(message => message.id !== pendingOutgoingId && !locallyOwnedMessageIds.has(message.id)).length;
  newMessages.forEach(message => locallyOwnedMessageIds.delete(message.id));
  setText("#message-count", `${state.messages.length} ${state.messages.length === 1 ? "message" : "messages"}`);
  $("#thread-bar").hidden = !currentThreadId;
  $("#composer-label").textContent = currentThreadId ? "Reply in this thread" : "Message the room";
  if (currentThreadId) {
    const root = conversation.byId.get(currentThreadId);
    $("#thread-title").textContent = `Thread with ${name(root.authorId)}`;
    setText("#thread-context", `${messages.length - 1} ${messages.length === 2 ? "reply" : "replies"} · visible to everyone in this room`);
  }

  // Retain unchanged message nodes so new arrivals do not discard text selection or focus.
  const keep = new Set(messages.map(m => m.id));
  for (const [id, node] of previous) if (!keep.has(id)) node.remove();
  messages.forEach((message, index) => {
    const node = previous.get(message.id) || document.createElement("li");
    const cluster = messageCluster(messages, index);
    node.id = recordDomId("message", message.id); node.dataset.key = message.id; node.dataset.messageRecordId = message.id;
    node.className = `message${cluster.grouped ? " grouped" : ""}`; node.tabIndex = -1;
    const html = messageContent(message, cluster, message.id === unreadAnchorId);
    if (node._content !== html) {
      if (!node._content || !node.querySelector(".message-body")) node.innerHTML = html;
      else {
        const next = document.createElement("div"); next.innerHTML = html;
        // Reply counts/reactions change independently; the selected message text stays put.
        for (const selector of [".chat-divider", ".message-avatar", ".message-meta", ".message-body", ".message-context", ".reactions", ".message-links", ".draft-feedback"]) {
          const before = node.querySelector(selector), after = next.querySelector(selector);
          if (!before && !after) continue;
          if (!before) { node.insertBefore(after, node.firstChild); continue; }
          if (!after) { before.remove(); continue; }
          if (before.innerHTML !== after.innerHTML) {
            if (selector === ".draft-feedback") {
              // Feedback changes without replacing the selected text or its controls.
              const label = before.querySelector(".draft-state"), nextLabel = after.querySelector(".draft-state");
              if (label && nextLabel) {
                if (label.textContent !== nextLabel.textContent) label.textContent = nextLabel.textContent;
                const detail = before.querySelector("details"), nextDetail = after.querySelector("details");
                if (detail && nextDetail) {
                  if (detail.querySelector("p").textContent !== nextDetail.querySelector("p").textContent)
                    detail.querySelector("p").textContent = nextDetail.querySelector("p").textContent;
                } else if (detail) detail.remove();
                else if (nextDetail) before.append(nextDetail);
                continue;
              }
            }
            before.innerHTML = after.innerHTML;
          }
        }
      }
      node._content = html;
    }
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  if (!messages.length) list.innerHTML = `<li class="empty-note">No messages yet. <button type="button" class="text-button" data-empty-write>Write the first one</button>${can("manage_members") ? ' · <button type="button" class="text-button" data-empty-invite>Invite someone</button>' : ""}</li>`;
  list.dataset.view = view;
  if (!sameView) { list.scrollTop = viewPositions.get(view) ?? list.scrollHeight; newVisibleMessages = 0; }
  else if (nearBottom && !focused) { list.scrollTop = list.scrollHeight; newVisibleMessages = 0; }
  else {
    if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
    newVisibleMessages += newCount;
  }
  if (focused && !focused.isConnected) {
    const row = [...list.children].find(e => e.dataset.key === focusKey);
    const replacement = focusedMessage ? row : focusedFeedback ? row?.querySelector(".draft-state")
      : [...(row?.querySelectorAll("[data-message-action]") || [])].find(e => e.dataset.messageAction === focusAction && e.dataset.reaction === focusReaction);
    replacement?.focus({ preventScroll: true });
  }
  $("#new-messages-button").hidden = newVisibleMessages === 0;
  $("#new-messages-button").textContent = `${newVisibleMessages} new ${newVisibleMessages === 1 ? "message" : "messages"} · jump to latest`;
  if (announceCount) $("#conversation-announcement").textContent = `${announceCount} new ${announceCount === 1 ? "message" : "messages"} in ${currentThreadId ? "this thread" : "the room"}. Room event ${client.sequence}.`;
}
function draftFeedbackHTML(message) {
  if (!message.proposal) return "";
  const feedback = draftFeedback(state.workItems[message.workItemId], message);
  const label = feedback?.label ?? "Draft";
return `<p class="form-hint"><a class="source-link draft-state" href="${esc(workHref(message.workItemId))}" data-open-work="${esc(message.workItemId)}">${esc(label)}</a> · based on revision ${esc(message.proposal.basisRevision)}${message.proposal.basisRevision < message.proposal.submittedAtRevision ? " · older work" : ""} · authorship unverified · <button type="button" class="message-to-work" data-portable-work="${esc(message.workItemId)}" data-portable-mode="draft" data-portable-original="${esc(message.id)}" data-focus-key="refine:${esc(message.id)}">Refine draft</button></p>${feedback?.reason ? `<details><summary>Feedback</summary><p>${esc(feedback.reason)}</p></details>` : ""}`;
}
function messageContent(m, cluster = {}, unreadStart = false) {
  const author = state.members[m.authorId];
  const authorLabel = displayName(m.authorId);
  const divider = unreadStart || cluster.dayStart
    ? `<div class="chat-divider${unreadStart ? " unread" : ""}" role="separator">${esc([unreadStart ? "New messages" : "", cluster.dayStart ? cluster.dayLabel : ""].filter(Boolean).join(" · "))}</div>`
    : "";
  const linked = Object.values(state.workItems).filter(i => i.sourceMessageId === m.id || i.id === m.workItemId);
  const parent = conversation.byId.get(m.replyToId);
  const count = (conversation.threads.get(m.id)?.length || 1) - 1;
  const reactionSummary = Object.entries(REACTIONS).filter(([key]) => m.reactions?.[key]?.length)
    .map(([key, symbol]) => `${symbol} ${m.reactions[key].length}`).join(" · ") || "React";
  const reactionButtons = Object.entries(REACTIONS).map(([reaction, symbol]) => {
    const members = m.reactions?.[reaction] || [], selected = members.includes(session.member.id);
    const pending = pendingReactions.get(`${m.id}:${reaction}`);
    const label = `${pending && !pending.busy ? "Retry " : ""}${reaction}`;
    return `<button type="button" class="reaction" aria-pressed="${selected}" aria-label="${esc(label)} reaction, ${members.length}" title="${esc(members.map(name).join(", ") || `React with ${reaction}`)}" data-message-action="react" data-message-id="${esc(m.id)}" data-reaction="${reaction}"${pending?.busy ? " disabled" : ""}><span aria-hidden="true">${symbol}</span><span>${members.length || ""}</span>${pending && !pending.busy ? " Retry" : ""}</button>`;
  }).join("");
  return `${divider}<div class="message-avatar ${author.kind}" aria-hidden="true">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(authorLabel)}</strong>${author.kind === "agent" ? `<span>${esc(kindLabel(author.kind))}</span>` : ""}<a class="message-time" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" aria-label="Link to message by ${esc(authorLabel)} at ${esc(time(m.createdAt))}"><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a></div><div class="message-context">${m.toMemberId ? `<span class="audience-chip">To ${esc(name(m.toMemberId))} · room-visible</span>` : ""}${parent && parent.id !== currentThreadId ? `<a class="source-link reply-preview" href="${esc(recordHref("message", parent.id))}" data-open-message="${esc(parent.id)}">↳ ${esc(name(parent.authorId))}: ${esc(parent.body.slice(0,90))}</a>` : ""}</div><p class="message-body">${mentionHtml(m.body, Object.values(state.members), esc)}</p><div class="draft-feedback">${draftFeedbackHTML(m)}</div><details class="reactions"><summary data-message-action="reaction-menu" data-message-id="${esc(m.id)}" aria-label="Reactions to message by ${esc(authorLabel)}">${esc(reactionSummary)}</summary><div class="reaction-options">${reactionButtons}</div></details><div class="message-links">${requestControls(m)}${linked.map(i => `<a class="work-link" href="${esc(workHref(i.id))}" data-open-work="${esc(i.id)}">↳ ${esc(i.title)}</a>`).join("")}${m.workItemId && workActions(state.workItems[m.workItemId], state.members[session.member.id]).some(([action]) => action === "complete") ? `<button class="message-to-work" type="button" data-message-action="result" data-message-id="${esc(m.id)}">Save as result</button>` : ""}<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button">Reply</button>${!currentThreadId && count ? `<button class="thread-link" data-message-action="thread" data-message-id="${esc(m.id)}" type="button">${count} ${count === 1 ? "reply" : "replies"} ↗</button>` : ""}${can("steer") && !(m.proposal && m.workItemId) ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : ""}</div></div>`;
}
function renderSearch(now = Date.now()) {
  const query = $("#message-search").value;
  $("#clear-search").hidden = !query;
  $("#search-results").hidden = !query.trim();
  if (!query.trim()) { $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = ""; return; }
  const result = searchMessages(state, query), work = searchWork(state, query);
  const total = result.total + work.total, shown = result.messages.length + work.work.length;
  setText("#search-count", `${total} ${total === 1 ? "match" : "matches"}${total > shown ? ` · ${shown} shown` : ""} in this room`);
  const list = $("#search-list"), focused = list.contains(document.activeElement) ? document.activeElement.dataset.searchKey : null;
  const html = work.work.map(({ item, excerpt }) => `<li><a href="${esc(workHref(item.id))}" data-open-work="${esc(item.id)}" data-search-key="work:${esc(item.id)}"><strong>${esc(item.title)}</strong><span>${esc(excerpt)}</span><small>Work · ${esc(workStatus(item, now).label)}</small></a></li>`).join("")
    + result.messages.map(m => `<li><a href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" data-search-key="message:${esc(m.id)}"><strong>${esc(name(m.authorId))}</strong><span>${esc(m.body.slice(0, 240))}</span><small>${m.replyToId ? "Open thread at this reply" : "Open in room"}</small></a></li>`).join("") || '<li class="empty-note">No matches. Try a name or another phrase.</li>';
  if (list._content !== html) { list.innerHTML = html; list._content = html; }
  if (focused) ([...list.querySelectorAll("[data-search-key]")].find(e => e.dataset.searchKey === focused) || $("#message-search")).focus({ preventScroll: true });
}
function saveComposer() {
  drafts.save(composerKey(), { body: $("#message-input").value, toMemberId: $("#message-to-select").value, replyToId, pending: pendingMessage,
    ...(requestMode ? { mode: requestMode, threadId: currentThreadId } : {}) });
  persistDrafts();
}
function restoreComposer(draft) {
  $("#message-input").value = draft.body;
  const select = $("#message-to-select");
  if (draft.toMemberId && ![...select.options].some(option => option.value === draft.toMemberId)) {
    select.add(new Option("Previous recipient unavailable", draft.toMemberId));
    select.options[select.options.length - 1].disabled = true;
  }
  select.value = draft.toMemberId; replyToId = draft.replyToId; pendingMessage = draft.pending;
}
function requestControls(message) {
  const request = state.replyRequests?.[message.id];
  if (!request) return "";
  const own = session.member.id, open = request.status === "open";
  const status = open ? state.members[request.recipientId]?.active === false ? "Recipient unavailable" : "Reply requested"
    : ({ answered: "Answered", declined: "Declined", cancelled: "Cancelled" })[request.status];
  const actions = [];
  if (open && own === request.recipientId) actions.push(["answered", "Answer"], ["declined", "Decline"]);
  if (open && (own === request.requesterId || own === state.room.ownerId && session.member.kind === "human")) actions.push(["cancelled", "Cancel request"]);
  return `<span class="request-state">${esc(status)}</span>${actions.map(([kind, label]) =>
    `<button type="button" class="message-to-work" data-message-id="${esc(message.id)}" data-message-action="request-${kind}">${label}</button>`).join("")}`;
}
function syncRequestComposer() {
  const mode = requestMode, active = Boolean(mode) || requestReading;
  $("#request-mode-bar").hidden = !active;
  $("#request-reply").hidden = !state || active;
  const request = mode?.requestMessageId && state?.replyRequests?.[mode.requestMessageId];
  const changed = request && (request.revision !== mode.expectedRequestRevision || request.contextEventId !== mode.contextEventId);
  const label = mode?.resultEventId ? "Ask about credit" : mode ? ({ request: "Request a reply", answered: "Answer", declined: "Decline", cancelled: "Cancel request" })[mode.kind] : "";
  const work = mode?.resultEventId && state?.workItems[mode.workItemId];
  const subject = work ? work.title + (work.receipt?.eventId !== mode.resultEventId ? " · Earlier result" : "")
    : request ? conversation?.byId.get(request.id)?.body.slice(0, 80) : "";
  setText("#request-mode-label", requestReading ? "Reading request…" : [label, subject, pendingMessage ? "Retry original" : changed ? "Context changed" : ""].filter(Boolean).join(" · "));
  $("#request-refresh").hidden = !request || Boolean(pendingMessage) || requestReading || request.status !== "open";
  $("#request-exit").disabled = busy;
  const input = $("#message-input"), select = $("#message-to-select"), send = $("#message-form button[type=submit]");
  input.readOnly = Boolean(mode && pendingMessage);
  input.disabled = busy || requestReading;
  select.disabled = busy || requestReading || Boolean(mode && (mode.kind !== "request" || pendingMessage));
  select.required = mode?.kind === "request";
  select.setCustomValidity(mode?.kind === "request" && (!select.value || select.value === session?.member.id) ? "Choose another participant." : "");
  send.disabled = busy || requestReading || Boolean(request && request.status !== "open" && !pendingMessage);
  const action = pendingMessage && mode ? "Retry original" : mode ? mode.kind === "request" ? "Send request" : label : "Send";
  send.setAttribute("aria-label", action); send.title = action;
  input.placeholder = mode?.kind === "request" ? "What do you need?" : mode?.kind === "cancelled" ? "Reason…" : mode ? "Your reply…" : "Message…";
  if (active) $("#reply-bar").hidden = true;
}
function setRequestMode(mode, initial = {}) {
  saveComposer(); requestMode = mode;
  const key = composerKey();
  if (!drafts.entries.has(key)) drafts.save(key, { body: "", toMemberId: mode.requesterId ?? "", replyToId: mode.requestMessageId ?? currentThreadId, ...initial, pending: null, mode, threadId: currentThreadId });
  else drafts.save(key, { mode });
  restoreComposer(drafts.get(key));
  syncRequestComposer(); renderComposerError(); persistDrafts();
  $("#message-input").focus();
}
async function openRequestMode(kind, id) {
  if (!state || busy || requestReading || requestMode?.requestMessageId === id && pendingMessage) return;
  const generation = client.generation, identity = session, epoch = ++requestEpoch;
  const current = () => generation === client.generation && session === identity && epoch === requestEpoch && state;
  requestReading = true; syncRequestComposer();
  try {
    const selected = await client.replyContext(id);
    if (!current()) return;
    await client.refresh();
    if (!current()) return;
    const request = state.replyRequests?.[id], basis = selected.current;
    if (!request || request.status !== "open" || selected.request.revision !== request.revision
      || selected.request.contextEventId !== request.contextEventId) throw new Error("Request changed. Open it again");
    if (kind === "cancelled" ? !basis?.actions?.cancel : !basis?.answerBasis || !basis.actions[kind === "answered" ? "answer" : "decline"])
      throw new Error("This action is unavailable");
    if (basis.contextEventId !== request.contextEventId || kind !== "cancelled" &&
      (basis.answerBasis.expectedRequestRevision !== request.revision || basis.answerBasis.contextEventId !== basis.contextEventId
        || basis.answerBasis.contextSequence !== basis.contextSequence)) throw new Error("Request context could not be confirmed");
    const mode = { kind, requestMessageId: id, expectedRequestRevision: request.revision,
      requesterId: request.requesterId, workItemId: request.workItemId,
      contextEventId: basis.contextEventId, contextSequence: basis.contextSequence };
    if (!validReplyDraft(mode, state)) throw new Error("Request context could not be confirmed");
    requestReading = false;
    if (currentThreadId !== conversation.rootById.get(id)) switchThread(conversation.rootById.get(id));
    setRequestMode(mode);
  } catch (error) {
    if (current()) { client.handleFailure(error); if (state) setComposerError(`${error.message}. Draft kept.`); }
  } finally {
    if (epoch === requestEpoch) { requestReading = false; syncRequestComposer(); }
  }
}
$("#request-reply").addEventListener("click", () => { if (!state || busy || requestReading) return; setRequestMode({ kind: "request" }); });
document.addEventListener("click", event => {
  const resume = event.target.closest("[data-resume-credit]");
  if (resume && state && !busy && !requestReading) {
    const saved = drafts.entries.get(resume.dataset.resumeCredit);
    if (!saved?.mode?.resultEventId || !validReplyDraft(saved.mode, state)) return;
    inboxUI?.showRooms(); switchThread(saved.threadId); setRequestMode(saved.mode);
    $("#message-input").scrollIntoView({ block: "nearest", behavior: "instant" }); return;
  }
  const button = event.target.closest("[data-ask-credit]");
  if (!button || !state || busy || requestReading) return;
  const question = creditQuestion(state, button.dataset.askCredit, session.member.id, button.dataset.resultEvent);
  if (!question) { notice("Result changed. Open it again."); return; }
  inboxUI?.showRooms();
  switchThread(question.replyToId ? conversation.rootById.get(question.replyToId) : null);
  setRequestMode(question.mode, question);
  $("#message-input").scrollIntoView({ block: "nearest", behavior: "instant" });
});
$("#request-exit").addEventListener("click", () => switchThread(currentThreadId, true));
$("#request-refresh").addEventListener("click", () => { if (requestMode?.requestMessageId) openRequestMode(requestMode.kind, requestMode.requestMessageId); });
function persistDrafts() {
  if (!session || !$("#remember-drafts").checked) return;
  const saved = recovery.write(draftScope(session), drafts, currentThreadId, composerKey());
  setText("#draft-recovery-status", saved ? "Draft recovery enabled in this tab for 12 hours. Sign-out clears it." : "Draft recovery unavailable. Keep this page open to retain unsent text.");
}
function switchThread(threadId, focusComposer = false) {
  if (!state || busy || (threadId && !conversation.threads.has(threadId))) return;
  const leavingResultQuestion = Boolean(requestMode?.resultEventId);
  requestEpoch++; requestReading = false;
  if (threadId !== currentThreadId || requestMode) {
    saveComposer(); viewPositions.set(currentThreadId ? `thread:${currentThreadId}` : "room", $("#message-list").scrollTop);
    currentThreadId = threadId; requestMode = null;
    const draft = drafts.get(threadId);
    $("#message-input").value = draft.body;
    const select = $("#message-to-select");
    if (draft.toMemberId && ![...select.options].some(o => o.value === draft.toMemberId)) {
      select.add(new Option("Previous recipient unavailable — choose again", draft.toMemberId));
      select.options[select.options.length - 1].disabled = true;
    }
    select.value = draft.toMemberId; replyToId = draft.replyToId; pendingMessage = draft.pending;
  }
  updateReply(); renderMessages(); renderComposerError(); syncRequestComposer();
  if (leavingResultQuestion) renderReturnBrief();
  if (focusComposer) $("#message-input").focus();
  else (currentThreadId ? $("#thread-title") : $("#conversation-title")).focus({ preventScroll: true });
}
function revealMessage(id) {
  if (!state || busy || !conversation.byId.has(id)) return;
  inboxUI?.showRooms();
  const message = conversation.byId.get(id);
  switchThread(message.replyToId ? conversation.rootById.get(id) : null);
  const row = [...$("#message-list").querySelectorAll("[data-message-record-id]")]
    .find(node => node.dataset.messageRecordId === id);
  row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest", behavior: "instant" });
  // Nearest can leave a tall message clipped at its bottom. Align its beginning
  // inside the conversation without moving the surrounding page unnecessarily.
  const list = $("#message-list");
  if (row && row.offsetHeight > list.clientHeight) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
}
function focusRecord(node) {
  if (!node) return;
  if (node.closest("#work-list")) selectWorkView("work");
  inboxUI?.showRooms();
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function workRecord(id) {
  return [...$("#work-list").querySelectorAll("[data-work-record-id]")]
    .find(node => node.dataset.workRecordId === id) || null;
}
function revealWork(id) {
  if (!state?.workItems[id] || busy) return;
  selectWorkView("work");
  const card = workRecord(id);
  if (card) card.querySelector(".work-details").open = true;
  focusRecord(card);
}
function revealDrafts(id) {
  if (!state?.workItems[id] || busy) return;
  selectWorkView("work");
  const choices = workRecord(id)?.querySelector('.work-drafts');
  if (!choices) { revealWork(id); return; }
  inboxUI?.showRooms();
  choices.open = true;
  const summary = choices.querySelector('summary');
  summary.focus({ preventScroll: true });
  summary.scrollIntoView({ block: 'start', behavior: 'instant' });
}
function revealMember(id) {
  if (!state?.members[id] || busy) return;
  $("#people-panel").open = true;
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
  if (hash === "#pr-view/inbox") { inboxUI?.open(); return; }
  if (hash === "#pr-view/rooms") { inboxUI?.showRooms(); return; }
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
function readyForDecision(i) { return nextWorkStep(i).action === "decide"; }
function hasIndependentProducer(i) { return hasReportedProducer(i) && i.receipt.producerId !== i.verifierMemberId; }
function actions(i, scopeOnly = false, now = Date.now()) {
  return workActions(i, state.members[session.member.id], now).filter(([action]) => (action === "release") === scopeOnly).map(([action, label]) => `<button type="button" class="button secondary" data-action="${action}" data-work-id="${esc(i.id)}" data-focus-key="work-action:${esc(i.id)}:${action}"${busy ? " disabled" : ""}>${label}</button>`).join("");
}
function helpView(item, now = Date.now()) {
  try { return workHelpContext(state, item.id, session.member.id, new Date(now).toISOString()); }
  catch { return null; } // Invalid or unavailable context never advertises consent.
}
const isHelpAction = action => ["help", "end-help"].includes(action);
const offerStatuses = { "select-offer": "selected", "decline-offer": "declined", "withdraw-offer": "withdrawn", "release-offer": "released" };
const offerLabels = { "offer-help": "Offer help", "select-offer": "Select helper", "decline-offer": "Decline", "withdraw-offer": "Withdraw", "release-offer": "Release" };
const isOfferAction = action => Object.hasOwn(offerLabels, action);
function offersView(item, now = Date.now()) {
  if (offerContextVersion !== 1) return null;
  try { return workOffersContext(state, item.id, session.member.id, new Date(now).toISOString()); }
  catch { return null; }
}
function offerChoice(entry) {
  return offersView(state?.workItems[entry.workId] ?? {})?.offers.find(row => row.offer.id === entry.offerId) ?? null;
}
function pinOffer(entry, item, offerId = entry.offerId) {
  entry.offerId = offerId ?? crypto.randomUUID();
  entry.helpRevision = item.helpWanted?.revision ?? 0;
  entry.helpEventId = item.helpWanted?.eventId ?? null;
  entry.offerRevision = state.helpOffers?.[entry.offerId]?.revision ?? null;
  entry.viewerRevision = state.members[session.member.id]?.revision;
  entry.offererRevision = state.members[state.helpOffers?.[entry.offerId]?.offererId]?.revision ?? null;
}
const currentHelp = () => $("#action-fields").querySelector("#help-current");
const offerField = name => $("#action-fields").querySelector('[id="offer-' + name + '"]');
function helpButton(item, action, label, offerId = null) {
  return `<button type="button" class="button ghost" data-action="${action}" data-work-id="${esc(item.id)}"${offerId ? ` data-offer-id="${esc(offerId)}"` : ""} data-focus-key="work-action:${esc(item.id)}:${action}${offerId ? ":" + esc(offerId) : ""}"${busy ? " disabled" : ""}>${label}</button>`;
}
function helpCard(item, help) {
  const context = offersView(item), rows = context?.offers ?? [];
  const invitation = help?.help?.status === "open" && (help.status === "open" || help.canWithdraw);
  const retained = state.helpOffers && !Array.isArray(state.helpOffers) && Object.values(state.helpOffers).some(offer => offer?.workItemId === item.id);
  if (!invitation && !rows.length && !retained) return "";
  const live = rows.filter(row => ["offered", "selected"].includes(row.offer.status));
  const past = rows.filter(row => !["offered", "selected"].includes(row.offer.status));
  const selected = live.find(row => row.offer.status === "selected");
  const label = selected ? selected.status === "selection_needs_review" ? "Helper · review needed" : "Helper selected"
    : help?.status === "open" ? "Help wanted" : "Help ended";
  const rowHTML = row => {
    const offer = row.offer, label = { offered: "Offered", selected: "Selected", unavailable: "Request changed", selection_needs_review: "Review needed",
      withdrawn: "Withdrawn", declined: "Declined", released: "Released" }[row.status];
    const buttons = [["canSelect", "select-offer"], ["canDecline", "decline-offer"], ["canWithdraw", "withdraw-offer"], ["canRelease", "release-offer"]]
      .filter(([key]) => row[key]).map(([, action]) => helpButton(item, action, offerLabels[action], offer.id)).join("");
    const contribute = row.status === "selected" && offer.offererId === session.member.id ? shareDraftButton(item, offer.id) : "";
    return `<li class="help-offer" data-offer-record-id="${esc(offer.id)}"><div class="help-offer-heading"><strong>${esc(memberLabel(offer.offererId))}</strong><span class="form-hint">${label}</span></div><p>${esc(offer.plan)}</p>${offer.reason ? `<p class="form-hint">${esc(offer.reason)}</p>` : ""}${buttons || contribute ? `<div class="portable-actions">${contribute}${buttons}</div>` : ""}</li>`;
  };
  const capacity = context?.availability.reason;
  const capacityText = { work_offer_limit: "This request has enough offers for now.", member_offer_limit: "Finish an existing offer before adding another.", history_full: "Offer history is full." }[capacity];
  return `<details class="work-help"><summary data-focus-key="work-help:${esc(item.id)}">${label}${live.length && !selected ? ` <span class="form-hint">· ${live.length}</span>` : ""}</summary>
    ${invitation ? `<p class="definition">${esc(help.help.scope)}</p><p class="form-hint">Ends ${esc(new Date(help.help.expiresAt).toLocaleString())}</p>` : ""}
    ${selected ? '<p class="form-hint">Coordination only. Work and permissions stay unchanged.</p>' : ""}
    <div class="portable-actions">${context?.availability.canOffer ? helpButton(item, "offer-help", "Offer help") : ""}${help?.canPublish && invitation ? helpButton(item, "help", "Edit") : ""}${help?.canWithdraw ? helpButton(item, "end-help", "End request") : ""}</div>
    ${capacityText ? `<p class="form-hint">${capacityText}</p>` : ""}
    ${!context ? '<p class="form-hint">Offers unavailable.</p>' : ""}
    ${live.length ? `<ul class="help-offers">${[...live].sort((a, b) => Number(b.offer.status === "selected") - Number(a.offer.status === "selected")).map(rowHTML).join("")}</ul>` : ""}
    ${past.length ? `<details class="offer-history"><summary data-focus-key="offer-history:${esc(item.id)}">Past offers (${past.length})</summary><ul class="help-offers">${past.map(rowHTML).join("")}</ul></details>` : ""}</details>`;
}
function claimStateLabel(i, now = Date.now()) {
  if (activeClaim(i, now)) return "not expired";
  if (i.claim?.status === "superseded") return "superseded";
  if (i.claim?.status === "released") return "released";
  return "expired";
}
function receiptCard(i) {
  if (!i.receipt) return "";
  const receipt = i.receipt;
  const earlier = [...drafts.entries].filter(([, draft]) => draft.mode?.resultEventId && draft.mode.workItemId === i.id
    && draft.mode.resultEventId !== receipt.eventId && (draft.body.trim() || draft.pending) && validReplyDraft(draft.mode, state));
  const resume = earlier.map(([key], index) => `<button type="button" class="button ghost" data-resume-credit="${esc(key)}"
    data-focus-key="resume-credit:${esc(key)}"${busy ? " disabled" : ""}>Continue earlier question${earlier.length > 1 ? " " + (index + 1) : ""}</button>`).join("");
  const reporter = receipt.reportedById ? memberLabel(receipt.reportedById) : "Unknown reporter";
  const producer = receipt.producerAttribution === "reported" && receipt.producerId
    ? memberLabel(receipt.producerId)
    : receipt.producerAttribution === "external-reported" ? `${receipt.externalProducer} · outside room, reported`
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
  return `<div class="receipt"><p class="receipt-label">REPORTED COMPLETION · NOT AUTOMATIC VERIFICATION</p><dl class="receipt-attribution"><div><dt>Completion reporter</dt><dd>${esc(reporter)}</dd></div><div><dt>Producer</dt><dd>${esc(producer)}</dd></div></dl><p>${esc(receipt.summary)}</p>${receipt.nativeText ? "" : `<a href="${safeUrl(receipt.evidenceUrl)}" target="_blank" rel="noreferrer" data-focus-key="work-evidence:${esc(i.id)}">Open submitted evidence ↗</a>`}<code>${esc(receipt.evidenceVersion)}</code><p>${esc(receipt.nextAction)}</p>${verification}${receipt.producerAttribution !== "reported" ? `<button type="button" class="button ghost" data-ask-credit="${esc(i.id)}" data-result-event="${esc(receipt.eventId)}" data-focus-key="ask-credit:${esc(i.id)}"${busy ? " disabled" : ""}>Ask about credit</button>` : ""}${resume}</div>`;
}
function shareDraftButton(item, key = "task") {
  return `<button type="button" class="button secondary" data-portable-work="${esc(item.id)}" data-portable-mode="draft" data-focus-key="share-draft:${esc(item.id)}:${esc(key)}">Share draft</button>`;
}
function workCard(i, now, drafts) {
  const next = nextWorkStep(i, now), status = workStatus(i, now), help = helpView(i, now);
  const nextActor = next.memberId ? `${name(next.memberId)} — ` : "";
  const nextLine = `<p class="work-next-step" data-next-step="${esc(next.action)}"><strong>Next:</strong> ${esc(nextActor + status.next)}</p>`;
  const source = i.sourceMessageId ? `<a class="source-link" href="${esc(recordHref("message", i.sourceMessageId))}" data-open-message="${esc(i.sourceMessageId)}" data-focus-key="work-source:${esc(i.id)}">From this conversation</a>` : "";
  const blocker = i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : "";
  const decision = i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : "";
  const claim = i.claim ? `<details class="claim"><summary data-focus-key="work-claim:${esc(i.id)}">Recorded scope · ${esc(claimStateLabel(i, now))}</summary><p>${esc(memberLabel(i.claim.holderId))}</p><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p><p>Expires ${esc(i.claim.expiresAt)}. External activity is not measured.</p>${actions(i, true, now)}</details>` : "";
  const checks = `<div><dt>Verifier</dt><dd>${i.independentVerificationRequired ? esc(memberLabel(i.verifierMemberId)) : "Not required"}</dd></div><div><dt>Decision</dt><dd>${i.ownerDecisionRequired ? esc(memberLabel(i.humanDecisionMakerId)) : "Not required"}</dd></div>`;
  const updated = `<p class="form-hint">Last recorded update: ${esc(new Date(i.updatedAt).toLocaleString())}. Live execution is not measured.</p>`;
  const reuse = can("steer") ? `<button type="button" class="button ghost" data-reuse-work="${esc(i.id)}" data-focus-key="work-reuse:${esc(i.id)}">Use again</button>` : "";
  const latestDraft = drafts[0];
  const alternatives = drafts.length > 1 ? `<details class="work-drafts"><summary data-focus-key="work-drafts:${esc(i.id)}">Drafts (${drafts.length})</summary>${drafts.map(draft =>
`<p><a class="source-link" href="${esc(recordHref("message", draft.id))}" data-open-message="${esc(draft.id)}" data-focus-key="work-draft-message:${esc(draft.id)}">${esc(memberLabel(draft.authorId))} · ${esc(draftFeedback(i, draft)?.label ?? "Draft")}<br><span class="form-hint">${esc([...draft.body].slice(0, 100).join(""))}${[...draft.body].length > 100 ? "…" : ""}</span></a></p>`).join("")}</details>` : "";
  const draftLink = i.receipt?.nativeText ? `<button class="source-link" type="button" data-read-result="${esc(i.id)}" data-focus-key="work-native-result:${esc(i.id)}">View result</button>` + alternatives : alternatives || (latestDraft ? `<a class="source-link" href="${esc(recordHref("message", latestDraft.id))}" data-open-message="${esc(latestDraft.id)}" data-focus-key="work-draft:${esc(i.id)}">View latest draft</a>` : "");
  return `<article id="${workDomId(i.id)}" class="work-card" tabindex="-1" data-work-record-id="${esc(i.id)}" data-disclosure-host="${esc(i.id)}" data-focus-key="work:${esc(i.id)}"><div class="work-card-header"><span class="state state-${status.tone}">${esc(status.label)}</span></div><h3>${esc(i.title)}</h3>${nextLine}${draftLink}${helpCard(i, help)}<details class="work-details"><summary data-focus-key="work-details:${esc(i.id)}">${i.receipt ? "Evidence & details" : "Details"}</summary><span class="mode">${esc(i.mode)} · revision ${i.revision}</span>${source}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(memberLabel(i.accountableMemberId))}</dd></div>${checks}</dl>${updated}${receiptCard(i)}${blocker}${decision}${claim}<div class="portable-actions">${i.receipt ? `<button type="button" class="button secondary" data-copy-result="${esc(i.id)}" data-focus-key="work-copy-result:${esc(i.id)}">Copy summary</button>` : ""}${shareDraftButton(i)}${reuse}${help?.canPublish && help.help?.status !== "open" ? helpButton(i, "help", "Ask for help") : ""}${terminalWork(i) ? "" : `<button type="button" class="button ghost" data-reminder-work="${esc(i.id)}" data-focus-key="work-reminder:${esc(i.id)}">Remind me</button>`}<button type="button" class="button secondary" data-portable-work="${esc(i.id)}" data-focus-key="work-ai:${esc(i.id)}">Use my AI</button><button type="button" class="button ghost" data-portable-work="${esc(i.id)}" data-portable-mode="result" data-focus-key="work-result:${esc(i.id)}">Paste AI draft</button></div></details><div class="work-actions">${actions(i, false, now)}</div></article>`;
}
// Quiet Focus A4: a failed send reports beside the composer that holds the draft,
// not only in the page-level status area; the Send button is the retry and the
// draft clears only after the service acknowledges the retry.
function releaseSubmission(ticket, { restoreFocus = false } = {}) {
  if (!ticket) return;
  ticket.controls.forEach((control, index) => control.disabled = ticket.disabled[index]);
  ticket.form.removeAttribute("aria-busy");
  if (submitControls === ticket) submitControls = null;
  const target = ticket.focus;
  if (!restoreFocus || ticket.form.id !== "message-form" || !state || !target?.isConnected || target.disabled
    || target.closest("[hidden]") || !target.getClientRects().length || getComputedStyle(target).visibility === "hidden") return;
  if (document.activeElement !== document.body && document.activeElement !== target) return;
  if (document.activeElement !== target) target.focus({ preventScroll: true });
  if (document.activeElement === target && ticket.selection && target.value === ticket.selection.value
    && typeof target.setSelectionRange === "function") {
    const end = target.value.length;
    target.setSelectionRange(Math.min(ticket.selection.start, end), Math.min(ticket.selection.end, end), ticket.selection.direction);
  }
}
async function submit(form, fn, { failureHint } = {}) {
  if (busy) return;
  const operationId = ++submitOperationId;
  const focus = form.contains(document.activeElement) ? document.activeElement : null;
  const selection = focus && typeof focus.selectionStart === "number" ? {
    value: focus.value, start: focus.selectionStart, end: focus.selectionEnd, direction: focus.selectionDirection
  } : null;
  busy = true; const controls = [...form.querySelectorAll("button, input, select, textarea")];
  const disabled = controls.map(e => e.disabled);
  const generation = client.generation;
  const ticket = submitControls = { form, controls, disabled, focus, selection };
  const current = () => operationId === submitOperationId
    && (form.id === "auth-form" || generation === client.generation);
  form.setAttribute("aria-busy", "true"); controls.forEach(e => e.disabled = true);
  const local = form.querySelector(".form-status");
  if (form.id === "message-form") setComposerError("");
  else if (local) setFormStatus(local, "");
  try { await fn(current); }
  catch (error) {
    if (!current()) return;
    const text = `${error.message}. ${failureHint ?? (state ? "Your entries were kept; try again." : "Sign in again.")}`;
    // One live-announcement owner per send result: when the form has its own status region
    // it owns the announcement (the visible composer error); the page-level region stays
    // silent so a screen reader announces the failure exactly once.
    if (form.id === "message-form") { clearNotice(); setComposerError(text); }
    else if (local && (!state && local.id !== "auth-error")) clearNotice();
    else if (local) { clearNotice(); setFormStatus(local, text, true); }
    else notice(text, true);
  }
  finally {
    if (operationId !== submitOperationId) return;
    busy = false; releaseSubmission(ticket, { restoreFocus: true }); if (state) render();
  }
}
$("#invitation-dismiss").addEventListener("click", () => closeInvitation());
$("#invitation-retry").addEventListener("click", () => { if (invitation.phase === "preview-failed") previewCurrentInvitation(); });
for (const id of ["invitation-dialog", "work-dialog", "action-dialog", "result-dialog", "room-actions-dialog"]) $(`#${id}`).addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const controls = [...e.currentTarget.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])")]
    .filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1), active = document.activeElement;
  if (!first || !controls.includes(active) || (e.shiftKey ? active === first : active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first)?.focus();
    if (!first) (id === "invitation-dialog" ? $("#invitation-title") : e.currentTarget).focus();
  }
});
$("#invitation-dialog").addEventListener("cancel", e => {
  e.preventDefault();
  closeInvitation();
});
$("#invitation-account-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!invitation.secret || !invitation.preview || invitationIsCommitting() || invitation.phase === "terminal") return;
  const version = invitation.version, secret = invitation.secret;
  const accessKey = $("#invitation-account-key").value.trim();
  const roomBefore = state && session ? session : null, accountBefore = accountClient.session;
  const privateDraft = inboxUI?.hasPending();
  if (roomBefore || privateDraft) {
    if (roomBefore) saveComposer();
    if ((privateDraft || drafts.hasText() || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending() || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || !$("#new-work-form").hidden || pendingAction)
      && !window.confirm(privateDraft ? "Switching accounts clears unsent private drafts and local retries. Unconfirmed actions may already be saved. Continue?"
        : (pendingAction?.uncertain || instructionsUI?.hasUnknown()) ? "Switch accounts and clear drafts and the pending retry? The action may already be saved." : "Signing in with a different account clears this Room’s unsent drafts, private setup and forms before acceptance. Continue with this account key?")) return;
  }
  if (roomBefore) { saveComposer(); client.disconnect(); }
  invitation.phase = "authenticating";
  setInvitationFeedback("Confirming the account. This does not accept the invitation…");
  renderInvitation();
  try {
    await ensureAccountSession();
    if (!currentInvitation(version, secret)) return;
    const loggedIn = await accountClient.login(accessKey);
    if (!currentInvitation(version, secret)) return;
    if (!loggedIn?.authenticated || !loggedIn.account) {
      accessEndContext = "account-switch";
      if (state) client.endAccess();
      else { clearPrivateWorkspace(); if (accountClient.session?.authenticated) showAccountWorkspace(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("The browser account changed before sign-in could be confirmed. Sign in again to continue safely.", true);
      renderInvitation();
      return;
    }
    $("#invitation-account-key").value = "";
    await moveCurrentRoomToAccount(loggedIn);
    if (!roomBefore) { clearPrivateWorkspace(); showAccountWorkspace(); }
    if (!currentInvitation(version, secret)) return;
    invitation.phase = "ready";
    setInvitationFeedback(invitation.preview.status === "accepted"
      ? "Account confirmed. Open the Room only if this is the membership you expected."
      : "Account confirmed. Review the exact scope before accepting.");
    renderInvitation();
    $("#invitation-accept").focus({ preventScroll: true });
  } catch (error) {
    if (!currentInvitation(version, secret)) return;
    if (!roomBefore && accountClient.session !== accountBefore) {
      clearPrivateWorkspace();
      if (accountClient.session?.authenticated) showAccountWorkspace();
    }
    if (Number.isSafeInteger(error.status) && roomBefore && client.session === roomBefore) client.connect();
    else if (roomBefore && state) {
      accessEndContext = "account-switch";
      client.endAccess();
    }
    invitation.phase = accountClient.session?.authenticated ? "ready" : "needs-account";
    setInvitationFeedback(Number.isSafeInteger(error.status)
      ? `${error.message}. The invitation was not accepted.`
      : "Account sign-in could not be confirmed. The invitation was not accepted; restore the connection and try again.", true);
    renderInvitation();
  }
});
$("#invitation-accept").addEventListener("click", async () => {
  const preview = invitation.preview;
  const accountSession = accountClient.session;
  if (!invitation.secret || !preview || !accountSession?.authenticated || !accountSession.account || invitationIsCommitting() || invitation.phase === "terminal") return;
  const version = invitation.version, secret = invitation.secret;
  if (preview.status === "accepted") {
    invitation.phase = "opening";
    setInvitationFeedback("Confirming this browser account before opening the Room…");
    renderInvitation();
    if (state) client.disconnect();
    try {
      const fresh = await accountClient.restore();
      if (!currentInvitation(version, secret)) return;
      if (!sameAccountTuple(accountSession, fresh)) {
        if (state) { accessEndContext = "account-switch"; client.endAccess(); }
        invitation.phase = "changed-account";
        setInvitationFeedback("The browser account changed. Sign in with the account that accepted this invitation.", true);
        renderInvitation();
        return;
      }
      await openAcceptedRoom(preview.roomId, "Room opened with your current membership.", { acceptanceConfirmed: false });
    } catch (error) {
      if (!currentInvitation(version, secret)) return;
      if (state) { accessEndContext = "account-switch"; client.endAccess(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("The browser account could not be confirmed. Sign in again before opening the Room.", true);
      renderInvitation();
    }
    return;
  }
  if (preview.status !== "pending") return;
  invitation.redemptionId ||= crypto.randomUUID();
  const redemptionId = invitation.redemptionId;
  invitation.phase = "accepting";
  setInvitationFeedback("Accepting the exact membership scope…");
  renderInvitation();
  let receipt = null;
  try {
    receipt = await accountClient.acceptInvitation({ invitationToken: secret, redemptionId, expectedRevision: preview.revision });
    if (!currentInvitation(version, secret)) return;
    if (!receipt) {
      if (state) { accessEndContext = "account-switch"; client.endAccess(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("We could not safely attribute the response because the browser account changed. Sign in again to reconcile this invitation.", true);
      renderInvitation();
      return;
    }
    if (state) client.disconnect();
    const fresh = await accountClient.restore();
    if (!currentInvitation(version, secret)) return;
    if (!sameAccountTuple(accountSession, fresh) || !sameAccountTuple(receipt.session, fresh)) {
      if (state) { accessEndContext = "account-switch"; client.endAccess(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("We could not safely attribute the acceptance because the browser account changed. Sign in again to reconcile it.", true);
      renderInvitation();
      return;
    }
    await openAcceptedRoom(receipt.invitation.roomId, receipt.duplicate
      ? "Invitation already accepted; the Room is now open."
      : "Membership accepted. Welcome to the Room.");
  } catch (error) {
    if (!currentInvitation(version, secret)) return;
    if (error.code === "invitation_account_mismatch") {
      invitation.phase = "wrong-account";
      setInvitationFeedback("This invitation is for another account. Sign in with the separately provisioned account key intended for it.", true);
    } else if (error.code === "invitation_already_used") {
      if (state) client.disconnect();
      try {
        const fresh = await accountClient.restore();
        if (!currentInvitation(version, secret)) return;
        if (!sameAccountTuple(accountSession, fresh)) throw new Error("Browser account changed");
        await openAcceptedRoom(preview.roomId, "Invitation already accepted; the Room is now open.");
        return;
      } catch {
        if (!currentInvitation(version, secret)) return;
        if (state) { accessEndContext = "account-switch"; client.endAccess(); }
        invitation.phase = "changed-account";
        setInvitationFeedback("The invitation may already be accepted, but this browser account could not be confirmed. Sign in again to reconcile it.", true);
      }
    } else if (["invitation_expired", "invitation_revoked", "invitation_authority_changed", "stale_invitation_revision"].includes(error.code)) {
      invitation.phase = "terminal";
      setInvitationFeedback(`${error.message}. No membership was created by this request.`, true);
    } else if (!Number.isSafeInteger(error.status)) {
      invitation.phase = "unknown";
      setInvitationFeedback("We could not confirm whether acceptance completed. Retry uses the same redemption ID and will not create a second membership.", true);
    } else {
      invitation.phase = "ready";
      setInvitationFeedback(`${error.message}. No success is claimed; review and try again.`, true);
    }
    renderInvitation();
  }
});
$("#room-guide-dismiss")?.addEventListener("click", () => {
  if ($("#room-guide")) $("#room-guide").hidden = true;
  try { sessionStorage.setItem("pr-guide-dismissed", "1"); } catch {}
});
$("#auth-kind-room")?.addEventListener("click", () => setAuthKind("room"));
$("#auth-kind-account")?.addEventListener("click", () => setAuthKind("account"));
$("#access-key-reveal")?.addEventListener("click", () => {
  const field = $("#access-key"), show = field.type === "password";
  field.type = show ? "text" : "password";
  $("#access-key-reveal").textContent = show ? "Hide" : "Show";
  $("#access-key-reveal").setAttribute("aria-pressed", show ? "true" : "false");
});
$("#invite-link")?.addEventListener("change", () => {
  const secret = inviteSecretFromText($("#invite-link").value);
  if (!secret) return;
  $("#invite-link").value = "";
  openInvitation({ valid: true, secret });
});
$("#invite-link")?.addEventListener("paste", event => {
  const secret = inviteSecretFromText(event.clipboardData?.getData("text") ?? $("#invite-link").value);
  if (!secret) return;
  event.preventDefault();
  $("#invite-link").value = "";
  openInvitation({ valid: true, secret });
});
$("#auth-form").addEventListener("submit", async e => {
  if (signoutLoading) { e.preventDefault(); return; }
  e.preventDefault(); setFormStatus($("#auth-error"), "");
  const accessKey = $("#access-key").value.trim();
  const requestedRoom = selectedRoomFromLocation();
  const accountMode = accountSignIn();
  await submit(e.currentTarget, async current => {
    let identity;
    if (accountMode) {
      await ensureAccountSession();
      const account = await accountClient.login(accessKey);
      if (!account) return;
      if (!requestedRoom) { $("#access-key").value = ""; showAccountWorkspace(); return; }
      identity = await client.restore(requestedRoom);
    } else identity = await client.login(accessKey);
    if (!current() || !identity || !state || session?.member.id !== identity.member.id || session?.roomId !== identity.roomId) return;
    $("#access-key").value = ""; $("#message-input").focus();
  }, { failureHint: accountMode
    ? (requestedRoom ? "Check the account key and Room membership. Have a room key? Choose Room key." : "Check the account key and try again.")
    : "Check the access key and try again. If this is an account key, choose Account key." });
  if (state) revealLocationHash();
});
$("#signout-button").addEventListener("click", async () => {
  if (!state && accountClient.session?.authenticated) {
    if (signoutLoading || busy || invitationIsCommitting()) return;
    if (inboxUI.hasPending() && !window.confirm("Sign out and clear unsent drafts? Saved replies stay.")) return;
    const operation = ++signoutOperationId;
    signoutLoading = true; $("#signout-button").disabled = true;
    try {
      const ended = await accountClient.logout();
      if (operation !== signoutOperationId) return;
      if (ended || !accountClient.session) endAccountAccess();
    } catch {
      if (operation !== signoutOperationId) return;
      if (!accountClient.session) {
        endAccountAccess(); setFormStatus($("#auth-error"), "Sign-out unconfirmed. Sign in to check your account.", true);
      } else { $("#account-status").textContent = "Couldn’t sign out. Try again."; $("#account-status").hidden = false; }
    } finally {
      if (operation === signoutOperationId) { signoutLoading = false; $("#signout-button").disabled = false;
        for (const control of document.querySelectorAll("#auth-form input, #auth-form button")) control.disabled = false;
        $("#auth-panel").setAttribute("aria-busy", "false"); }
    }
    return;
  }
  if (busy || signoutLoading || !state || !session || invitationIsCommitting()) return;
  saveComposer();
  if (drafts.hasText() || inboxUI?.hasPending() || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending() || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || !$("#new-work-form").hidden || pendingAction) {
    if (!window.confirm((pendingAction?.uncertain || instructionsUI?.hasUnknown()) ? "Sign out and clear drafts and the pending retry? The action may already be saved." : "Sign out and clear unsent drafts and private setup on this device?")) return;
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
        configureAuthPanel();
        const ended = "Session ended; private drafts were cleared.";
        if ($("#auth-error").textContent !== ended) setFormStatus($("#auth-error"), ended, true);
        if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
      }
    }
  }
});
$("#refresh-button").addEventListener("click", async () => {
  if (!state && accountClient.session?.authenticated) {
    if (await confirmAccount()) { showAccountWorkspace(); if (!$("#account-rooms-panel").hidden) loadAccountRooms(); }
    return;
  }
  const operationId = ++refreshOperationId;
  const generation = client.generation, roomId = session?.roomId, memberId = session?.member.id;
  try {
    if (!client.session) {
      const requestedRoom = selectedRoomFromLocation();
      if (requestedRoom) {
        const account = await ensureAccountSession();
        if (!account?.authenticated) throw Object.assign(new Error("Account sign-in required"), { status: 401 });
        await client.restore(requestedRoom);
      } else await client.restore();
    }
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
      setFormStatus($("#auth-error"), signedOut ? "" : "Can’t reach the room. Try refreshing.", true);
      setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
      return;
    }
    handleFailureNotice(error);
  }
});
$("#message-form").addEventListener("submit", e => {
  e.preventDefault(); hideMentions(); if (!state || busy || requestReading) return;
  if (requestMode) { submitRequest(e.currentTarget); return; }
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
    await client.send(pendingMessage.command);
    if (generation !== client.generation || !state) return;
    drafts.clear(threadId);
    $("#message-input").value = ""; pendingMessage = null; clearReply();
    persistDrafts();
    notice(`Message saved${threadId ? " in this thread" : " to the room"}.`);
  }, { failureHint: "Draft kept. Send again to retry." });
});
function submitRequest(form) {
  if (!state || busy || requestReading) return;
  const mode = requestMode, key = composerKey(), identity = session, generation = client.generation;
  if (!$("#message-input").value.trim()) return;
  const hadPending = Boolean(pendingMessage);
  try {
    if (!pendingMessage) {
      const data = replyDraftData(mode, { body: $("#message-input").value.trim(),
        toMemberId: $("#message-to-select").value || null, replyToId, messageId: crypto.randomUUID() });
      pendingMessage = draftCommand(null, mode.kind === "cancelled" ? REPLY_CANCELLED : T.MESSAGE_POSTED, data);
    }
  } catch (error) { setComposerError(error.message); return; }
  saveComposer();
  const command = pendingMessage.command;
  submit(form, async () => {
    try {
      if (command.data.messageId) locallyOwnedMessageIds.add(command.data.messageId);
      const receipt = await client.send(command);
      if (generation !== client.generation || session !== identity || !state) return;
      if (!await confirmsReplyCommand(receipt, command, identity.roomId, identity.member.id)) throw new Error("Save not confirmed");
      if (generation !== client.generation || session !== identity || !state) return;
      drafts.clear(key); requestMode = null; requestEpoch++;
      restoreComposer(drafts.get(currentThreadId)); updateReply(); persistDrafts();
      if (mode.resultEventId) renderReturnBrief();
      notice(mode.kind === "request" ? "Request saved." : mode.kind === "cancelled" ? "Request cancelled." : "Reply saved.");
    } catch (error) {
      if (generation !== client.generation || session !== identity || !state) return;
      // command_rejected is issued after exact-operation lookup. Transport and
      // pre-ledger size/rate errors cannot unlock an earlier uncertain operation.
      if ((!hadPending && [400, 404, 409, 413, 422].includes(error.status))
        || error.code === "command_rejected" && [409, 422].includes(error.status)) pendingMessage = null;
      saveComposer();
      throw error;
    }
  }, { failureHint: "Draft kept. Retry the original, or refresh context after a refusal." });
}
$("#message-list").addEventListener("click", e => {
  if (e.target.closest("[data-empty-write]")) { $("#message-input").focus(); return; }
  if (e.target.closest("[data-empty-invite]")) { $("#invite-people-button")?.click(); return; }
  const button = e.target.closest("[data-message-id]"); if (!button || !state || busy) return;
  const id = button.dataset.messageId;
  if (button.dataset.messageAction?.startsWith("request-")) openRequestMode(button.dataset.messageAction.slice(8), id);
  else if (button.dataset.messageAction === "work") openWork(id);
  else if (button.dataset.messageAction === "result") {
    const message = conversation.byId.get(id), item = state.workItems[message?.workItemId];
    if (item && workActions(item, state.members[session.member.id]).some(([action]) => action === "complete")) openWorkAction(item, "complete", id);
  }
  else if (button.dataset.messageAction === "react") setReaction(id, button.dataset.reaction);
  else if (["reply", "thread"].includes(button.dataset.messageAction)) {
    switchThread(conversation.rootById.get(id), button.dataset.messageAction === "reply");
    if (button.dataset.messageAction === "reply") { replyToId = id; updateReply(); saveComposer(); }
  }
});
function updateReply() {
  const target = conversation?.byId.get(replyToId);
  $("#reply-bar").hidden = Boolean(requestMode) || !target || replyToId === currentThreadId;
  $("#reply-context").textContent = target ? `Replying to ${name(target.authorId)}: ${target.body.slice(0, 100)}` : "";
}
function clearReply() { replyToId = currentThreadId; updateReply(); }
$("#cancel-reply").addEventListener("click", () => { clearReply(); $("#message-input").focus({ preventScroll: true }); });
$("#thread-back").addEventListener("click", () => switchThread(null));
 $("#remember-drafts").addEventListener("change", () => {
  if ($("#remember-drafts").checked) saveComposer();
  else { recovery.clear(); $("#draft-recovery-status").textContent = "Draft recovery off. Drafts stay only while this page is open."; }
});
function rememberComposerSelection({ clearCollapsed = false } = {}) {
  const input = $("#message-input");
  if (input.selectionStart !== input.selectionEnd) {
    lastComposerSelection = { value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  } else if (clearCollapsed) lastComposerSelection = null;
}
$("#message-input").addEventListener("select", () => rememberComposerSelection());
document.addEventListener("selectionchange", () => { if (document.activeElement === $("#message-input")) rememberComposerSelection(); });
for (const type of ["keyup", "mouseup", "touchend"]) $("#message-input").addEventListener(type, () => rememberComposerSelection({ clearCollapsed: true }));
function hideMentions() {
  const list = $("#mention-list");
  if (!list) return;
  list.hidden = true; list.replaceChildren(); mentionIndex = 0;
}
function mentionChoices() {
  const input = $("#message-input"), found = mentionQuery(input.value, input.selectionStart);
  if (!found || !state) return [];
  return mentionMatches(Object.values(state.members), found.query);
}
function renderMentions() {
  const list = $("#mention-list");
  if (!list) return;
  const matches = mentionChoices();
  if (!matches.length) { hideMentions(); return; }
  mentionIndex = Math.min(Math.max(mentionIndex, 0), matches.length - 1);
  list.hidden = false;
  list.innerHTML = matches.map((m, i) => `<li><button type="button" class="mention-option${i === mentionIndex ? " active" : ""}" data-mention-id="${esc(m.id)}" aria-selected="${i === mentionIndex}">${esc(m.displayName)} <span>${esc(kindLabel(m.kind))}</span></button></li>`).join("");
}
function applyMentionMember(member) {
  const input = $("#message-input");
  if (!input || !member) return;
  const next = addressMember(input.value, input.selectionStart, member);
  input.value = next.body;
  const select = $("#message-to-select");
  if ([...select.options].some(option => option.value === next.toMemberId)) select.value = next.toMemberId;
  hideMentions(); saveComposer();
  input.focus(); input.setSelectionRange(next.caret, next.caret);
}
$("#message-input").addEventListener("input", () => { lastComposerSelection = null; saveComposer(); renderMentions(); });
$("#message-to-select").addEventListener("change", () => { saveComposer(); syncRequestComposer(); });
const touchKeyboard = matchMedia("(hover: none) and (pointer: coarse)");
function syncComposerHint() {
  $("#draft-hint").textContent = touchKeyboard.matches ? "Return for a new line · ↑ to send" : "Enter to send · Shift + Enter for a new line";
  $("#message-input").enterKeyHint = touchKeyboard.matches ? "enter" : "send";
}
touchKeyboard.addEventListener("change", syncComposerHint);
syncComposerHint();
$("#message-input").addEventListener("keydown", e => {
  const list = $("#mention-list"), open = list && !list.hidden;
  const matches = open ? mentionChoices() : [];
  if (open && matches.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
      renderMentions();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); hideMentions(); return; }
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); applyMentionMember(matches[mentionIndex]); return; }
  }
  // Some IME confirmation keys arrive after compositionend; keyCode 229 is the
  // legacy UI Events signal. Neither confirmation nor key repeat sends a message.
  if (sendsOnEnter(e, touchKeyboard.matches)) {
    e.preventDefault();
    if (!busy && $("#message-input").value.trim()) $("#message-form").requestSubmit();
  }
});
$("#mention-list")?.addEventListener("mousedown", e => {
  const button = e.target.closest("[data-mention-id]");
  if (!button) return;
  e.preventDefault();
  applyMentionMember(state.members[button.dataset.mentionId]);
});
$("#presence-list").addEventListener("click", e => {
  if (!shouldAddressPresenceClick(e.target)) return;
  const row = e.target.closest(".presence-member");
  const member = state?.members[row?.dataset.memberRecordId];
  if (!member || member.active === false) return;
  applyMentionMember(member);
});
$("#search-form").addEventListener("submit", e => { e.preventDefault(); if (state) renderSearch(); });
$("#message-search").addEventListener("input", () => { if (state) renderSearch(); });
$("#clear-search").addEventListener("click", () => { $("#message-search").value = ""; renderSearch(); $("#message-search").focus(); });

// Navigation only: all consequential actions stay in their existing forms.
// Resolve the current target again on selection; an open menu is not authority.
function ownsRoomActions(context = roomActionsContext) {
  return Boolean(state && session && client.session === session && client.generation === roomGeneration
    && client.ownsAccountSession() && !$("#main").hidden && $("#inbox-panel").hidden
    && (!context || context.session === session && context.generation === client.generation));
}
function roomActionEntries() {
  return [
    { id: "write", label: requestMode ? "Open composer" : $("#message-input").value ? "Continue writing" : "Write a message", words: "compose chat draft reply", target: "#message-input" },
    { id: "search", label: "Search room", words: "find messages work", target: "#message-search" },
    { id: "catch-up", label: "Catch me up", words: "updates attention needs me reminders", target: "#return-brief-panel > summary", reveal: "#return-brief-panel" },
    { id: "work", label: "View work", words: "tasks projects", target: "#work-view-work", activate: true },
    { id: "results", label: "View results", words: "completed approved finished artifacts", target: "#work-view-results", activate: true },
    { id: "people", label: "People & agents", words: "members collaborators team", target: "#people-panel > summary", reveal: "#people-panel" },
    { id: "new-work", label: "New work", words: "create task request", target: "#new-work-button", activate: true },
    { id: "invite", label: "Invite people", words: "share join link", target: "#invite-people-button", activate: true },
    { id: "agent", label: "Add agent", words: "ai assistant mcp tools instinct muse grok build grokbot grok bot connect", target: "#connect-agent-button", reveal: "#people-panel", activate: true },
    { id: "how-invite", label: "How to invite someone", words: "how guest eight hours link help", always: true },
    { id: "how-agent", label: "How to add an agent", words: "how connect instinct muse grok help", always: true },
    { id: "how-inbox", label: "How to open Inbox", words: "how inbox mail email account", always: true },
    { id: "instructions", label: "Room instructions", words: "guidance brief charter", target: "#room-instructions-open", reveal: "#room-about", activate: true }
  ].filter(entry => {
    if (entry.always) return true;
    const target = $(entry.target); return target && !target.disabled && !target.closest("[hidden]");
  });
}
function closeRoomActions(restore = true) {
  const context = roomActionsContext; roomActionsContext = null;
  $("#room-actions-dialog").close(); $("#room-actions-list").replaceChildren(); $("#room-actions-query").value = "";
  $("#room-actions-empty").hidden = true;
  if (restore && context && ownsRoomActions(context) && context.opener?.isConnected && context.opener.getClientRects().length) {
    context.opener.focus({ preventScroll: true });
    if (context.selection && context.opener.value === context.value) context.opener.setSelectionRange(...context.selection);
  }
}
function renderRoomActions() {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  const terms = $("#room-actions-query").value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const entries = roomActionEntries().filter(entry => terms.every(term => `${entry.label} ${entry.words}`.toLowerCase().includes(term)));
  $("#room-actions-list").replaceChildren(...entries.map(entry => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.roomAction = entry.id;
    button.textContent = entry.label; return button;
  }));
  $("#room-actions-empty").hidden = entries.length > 0;
}
function openRoomActions() {
  if (!ownsRoomActions(null) || document.querySelector("dialog[open]")) return;
  const opener = document.activeElement;
  roomActionsContext = { session, generation: client.generation, opener, value: opener?.value,
    selection: typeof opener?.selectionStart === "number" ? [opener.selectionStart, opener.selectionEnd, opener.selectionDirection] : null };
  $("#room-actions-query").value = ""; renderRoomActions();
  $("#room-actions-dialog").showModal(); $("#room-actions-query").focus();
}
function chooseRoomAction(id) {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  const entry = roomActionEntries().find(value => value.id === id);
  if (!entry) { renderRoomActions(); $("#room-actions-query").focus(); return; }
  closeRoomActions(false);
  if (id === "how-invite") {
    const button = $("#invite-people-button");
    if (button && !button.hidden) { button.click(); return; }
    notice("Ask the owner to send an Invite link. Guests can chat for about eight hours in that browser.");
    return;
  }
  if (id === "how-agent") {
    $("#people-panel").open = true;
    const button = $("#connect-agent-button");
    const target = button && !button.hidden ? button : $("#people-panel > summary");
    target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true });
    if (button && !button.hidden) return;
    notice("The owner connects assistants from People & agents. Instinct and Muse can also Use my AI without a key.");
    return;
  }
  if (id === "how-inbox") {
    if (!$("#workspace-nav").hidden) { $("#nav-inbox").click(); return; }
    notice("Inbox uses Account key. Sign out, then choose Account key on the welcome screen.");
    return;
  }
  if (entry.reveal) $(entry.reveal).open = true;
  const target = $(entry.target); target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true });
  if (entry.activate) target.click();
}
$("#room-actions-open kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
$("#room-actions-open").addEventListener("click", openRoomActions);
$("#room-actions-close").addEventListener("click", () => closeRoomActions());
$("#room-actions-dialog").addEventListener("cancel", event => { event.preventDefault(); closeRoomActions(); });
$("#room-actions-query").addEventListener("input", renderRoomActions);
$("#room-actions-list").addEventListener("click", event => { const id = event.target.closest("[data-room-action]")?.dataset.roomAction; if (id) chooseRoomAction(id); });
$("#room-actions-dialog").addEventListener("keydown", event => {
  if (event.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
  const buttons = [...$("#room-actions-list").querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? buttons.length - 1 : index - 1;
    (buttons[next] || $("#room-actions-query")).focus();
  } else if (event.key === "Enter" && document.activeElement === $("#room-actions-query")) {
    event.preventDefault(); if (!event.repeat && buttons[0]) chooseRoomAction(buttons[0].dataset.roomAction);
  }
});
document.addEventListener("keydown", event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k"
    || event.isComposing || event.keyCode === 229 || event.repeat || !ownsRoomActions(null)) return;
  if (document.querySelector("dialog[open]") && !$("#room-actions-dialog").open) return;
  event.preventDefault(); if ($("#room-actions-dialog").open) closeRoomActions(); else openRoomActions();
});
new MutationObserver(() => { if (roomActionsContext && !ownsRoomActions()) closeRoomActions(false); })
  .observe($("#main"), { attributes: true, attributeFilter: ["hidden"] });
new MutationObserver(() => { if (resultView && $("#main").hidden) closeResult(false); })
  .observe($("#main"), { attributes: true, attributeFilter: ["hidden"] });
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
    if (link.hasAttribute('data-view-drafts')) revealDrafts(link.dataset.openWork);
    else revealWork(link.dataset.openWork);
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
window.addEventListener("hashchange", () => {
  const fragment = consumeInvitationFragment();
  if (fragment) openInvitation(fragment);
  else revealLocationHash();
});
$("#new-messages-button").addEventListener("click", () => {
  const list = $("#message-list"); list.scrollTop = list.scrollHeight; newVisibleMessages = 0; unreadAnchorId = null;
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
function openWork(sourceId = null, reuseId = null) {
  if (!can("steer") || busy) return;
  if (!$("#new-work-form").hidden) { $(workRetryLocked ? "#retry-work-button" : "#work-title-input").focus(); return; }
  let definition;
  if (reuseId) {
    try { definition = reusableWorkDefinition(state.workItems[reuseId]); }
    catch (error) { notice(error.message, true); return; }
  }
  workFormOpener = { node: document.activeElement, key: document.activeElement?.dataset.focusKey };
  workFormEpoch++; setWorkRetry(false);
  $("#new-work-form").reset();
  $("#new-work-form").hidden = false; workDraftId = `work-${crypto.randomUUID()}`;
  $("#work-options").open = false;
  $("#work-dialog").showModal();
  $("#source-message-id").value = sourceId || "";
  if (sourceId) $("#work-title-input").value = (state.messages.find(m => m.id === sourceId)?.body || "").trim().replace(/\s+/g, " ").slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
  if (definition) {
    $("#work-title-input").value = definition.title;
    $("#work-done-input").value = definition.definitionOfDone;
  }
  $("#work-reuse-hint").hidden = !definition;
  $("#source-context").textContent = sourceId ? `Source: ${state.messages.find(m => m.id === sourceId)?.body || ""}` : "";
  $("#source-context").hidden = !sourceId; $("#work-title-input").focus();
  syncWorkForm();
}
function closeWorkForm({ returnFocus = true } = {}) {
  const unconfirmed = workRetryLocked;
  $("#work-dialog").close();
  $("#new-work-form").hidden = true; $("#new-work-form").reset();
  setWorkRetry(false); $("#work-reuse-hint").hidden = true;
  setFormStatus($("#new-work-status"), "");
  pendingWork = null; workDraftId = null;
  const opener = workFormOpener; workFormOpener = null;
  const epoch = ++workFormEpoch, generation = client.generation, roomId = session?.roomId, memberId = session?.member?.id;
  const focusAtClose = document.activeElement;
  if (unconfirmed) notice("Creation may already be saved. Check the work list before creating another.");
  if (returnFocus) setTimeout(() => {
    if (epoch !== workFormEpoch || !sameSession(generation, roomId, memberId) || !$("#new-work-form").hidden || document.activeElement !== focusAtClose) return;
    const usable = node => node?.isConnected && !node.disabled && !node.hidden && node.getClientRects().length > 0;
    const replacement = opener?.key ? [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === opener.key) : null;
    const target = [opener?.node, replacement, $("#new-work-button"), $("#composer-work-button")].find(usable) || $("#work-title");
    target.focus({ preventScroll: true });
  }, 0);
}
function setWorkRetry(locked) {
  workRetryLocked = locked;
  for (const control of document.querySelectorAll("#new-work-form input, #new-work-form textarea, #new-work-form select")) control.disabled = locked;
  $("#new-work-form button[type='submit']").hidden = locked;
  $("#retry-work-button").hidden = !locked;
  $("#work-retry-hint").hidden = !locked;
  $("#cancel-work-button").textContent = locked ? "Close" : "Cancel";
}
$("#new-work-button").addEventListener("click", () => openWork());
$("#composer-work-button").addEventListener("click", () => openWork());
$("#review-settings-button").addEventListener("click", () => {
  $("#work-options").open = true;
  $("#require-verification").focus();
});
$("#cancel-work-button").addEventListener("click", () => closeWorkForm());
$("#work-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) closeWorkForm(); });
$("#new-work-form").addEventListener("change", syncWorkForm);
$("#new-work-form").addEventListener("submit", e => { e.preventDefault(); sendWorkProposal(); });
$("#retry-work-button").addEventListener("click", () => { if (workRetryLocked) sendWorkProposal(); });
$("#work-list").addEventListener("click", e => {
  if (e.target.closest("[data-empty-work]")) { $("#new-work-button").click(); return; }
  if (e.target.closest("[data-empty-suggest]")) { $("#message-input").focus(); return; }
  const button = e.target.closest("[data-reuse-work]");
  if (button) openWork(null, button.dataset.reuseWork);
});
function sendWorkProposal() {
  if (!state || busy || !workDraftId) return;
  const independentVerificationRequired = $("#require-verification").checked, ownerDecisionRequired = $("#require-decision").checked;
  const data = { workItemId: workDraftId, title: $("#work-title-input").value, definitionOfDone: $("#work-done-input").value, accountableMemberId: $("#assignee-select").value, verifierMemberId: independentVerificationRequired ? $("#verifier-select").value : null, independentVerificationRequired, ownerDecisionRequired, humanDecisionMakerId: ownerDecisionRequired ? state.room.ownerId : null, mode: $("#work-mode-select").value, sourceMessageId: $("#source-message-id").value || null };
  if (!workRetryLocked) pendingWork = draftCommand(pendingWork, T.WORK_PROPOSED, data);
  const entry = pendingWork;
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  submit($("#new-work-form"), async current => {
    try {
      const receipt = await client.send(entry.command);
      if (!current() || !sameSession(generation, roomId, memberId)) return;
      if (!confirmsWorkProposal(receipt, entry.command, roomId, memberId)) throw new Error("The creation receipt could not be confirmed");
    } catch (error) {
      if (!current() || !sameSession(generation, roomId, memberId)) return;
      setWorkRetry(retryUnconfirmed(error, workRetryLocked));
      throw error;
    }
    setWorkRetry(false);
    closeWorkForm(); selectWorkView("work"); notice("Work proposed. The accountable member must accept it; no external action was authorized.");
  }, { failureHint: "Your work proposal was kept; try again." });
}
const field = (name, label, type = "text") => `<label>${esc(label)}<input name="${name}" type="${type}" required maxlength="2000"></label>`;
const area = (name, label) => `<label>${esc(label)}<textarea name="${name}" required rows="3" maxlength="4000"></textarea></label>`;
function producerField() {
  const members = Object.values(state.members).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const self = members.find(member => member.id === session.member.id);
  const selfOption = self ? `<option value="${esc(self.id)}">I produced this — ${esc(memberLabel(self.id))}</option>` : "";
  const otherOptions = members.filter(member => member.id !== session.member.id).map(member => `<option value="${esc(member.id)}">${esc(memberLabel(member.id))} · ${esc(kindLabel(member.kind))}${member.active === false ? " · access revoked" : ""}</option>`).join("");
  return `<label>Produced by<select name="producerId" required aria-describedby="producer-attribution-help"><option value="">Choose producer</option>${selfOption}<option value="__external__">Outside person or AI</option><option value="__unknown__">Unknown / not reported</option>${otherOptions}</select></label><label id="external-producer-field" hidden>Credit<input name="externalProducer" maxlength="160" disabled autocomplete="off" placeholder="Person, team or AI"></label><p id="producer-attribution-help" class="form-hint">You submit this result. Credit its producer, or choose Unknown.</p>`;
}
const actionSpecs = {
  "offer-help": [T.HELP_OFFER_OPENED, "Offer help", ""],
  ...Object.fromEntries(Object.keys(offerStatuses).map(action => [action, [T.HELP_OFFER_UPDATED, offerLabels[action], ""]])),
  help: [T.WORK_HELP_UPDATED, "Ask for help", ""],
  "end-help": [T.WORK_HELP_UPDATED, "End this help request?", "<p>People and agents will no longer find this request. This does not stop work already underway.</p>"],
  accept: [T.WORK_ACCEPTED, "Accept this work?", "<p>Accept responsibility for the stated outcome. This does not run any tools.</p>"],
  start: [T.WORK_STARTED, "Record work starting", "<p>Record that you are starting this outcome. A record is not proof of external execution.</p>"],
  block: [T.WORK_BLOCKED, "Report a blocker", area("reason", "What is blocked?") + area("nextAction", "What is needed next?")],
  resolve: [T.WORK_BLOCKER_RESOLVED, "Resolve the blocker", area("resolution", "What changed or which direction did you accept?")],
  complete: [T.WORK_COMPLETED, "Post actual evidence", area("summary", "What did you complete?") + field("evidenceUrl", "Evidence URL (HTTPS)", "url") + field("evidenceVersion", "Exact commit or artifact version") + area("nextAction", "Next handoff")],
  claim: [T.CLAIM_ACQUIRED, "Record authorized write scope", field("repository", "Repository (owner/name)") + field("ref", "Branch or exact revision") + area("paths", "Paths or folder/**, one per line") + field("expiresAt", "Expiry (ISO timestamp, with timezone)") + "<p>Reserves matching scope in this room. External permission is separate.</p>"],
  release: [T.CLAIM_RELEASED, "Release this scope?", "<p>Other work can reserve it next. This does not stop an outside agent or change the work's result. Confirm any outside activity separately.</p>"],
  verify: [T.VERIFICATION_RECORDED, "Record an evidence check", '<label>Result<select name="result" required><option value="">Choose after checking</option><option value="pass">Pass</option><option value="fail">Finding / fail</option></select></label>' + area("summary", "What did you check at this exact version?")],
  decide: [T.OWNER_DECISION_RECORDED, "Record your decision", '<label>Decision<select name="decision" required><option value="">Choose</option><option value="approved">Approve</option><option value="changes_requested">Request changes</option><option value="rejected">Reject</option></select></label>' + area("reason", "Reason") + "<p>Approval does not merge, deploy, or spend money.</p>" ]
};
let resultView = null;
function selectWorkView(view) {
  selectedWorkView = view;
  $("#work-list").hidden = view !== "work"; $("#room-results-list").hidden = view !== "results";
  $("#new-work-button").textContent = view === "results" ? "New work" : "New";
  for (const name of ["work", "results"]) $("#work-view-" + name).setAttribute("aria-pressed", String(view === name));
}
for (const name of ["work", "results"]) $("#work-view-" + name).addEventListener("click", () => {
  if (ownsRoomActions(null)) selectWorkView(name);
});
function resultRow(item) {
  const result = currentResult(item), title = esc(item.title);
  const open = result.kind === "room_text"
    ? `<button type="button" data-read-result="${esc(item.id)}" data-focus-key="result:${esc(item.id)}">${title}</button>`
    : `<a href="${safeUrl(item.receipt.evidenceUrl)}" target="_blank" rel="noreferrer" data-focus-key="result:${esc(item.id)}">${title} ↗</a>`;
  return `<article class="result-row" data-result-work-id="${esc(item.id)}">${open}<p>${esc([...item.receipt.summary].slice(0, 200).join(""))}${[...item.receipt.summary].length > 200 ? "…" : ""}</p><div class="result-meta"><span>${result.status === "approved" ? "Approved" : "Completed"}${result.kind === "external" ? " · External evidence" : ""}</span><button type="button" class="text-button" data-result-work="${esc(item.id)}">Work details</button></div></article>`;
}
function resultStatus() {
  const view = resultView;
  if (!view || !sameSession(view.generation, view.roomId, view.memberId)) return;
  const item = state.workItems[view.workItemId];
  const earlier = !matchesReceipt(view.receipt, item?.receipt) || (view.fromResults && !currentResult(item));
  $("#result-status").textContent = (earlier ? "Earlier result · " : "") + (view.error ? "Exact text unavailable. Close and try again."
    : view.loaded ? `Submitted by ${memberLabel(view.reportedById)} · exact stored text` : "Loading exact text…");
}
function closeResult(restore = true) {
  const view = resultView;
  resultView = null; $("#result-dialog").close(); $("#result-title").textContent = "Result";
  $("#result-status").textContent = ""; $("#result-body").textContent = "";
  $("#result-original").hidden = true;
  if (restore && view && sameSession(view.generation, view.roomId, view.memberId)) {
    if (view.fromResults && selectedWorkView === "results") {
      const row = [...$("#room-results-list").querySelectorAll("[data-result-work-id]")].find(node => node.dataset.resultWorkId === view.workItemId);
      (row?.querySelector("[data-read-result]") || $("#work-view-results")).focus({ preventScroll: true });
      return;
    }
    const card = workRecord(view.workItemId); focusRecord(card?.querySelector("[data-read-result]") || card);
  }
}
$("#close-result").addEventListener("click", () => closeResult());
$("#result-original").addEventListener("click", () => {
  const view = resultView;
  if (!view?.loaded || busy || !sameSession(view.generation, view.roomId, view.memberId)
    || !state.messages.some(message => message.id === view.originalId && message.workItemId === view.workItemId)) return;
  closeResult(false);
  history.replaceState(null, "", recordHref("message", view.originalId)); revealMessage(view.originalId);
});
$("#result-dialog").addEventListener("cancel", event => { event.preventDefault(); closeResult(); });
function readResult(e) {
  const read = e.target.closest("[data-read-result]");
  if (read && state && !busy) {
    const item = state.workItems[read.dataset.readResult], receipt = item?.receipt;
    if (!receipt?.nativeText) return;
    const fromResults = Boolean(read.closest("#room-results-list"));
    if (fromResults && !currentResult(item)) return;
    const view = { generation: client.generation, roomId: session.roomId, memberId: session.member.id, workItemId: item.id,
      fromResults, receipt: { completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion }, reportedById: receipt.reportedById }; resultView = view;
    $("#result-title").textContent = item.title; $("#result-status").textContent = "Loading exact text…"; $("#result-body").textContent = "";
    $("#result-original").hidden = true;
    $("#result-dialog").showModal();
    const owns = () => resultView === view && sameSession(view.generation, view.roomId, view.memberId);
    client.workResult(item.id, { completionEventId: receipt.eventId }).then(value => {
      if (!owns() || !value) return;
      if (value.result.receipt?.evidenceVersion !== receipt.evidenceVersion) throw new Error("Pinned version changed");
      $("#result-body").textContent = value.result.text.body;
      const message = state.messages.find(message => message.id === value.result.text.messageId && message.workItemId === item.id
        && message.body === value.result.text.body);
      const original = state.messages.find(original => original.id === message?.replyToId && original.workItemId === item.id && original.proposal);
      view.originalId = original?.id; $("#result-original").hidden = !original;
      view.loaded = true; resultStatus();
    }).catch(() => { if (owns()) { view.error = true; resultStatus(); } });
    return;
  }
  const button = e.target.closest("[data-action]"); if (!button || busy) return;
  openWorkAction(state.workItems[button.dataset.workId], button.dataset.action, null, button.dataset.offerId);
}
$("#work-list").addEventListener("click", readResult);
$("#room-results-list").addEventListener("click", e => {
  readResult(e);
  const work = e.target.closest("[data-result-work]");
  if (work) revealWork(work.dataset.resultWork);
});
function openWorkAction(item, action, draftMessageId = null, offerId = null) {
  if (pendingAction?.uncertain) { resumeAction(); return; }
  if (!item || !Object.hasOwn(actionSpecs, action)) return;
  const [type, , fields] = actionSpecs[action];
  actionEpoch++;
  pendingAction = { type, action, workId: item.id, revision: item.revision, draftMessageId, receipt: item.receipt ? { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion } : null, retry: null, uncertain: false, error: "" };
  if (isHelpAction(action)) {
    pendingAction.helpRevision = item.helpWanted?.revision ?? 0;
    pendingAction.accountableRevision = state.members[item.accountableMemberId]?.revision;
  }
  if (isOfferAction(action)) pinOffer(pendingAction, item, offerId);
  $("#action-fields").innerHTML = action === "complete" ? producerField() + (draftMessageId ? area("summary", "Summary") + area("nextAction", "Next step") : fields) : fields;
  if (action === "help") {
    const keep = item.helpWanted?.status === "open" && Date.parse(item.helpWanted.expiresAt) > Date.now();
    $("#action-fields").innerHTML = '<label>What would help?<textarea name="scope" required rows="3" maxlength="600"></textarea></label><label>Available for<select name="duration" required>'
      + (keep ? '<option value="keep">Keep current end time</option>' : "")
      + '<option value="3600000">1 hour</option><option value="86400000"' + (keep ? "" : " selected") + '>1 day</option><option value="604800000">7 days</option></select></label><p class="form-hint">Visible to this room. You stay accountable; no work starts automatically.</p><p id="help-current" class="form-hint" hidden></p>';
    $("#action-fields [name=scope]").value = item.helpWanted?.scope ?? "";
    pendingAction.helpExpiresAt = keep ? item.helpWanted.expiresAt : null;
  }
  if (action === "end-help") $("#action-fields").insertAdjacentHTML("afterbegin", '<p id="help-current" class="definition"></p>');
  if (isOfferAction(action)) {
    $("#action-fields").innerHTML = '<p id="offer-current" class="definition"></p>'
      + (action === "offer-help" ? '<label>How can you help?<textarea name="plan" required rows="3" maxlength="600"></textarea></label>'
        : '<p id="offer-plan" class="definition"></p><label>Note<textarea name="reason" required rows="2" maxlength="600"></textarea></label>')
      + (action === "release-offer" ? '<label class="checkbox-label"><input name="externalActivityUnverified" type="checkbox" required> Outside work may still be running.</label>'
        : '<p class="form-hint">Coordination only. No work starts or permissions change.</p>');
  }
  renderActionContext(item, action);
  $("#action-dialog").showModal();
  syncActionForm();
}
// Only opening or explicitly reviewing current work changes the pinned context.
// A background update must never silently retarget a review or approval.
function renderActionContext(item, action) {
  if (action === "end-help") currentHelp().textContent = item.helpWanted?.scope ?? "";
  if (isOfferAction(action)) {
    offerField("current").textContent = item.helpWanted?.scope ?? "";
    const offer = state.helpOffers?.[pendingAction.offerId];
    if (offerField("plan")) offerField("plan").textContent = offer ? `${memberLabel(offer.offererId)} · ${offer.plan}` : "Offer unavailable";
  }
  $("#review-brief").hidden = !["verify", "decide"].includes(action);
  setText("#review-criteria", $("#review-brief").hidden ? "" : item.definitionOfDone);
  setText("#review-summary", $("#review-brief").hidden ? "" : item.receipt?.summary ?? "");
  setText("#review-next", $("#review-brief").hidden ? "" : item.receipt?.nextAction ?? "");
  $("#review-notes").open = false;
  const review = action === "decide" && matchesReceipt(item.verification, item.receipt) ? item.verification : null;
  $("#decision-review").hidden = !review; $("#decision-review").open = false;
  setText("#decision-review-label", review ? `${review.independenceConfirmed ? "Independent check" : "Evidence check"} · ${review.result === "pass" ? "Pass" : "Finding"}` : "");
  setText("#decision-review-by", review ? memberLabel(review.verifierId) : "");
  setText("#decision-review-text", review?.summary ?? "");
  setText("#decision-review-version", review ? `Evidence ${review.evidenceVersion}` : "");
  $("#action-title").textContent = action === "block" && item.state === S.COMPLETED ? "Reopen for rework"
    : action === "verify" && item.independentVerificationRequired && hasIndependentProducer(item) ? "Record an independent check" : actionSpecs[action][1];
  $("#action-context").textContent = isOfferAction(action) ? item.title : `${item.title} · revision ${item.revision}${item.receipt ? item.receipt.nativeText ? " · stored text" : ` · evidence ${item.receipt.evidenceVersion}` : ""}`;
  const evidence = $("#action-evidence");
  let evidenceUrl = null;
  try {
    const url = new URL(item.receipt?.evidenceUrl);
    if (url.protocol === "https:" && !url.username && !url.password) evidenceUrl = url.href;
  } catch { /* Historical or malformed evidence stays non-interactive. */ }
  evidence.hidden = !(["verify", "decide"].includes(action) && evidenceUrl);
  if (evidence.hidden) evidence.removeAttribute("href");
  else evidence.setAttribute("href", evidenceUrl);
  $("#action-fields").querySelector("#verification-boundary")?.remove();
  const unknown = action === "verify" && item.independentVerificationRequired && !hasReportedProducer(item);
  if (unknown) $("#action-fields").insertAdjacentHTML("afterbegin", `<p id="verification-boundary" class="form-hint"><strong>${item.receipt.producerAttribution === "external-reported" ? "Outside credit is reported, not verified." : "Producer identity is unknown."}</strong> This check cannot satisfy independent verification or unlock approval.</p>`);
  $("#action-dialog").setAttribute("aria-describedby", unknown ? "action-context verification-boundary" : "action-context");
  const result = $("#action-fields select[name='result']");
  if (unknown) result?.setAttribute("aria-describedby", "verification-boundary");
  else result?.removeAttribute("aria-describedby");
  loadActionText(item, action);
}
function loadActionText(item, action) {
  const entry = pendingAction, epoch = actionEpoch, generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const request = (entry.textRequest ?? 0) + 1; entry.textRequest = request;
  entry.text = null; entry.textRequired = Boolean(entry.draftMessageId || ["verify", "decide"].includes(action) && item.receipt?.nativeText);
  $("#action-text").hidden = !entry.textRequired; $("#action-text-body").textContent = ""; $("#action-text-origin").textContent = "";
  if (!entry.textRequired) return;
  $("#action-text-origin").textContent = "Loading exact text…";
  if (entry.draftMessageId) $("#action-title").textContent = "Save as result";
  const owns = () => pendingAction === entry && actionEpoch === epoch && entry.textRequest === request && sameSession(generation, roomId, memberId);
  client.workResult(item.id, entry.draftMessageId ? { draftMessageId: entry.draftMessageId } : { completionEventId: entry.receipt.completionEventId }).then(value => {
    if (!owns() || !value) return;
    if (!entry.draftMessageId && (value.result.receipt?.eventId !== entry.receipt.completionEventId || value.result.receipt?.evidenceVersion !== entry.receipt.evidenceVersion)) throw new Error("Pinned evidence changed");
    entry.text = value.result.text;
    $("#action-text-body").textContent = entry.text.body;
    const proposal = entry.text.proposal;
    $("#action-text-origin").textContent = `Posted by ${memberLabel(entry.text.postedById)}${proposal ? ` · draft based on revision ${proposal.basisRevision} · authorship unverified` : ""}`;
    if (value.current.workRevision !== entry.revision) { entry.needsReview = true; entry.error = "Work changed. Review current work before saving."; }
    syncActionForm();
  }).catch(() => {
    if (!owns()) return;
    entry.needsReview = true; entry.error = "Exact text unavailable. Review current work to try again.";
    $("#action-text-origin").textContent = "Text unavailable"; syncActionForm();
  });
}
function actionAvailable(entry) {
  const item = state?.workItems[entry.workId];
  if (item && isOfferAction(entry.action)) {
    if (entry.action === "offer-help") return offersView(item)?.availability.canOffer === true;
    const key = { "select-offer": "canSelect", "decline-offer": "canDecline", "withdraw-offer": "canWithdraw", "release-offer": "canRelease" }[entry.action];
    return offerChoice(entry)?.[key] === true;
  }
  if (item && isHelpAction(entry.action)) {
    const help = helpView(item);
    return entry.action === "help" ? help?.canPublish === true : help?.canWithdraw === true;
  }
  return Boolean(item && workActions(item, state.members[session.member.id]).some(([action]) => action === entry.action));
}
function actionChanged(entry) {
  const item = state?.workItems[entry.workId];
  if (isOfferAction(entry.action)) return item?.revision !== entry.revision
    || (item?.helpWanted?.revision ?? 0) !== entry.helpRevision || (item?.helpWanted?.eventId ?? null) !== entry.helpEventId
    || (state?.helpOffers?.[entry.offerId]?.revision ?? null) !== entry.offerRevision
    || state?.members[session.member.id]?.revision !== entry.viewerRevision
    || (state?.members[state?.helpOffers?.[entry.offerId]?.offererId]?.revision ?? null) !== entry.offererRevision;
  return item?.revision !== entry.revision || isHelpAction(entry.action) && (
    (item?.helpWanted?.revision ?? 0) !== entry.helpRevision
    || state?.members[item?.accountableMemberId]?.revision !== entry.accountableRevision);
}
function syncActionForm() {
  $("#resume-action").hidden = !pendingAction?.uncertain;
  if (!pendingAction || !state || busy) return;
  const entry = pendingAction, item = state.workItems[entry.workId], changed = actionChanged(entry);
  const available = actionAvailable(entry), save = $("#action-form button[type='submit']");
  for (const field of $("#action-fields").querySelectorAll("input,textarea,select")) field.disabled = entry.uncertain;
  if (entry.action === "complete") {
    const external = $("#action-fields [name=producerId]").value === "__external__", input = $("#action-fields [name=externalProducer]");
    $("#action-fields").querySelector("#external-producer-field").hidden = !external; input.required = external; input.disabled = entry.uncertain || !external;
    $("#action-fields").querySelector("#producer-attribution-help").textContent = external ? "Reported credit only. No access or verified identity."
      : "You submit this result. Credit its producer, or choose Unknown.";
  }
  save.textContent = entry.uncertain ? "Retry original save" : offerLabels[entry.action] ?? (entry.action === "help" ? "Publish request" : entry.action === "end-help" ? "End request" : "Save record");
  save.disabled = !entry.uncertain && (changed || entry.needsReview || !available || entry.textRequired && !entry.text);
  $("#cancel-action").textContent = entry.uncertain ? "Close" : "Cancel";
  $("#refresh-action").hidden = entry.uncertain || !(changed || entry.needsReview || !available);
  $("#refresh-action").disabled = false;
  const text = entry.uncertain ? "Save not confirmed. Retry the original before making changes."
    : !available ? "This action is no longer available. Your entries are kept."
      : changed || entry.needsReview ? entry.error || "Work changed. Review current work before saving." : entry.error;
  setFormStatus($("#action-error"), text, Boolean(text));
}
function resumeAction() {
  if (!pendingAction || busy) return;
  actionEpoch++;
  if (!$("#action-dialog").open) $("#action-dialog").showModal();
  syncActionForm(); $("#action-form button[type='submit']").focus();
}
$("#resume-action").addEventListener("click", resumeAction);
$("#action-fields").addEventListener("change", event => { if (event.target.name === "producerId") syncActionForm(); });
$("#refresh-action").addEventListener("click", () => {
  const entry = pendingAction;
  if (!entry || !state || busy || entry.uncertain) return;
  const epoch = actionEpoch, generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const owns = () => pendingAction === entry && actionEpoch === epoch && sameSession(generation, roomId, memberId);
  submit($("#action-form"), async current => {
    try { await client.refresh(); }
    catch (error) {
      if (current() && owns()) {
        client.handleFailure(error);
        if (owns()) { clearNotice(); entry.error = "Could not load current work. Try again."; entry.needsReview = true; }
      }
      return;
    }
    if (!current() || !owns()) return;
    const item = state.workItems[entry.workId];
    if (!actionAvailable(entry)) return;
    const receipt = item.receipt ? { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion } : null;
    const changedResult = JSON.stringify(receipt) !== JSON.stringify(entry.receipt);
    const changedHelp = isHelpAction(entry.action) && actionChanged(entry);
    entry.revision = item.revision; entry.receipt = receipt; entry.retry = null; entry.needsReview = false;
    entry.error = changedResult ? "Result changed. Notes kept; inspect this version and choose again." : "";
    if (isOfferAction(entry.action)) {
      pinOffer(entry, item);
      entry.error = "Current request loaded. Review it alongside your note before saving.";
      const acknowledgement = $("#action-fields [name=externalActivityUnverified]");
      if (acknowledgement) acknowledgement.checked = false;
    }
    if (isHelpAction(entry.action)) {
      entry.helpRevision = item.helpWanted?.revision ?? 0;
      entry.accountableRevision = state.members[item.accountableMemberId]?.revision;
      if (changedHelp && entry.action === "help") {
        entry.error = "Request changed. Your draft is kept; compare it with the latest request.";
        currentHelp().hidden = false;
        currentHelp().textContent = item.helpWanted ? `Latest: ${item.helpWanted.scope} · ${helpView(item).status} · ends ${new Date(item.helpWanted.expiresAt).toLocaleString()}` : "No current request.";
        const keep = $("#action-fields option[value=keep]");
        if (keep) { keep.disabled = true; $("#action-fields [name=duration]").value = ""; }
        entry.helpExpiresAt = null;
      }
    }
    if (changedResult) for (const field of $("#action-fields").querySelectorAll("select[name='result'],select[name='decision']")) field.value = "";
    renderActionContext(item, entry.action);
  }).then(() => {
    if (owns() && $("#action-dialog").open && document.activeElement === document.body) $("#action-fields input:not([disabled]),#action-fields textarea:not([disabled]),#action-fields select:not([disabled]),#cancel-action")?.focus();
  });
});
function restoreActionFocus(entry) {
  if (!entry) return;
  const generation = client.generation, roomId = session?.roomId, memberId = session?.member?.id, epoch = actionEpoch;
  setTimeout(() => {
    if (!state || epoch !== actionEpoch || !sameSession(generation, roomId, memberId)) return;
    const card = workRecord(entry.workId);
    const key = `work-action:${entry.workId}:${entry.action}${isOfferAction(entry.action) && entry.action !== "offer-help" ? ":" + entry.offerId : ""}`;
    const action = card ? [...card.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key) : null;
    focusRecord(action || card);
  }, 0);
}
function closeActionDialog({ returnFocus = true, confirmed = false } = {}) {
  const entry = pendingAction;
  if (busy && !confirmed) return;
  actionEpoch++;
  if ($("#action-dialog").open) $("#action-dialog").close();
  if (confirmed || !entry?.uncertain) pendingAction = null;
  $("#resume-action").hidden = !pendingAction?.uncertain;
  if (returnFocus) restoreActionFocus(entry);
}
$("#cancel-action").addEventListener("click", () => closeActionDialog());
$("#action-dialog").addEventListener("cancel", e => {
  e.preventDefault();
  if (!busy) closeActionDialog();
});
$("#action-form").addEventListener("submit", e => {
  e.preventDefault(); if (!pendingAction || !state || busy) return;
  const entry = pendingAction, fields = Object.fromEntries(new FormData(e.currentTarget));
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id, epoch = actionEpoch, focus = document.activeElement;
  if (!entry.uncertain && (entry.needsReview || entry.textRequired && !entry.text || actionChanged(entry) || !actionAvailable(entry))) { syncActionForm(); return; }
  if (!entry.uncertain) {
    const data = { workItemId: entry.workId, expectedRevision: entry.revision, ...fields };
    if (isOfferAction(entry.action)) {
      data.offerId = entry.offerId;
      if (entry.action === "offer-help" || entry.action === "select-offer") Object.assign(data, { expectedHelpRevision: entry.helpRevision, helpEventId: entry.helpEventId });
      if (entry.action !== "offer-help") Object.assign(data, { expectedOfferRevision: entry.offerRevision, status: offerStatuses[entry.action] });
      if (entry.action === "release-offer") data.externalActivityUnverified = fields.externalActivityUnverified === "on";
      try { validateHelpOfferData(entry.type, data); } catch { entry.error = "Add a short note and review the required choice."; syncActionForm(); return; }
    }
    if (isHelpAction(entry.action)) {
      data.expectedHelpRevision = entry.helpRevision;
      data.status = entry.action === "help" ? "open" : "withdrawn";
      if (entry.action === "help") {
        const duration = Number(fields.duration);
        if (fields.duration !== "keep" && ![3600000, 86400000, 604800000].includes(duration)) return;
        data.expiresAt = fields.duration === "keep" ? entry.helpExpiresAt : new Date(Date.now() + duration).toISOString();
        delete data.duration;
        if (Date.parse(data.expiresAt) <= Date.now()) { entry.error = "End time passed. Choose a new duration."; syncActionForm(); return; }
      }
      try { validateHelpData(data); } catch { entry.error = "Add a short scope and choose an end time."; syncActionForm(); return; }
    }
    if (entry.action === "complete") data.producerId = ["__unknown__", "__external__"].includes(fields.producerId) ? null : fields.producerId;
    if (entry.draftMessageId) Object.assign(data, { evidenceKind: "room_text", evidenceMessageId: entry.text.messageId,
      evidenceMessageEventId: entry.text.messageEventId, evidenceVersion: entry.text.evidenceVersion, previousCompletionEventId: entry.receipt?.completionEventId ?? null });
    if (entry.action === "claim") data.paths = fields.paths.split("\n").map(p => p.trim()).filter(Boolean);
    if (["verify", "decide"].includes(entry.action)) Object.assign(data, entry.receipt);
    entry.retry = draftCommand(entry.retry, entry.type, data);
  }
  submit(e.currentTarget, async current => {
    const owns = () => current() && pendingAction === entry && actionEpoch === epoch && sameSession(generation, roomId, memberId);
    try {
      const receipt = await client.send(entry.retry.command);
      if (!owns()) return;
      if (!await confirmsWorkAction(receipt, entry.retry.command, roomId, memberId)) throw new Error("Save receipt could not be confirmed");
      if (!owns()) return;
    } catch (error) {
      if (!owns()) return;
      clearNotice();
      entry.uncertain = retryUnconfirmed(error, entry.uncertain);
      entry.needsReview = !entry.uncertain && error.code === "command_rejected" && error.status === 409;
      entry.error = error.message; return;
    }
    closeActionDialog({ returnFocus: false, confirmed: true }); notice(isHelpAction(entry.action) ? "Help request saved." : isOfferAction(entry.action) ? "Offer updated." : "Record saved.");
    const settledEpoch = actionEpoch;
    setTimeout(() => { if (actionEpoch === settledEpoch && sameSession(generation, roomId, memberId)) revealWork(entry.workId); }, 0);
  }, { failureHint: "Your entries were kept; try again." }).then(() => {
    if (pendingAction !== entry || actionEpoch !== epoch || !sameSession(generation, roomId, memberId) || !$("#action-dialog").open
      || document.activeElement !== document.body) return;
    const target = entry.uncertain ? $("#action-form button[type='submit']")
      : focus?.isConnected && !focus.disabled ? focus : $("#refresh-action:not([hidden]),#cancel-action");
    target?.focus();
  });
});
window.addEventListener("beforeunload", e => {
  if (state) saveComposer();
  if ((state && (drafts.hasText() || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending() || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || !$("#new-work-form").hidden || pendingAction))
    || invitationIsCommitting() || invitation.phase === "unknown") { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state) saveComposer(); });
window.addEventListener("pagehide", () => {
  if (state) saveComposer();
  leavingPage = true;
  try { client.endAccess(); } finally { leavingPage = false; }
});
window.addEventListener("pageshow", e => {
  if (!e.persisted) return;
  if (accountHomeFromLocation()) { ensureAccountSession().then(showAccountWorkspace).catch(handleFailureNotice); return; }
  const roomId = selectedRoomFromLocation();
  (roomId ? ensureAccountSession().then(account => account.authenticated ? client.restore(roomId) : null) : client.restore()).catch(handleFailureNotice);
});
// Return brief: one compact entry before conversation. Fetch on return and
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
    const producer = event.data.producerId ? memberLabel(event.data.producerId)
      : event.data.externalProducer ? `${event.data.externalProducer} · outside room, reported` : "unknown — not reported";
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
  const previousKeys = focusedKey ? [...list.querySelectorAll("[data-brief-key]")].map(node => node.dataset.briefKey) : [];
  const changed = list._content !== html;
  if (changed) {
    list.innerHTML = html;
    list._content = html;
  }
  if (focusedKey && changed) {
    const remaining = new Map([...list.querySelectorAll("[data-brief-key]")].map(node => [node.dataset.briefKey, node]));
    const index = previousKeys.indexOf(focusedKey);
    // Keep the current item, then its next surviving neighbor, then the previous
    // one. A resolved request should not restart a long queue at the first row.
    const destination = [focusedKey, ...previousKeys.slice(index + 1), ...previousKeys.slice(0, index).reverse()]
      .map(key => remaining.get(key)).find(Boolean) ?? remaining.values().next().value;
    const acknowledgement = $("#rb-ack-button");
    const fallback = !acknowledgement.disabled && !acknowledgement.hidden
      ? acknowledgement
      : $("#return-brief-panel > summary");
    (destination || fallback).focus({ preventScroll: true });
  }
}
function renderContribution(steps, owned) {
  const panel = $("#contribution-next"), button = $("#contribution-open"), more = $("#contribution-more");
  const focused = panel.contains(document.activeElement);
  const selected = (focused && steps.find(step => step.key === button.dataset.step)) || steps[0];
  const contributed = owned && (state.messages.some(message => message.authorId === session.member.id)
    || state.eventLog.some(event => event.actorId === session.member.id && /^(work|verification|owner_decision)\./.test(event.type)));
  // An empty conversation already points at its composer. Do not push it below
  // the first mobile viewport with a second introduction prompt.
  const newcomer = owned && !contributed && state.messages.length > 0;
  const visible = Boolean(selected || newcomer);
  const key = selected?.key ?? "hello";
  if (focused && (!visible || key !== button.dataset.step)) $("#return-brief-panel > summary").focus({ preventScroll: true });
  panel.hidden = !visible;
  setText("#contribution-label", selected?.label ?? (newcomer ? "Start here" : ""));
  setText("#contribution-title", selected?.title ?? (newcomer ? "What would you like to help with?" : ""));
  setText("#contribution-open", selected?.button ?? (newcomer ? "Say hello" : ""));
  button.dataset.step = key;
  button.disabled = !owned || busy || requestReading;
  more.hidden = steps.length < 2;
  setText("#contribution-more", steps.length > 1 ? `${steps.length - 1} more` : "");
}
$("#contribution-more").addEventListener("click", () => {
  if (!state) return;
  $("#return-brief-panel").open = true;
  $("#return-brief-panel > summary").focus();
});
$("#contribution-open").addEventListener("click", () => {
  if (!state || busy || requestReading || client.session !== session || !client.ownsAccountSession()) return;
  const key = $("#contribution-open").dataset.step;
  if (key === "hello") { switchThread(null, true); return; }
  const step = contributionSteps(state, session.member.id).find(candidate => candidate.key === key);
  if (!step) { renderReturnBrief(); return; }
  if (step.kind === "request") { revealMessage(step.id); return; }
  if (step.draftCount > 1) { revealDrafts(step.id); return; }
  if (step.draftMessageId) { revealMessage(step.draftMessageId); return; }
  // Only review/decision shortcuts open a form. Starting work still requires
  // inspecting its existing card and explicitly choosing the relevant action.
  if (["verify", "decide"].includes(step.action)) openWorkAction(state.workItems[step.id], step.action);
  else revealWork(step.id);
});
function renderReturnBrief() {
  clearTimeout(returnClock); returnClock = null;
  const now = Date.now();
  const owned = state && session && client.session === session && client.generation === roomGeneration && client.ownsAccountSession();
  const returnBrief = briefView.owns(briefView.chain) ? briefView.brief : null;
  const current = owned ? { evaluatedThrough: client.sequence,
    needsAttention: needsAttention({ workItems: state.workItems, memberId: session.member.id, now }),
    workInvolvingMe: workInvolvingMe({ workItems: state.workItems, memberId: session.member.id }) } : null;
  const unread = state ? Math.max(0, client.sequence - roomCursor) : 0;
  const contributions = owned ? contributionSteps(state, session.member.id, now) : [];
  renderContribution(contributions, owned);
  setText("#catchup-count", current ? briefView.message === "Updating room…" ? "Updating…" : [contributions.length ? `${contributions.length} need${contributions.length === 1 ? "s" : ""} you` : "",
    unread ? `${unread} update${unread === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "No new updates" : "");
  if (owned) {
    // Work destinations and catch-up use the same clock, even without new events.
    renderSearch(now);
    const items = Object.values(state.workItems);
    const draftsByWork = new Map();
    for (let index = state.messages.length - 1; index >= 0; index--) {
      const message = state.messages[index];
      if (!message.workItemId || !message.proposal) continue;
      if (!draftsByWork.has(message.workItemId)) draftsByWork.set(message.workItemId, []);
      draftsByWork.get(message.workItemId).push(message);
    }
    renderContent("#work-list", items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(i => workCard(i, now, draftsByWork.get(i.id) ?? [])).join("") || `<p class="empty-note">${can("steer") ? 'Turn a message into work, or start something new. <button type="button" class="text-button" data-empty-work>Start work</button>' : 'Suggest work in the conversation. The owner can create it. <button type="button" class="text-button" data-empty-suggest>Write a suggestion</button>'}</p>`);
    const resultFocus = $("#room-results-list").contains(document.activeElement) ? document.activeElement : null;
    renderContent("#room-results-list", completedResults(state).map(resultRow).join("") || '<p class="empty-note">Completed results appear here after work is finished.</p>');
    if (resultFocus && !resultFocus.isConnected && document.activeElement === document.body) $("#work-view-results").focus({ preventScroll: true });
    resultStatus();
    syncActionForm();
    const expiry = items.flatMap(item => [item.claim?.status === "active" ? Date.parse(item.claim.expiresAt) : NaN,
      ...(item.helpWanted?.status === "open" ? [Date.parse(item.helpWanted.openedAt), Date.parse(item.helpWanted.expiresAt)] : [])]).filter(at => at > now).sort((a, b) => a - b)[0];
    if (expiry && document.visibilityState !== "hidden") returnClock = setTimeout(renderReturnBrief, Math.max(100, Math.min(60000, expiry - now)));
  }
  const newer = returnBrief && client.sequence > returnBrief.history.evaluatedThrough;
  setText("#rb-status", owned ? briefView.message || (newer ? "New changes available. Refresh catch-up." : "") : "");
  $("#rb-refresh-button").disabled = !owned || briefView.busy;
  $("#return-brief-panel").setAttribute("aria-busy", briefView.busy ? "true" : "false");
  $("#rb-more-button").disabled = briefView.busy;
  $("#rb-ack-button").disabled = true;
  delete $("#rb-ack-button").dataset.horizon;
  $("#rb-more-button").hidden = true;
  const attention = current?.needsAttention ?? [];
  const byWork = new Map(contributions.filter(step => step.kind === "work").map(step => [step.id, step]));
  // Preserve the established catch-up order while the single next-step suggestion
  // prioritizes handoffs. Updating work must not move it out of the first page.
  const attentionIds = new Set(attention.map(item => item.workItemId));
  const attentionSteps = [...attention.map(item => byWork.get(item.workItemId)).filter(Boolean),
    ...contributions.filter(step => step.kind === "request" || !attentionIds.has(step.id))];
  const allButton = $("#rb-show-all"), allFocused = document.activeElement === allButton;
  if (contributions.length <= 5) showAllAttention = false;
  allButton.hidden = contributions.length <= 5;
  allButton.textContent = showAllAttention ? "Show less" : `Show all (${contributions.length})`;
  allButton.setAttribute("aria-expanded", String(showAllAttention));
  if (allFocused && allButton.hidden) $("#return-brief-panel > summary").focus({ preventScroll: true });
  renderBriefList("#rb-attention-list", (showAllAttention ? attentionSteps : attentionSteps.slice(0, 5)).map(i => {
    const messageId = i.draftCount > 1 ? null : i.draftMessageId ?? (i.kind === "request" ? i.id : null);
    const href = messageId ? recordHref("message", messageId) : workHref(i.id);
    const target = messageId ? `data-open-message="${esc(messageId)}"` : `data-open-work="${esc(i.id)}"${i.draftCount > 1 ? ' data-view-drafts' : ''}`;
    const label = messageId || i.draftCount > 1 ? i.label : nextWorkStep(state.workItems[i.id], now).label;
    return `<li class="rb-event"><a class="work-link" href="${esc(href)}" ${target} data-brief-key="${esc(i.kind === "work" ? `attention:${i.id}` : i.key)}">${esc(i.title)}</a> <span class="rb-detail">${esc(label)}</span></li>`;
  }).join("")
    || (current ? '<li class="rb-empty">Nothing waiting for you.</li>' : ""));
  for (const workId of byWork.keys()) attentionIds.add(workId);
  renderBriefList("#rb-involving-list", (current?.workInvolvingMe ?? []).filter(i => !attentionIds.has(i.workItemId)).map(i =>
    `<li class="rb-event"><a class="work-link" href="${esc(workHref(i.workItemId))}" data-open-work="${esc(i.workItemId)}" data-brief-key="involving:${esc(i.workItemId)}">${esc(i.action ?? i.workItemId)}</a> <span class="rb-detail">${esc(i.roles.map(roleLabel).join(", "))} · ${esc(i.state)}</span></li>`).join("")
    || (current ? '<li class="rb-empty">No other open work.</li>' : ""));
  setText("#rb-current-boundary", current ? `Current work as of event ${current.evaluatedThrough}` : "");
  if (!returnBrief || !owned) {
    setText("#rb-ack-note", "");
    for (const id of ["summary-grid", "rb-history-boundary", "rb-history-count", "rb-history-list"]) $(`#${id}`).replaceChildren();
    delete $("#rb-history-list")._content;
    $("#rb-ack-button").textContent = briefView.reconciliationRequired ? "Refresh brief before acknowledging" : "Mark caught up";
    return;
  }
  const { history } = returnBrief;
  const changes = history.evaluatedThrough - history.cursor;
  setText("#rb-ack-note", changes ? `Marks all ${changes} update${changes === 1 ? "" : "s"} read. Work stays open.` : "Work stays open.");
  setText("#summary-grid", `${changes} ${changes === 1 ? "change" : "changes"} since your marker · ${contributions.length} to act on`);
  setText("#rb-history-count", changes ? `(${changes})` : "");
  $("#rb-history-boundary").textContent = history.evaluatedThrough === history.cursor
    ? "· nothing new since your marker"
    : `${history.items.length} of ${changes} events · through ${history.evaluatedThrough}`;
  renderBriefList("#rb-history-list", history.items.map(describeBriefEvent).join("")
    || '<li class="rb-empty">Nothing new since your marker.</li>');
  $("#rb-more-button").hidden = !history.hasMore;
  $("#rb-ack-button").textContent = history.evaluatedThrough === history.cursor ? "Already caught up" : "Mark caught up";
  $("#rb-ack-button").dataset.horizon = String(history.evaluatedThrough);
  $("#rb-ack-button").setAttribute("aria-describedby", "rb-ack-note rb-history-boundary");
  $("#rb-ack-button").disabled = briefView.busy || history.evaluatedThrough === history.cursor;
}
$("#return-brief-panel").addEventListener("toggle", e => {
  if (e.currentTarget.open && state) loadReturnBrief(); // reopening replaces the pagination chain
});
$("#room-navigation").addEventListener("click", e => {
  const section = e.target.closest("[data-room-section]")?.dataset.roomSection;
  if (!section || !state || busy) return;
  saveComposer();
  if (section === "catch-up") {
    const panel = $("#return-brief-panel");
    if (panel.open) loadReturnBrief();
    else panel.open = true;
    focusRecord($("#return-brief-panel > summary"));
  } else if (section === "people") {
    $("#people-panel").open = true;
    focusRecord($("#people-panel > summary"));
  } else focusRecord($(section === "work" ? "#work-title" : "#conversation-title"));
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
$("#rb-show-all").addEventListener("click", () => { showAllAttention = !showAllAttention; renderReturnBrief(); });
document.addEventListener("visibilitychange", renderReturnBrief);
shareLinksUI = installShareLinks({ client, accountClient, getState: () => state, getSession: () => session, setConnectionStatus,
  async openRoom(roomId, roomMode, joinedSession) {
    if (state && session?.roomId === roomId && session.member.id === joinedSession?.member?.id
      && session.account?.id === joinedSession.account?.id && session.sessionBinding === joinedSession.sessionBinding) {
      await client.refresh();
      if (!state || !session) throw new Error("Room access changed. Reopen the invitation.");
      return;
    }
    accessEndContext = "accepted-room-switch";
    client.endAccess();
    history.replaceState(history.state, "", roomMode ? location.pathname : `${location.pathname}?room=${encodeURIComponent(roomId)}`);
    configureAuthPanel(roomMode ? null : roomId);
    const restored = await client.restore(roomMode ? null : roomId);
    if (!restored) throw new Error("Browser identity changed. Reopen the invitation.");
    inboxUI.showRooms();
  }
});
configureAuthPanel();
if (initialInvitationFragment) openInvitation(initialInvitationFragment);
(async () => {
  if (initialJoinFragment) {
    // Invitation preview deliberately does not restore/open a Room session.
    // Do not leave the initial session/connection progress labels running.
    $("#identity-label").textContent = "Room not open";
    setConnectionStatus("Not connected · invitation preview");
    await shareLinksUI.open(initialJoinFragment); return;
  }
  const requestedRoom = selectedRoomFromLocation();
  if (requestedRoom || accountHomeFromLocation()) {
    const account = await ensureAccountSession();
    if (!account?.authenticated) {
      authKind = "account";
      $("#identity-label").textContent = "Not signed in";
      setFormStatus($("#auth-error"), "");
      setConnectionStatus("Not connected · account sign-in required");
      configureAuthPanel();
      $("#auth-panel").hidden = false;
      if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
      return;
    }
    if (!requestedRoom) showAccountWorkspace();
    else await client.restore(requestedRoom);
    return;
  }
  await client.restore();
})().catch(error => {
  if (accountClient.session?.authenticated && [401, 403].includes(error.status)) {
    showAccountWorkspace(); confirmAccount(); return;
  }
  const signedOut = [401, 403].includes(error.status);
  if (signedOut) recovery.clear();
  const requestedRoom = selectedRoomFromLocation();
  setFormStatus($("#auth-error"), signedOut
    ? requestedRoom ? `This account cannot open #${requestedRoom}. Use an account with active membership there.` : ""
    : "Can’t reach the room. Try refreshing.", true);
  setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
  $("#identity-label").textContent = signedOut ? "Not signed in" : "Session unavailable";
  $("#auth-panel").hidden = false;
  if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
});
