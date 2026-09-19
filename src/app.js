import { EVENT_TYPES as T, WORK_STATES as S, roomPolicy, roomKind, isRoomArchived, spendAllowance, pinnedMessages, isPinned, PIN_LIMIT, isMutedBy, channelList, messageChannelId, DEFAULT_CHANNEL_ID } from "./events.js";
import { AccountClient, RoomClient, draftCommand, retryUnconfirmed } from "./client.js";
import { ReturnBrief, groupBriefHistory } from "./return-brief.js";
import { needsAttention, workInvolvingMe, contributionSteps, searchWork, draftFeedback, completedResults, currentResult } from "./work-selectors.js";
import { REACTIONS, conversationIndex, searchMessages, ConversationDrafts, DraftRecovery, draftRecoveryScope, sendsOnEnter, escapeChatAction, messageCluster, mentionQuery, mentionMatches, mentionHtml, kindLabel, memberStatus, memberHandle, memberPresence, memberDoneChip, presenceLabel, addressMember, shouldAddressPresenceClick, messageMentionsMember, replyAuthorToAddress, composerPlaceholder, removeMention, parseSearchQuery, reactionPills } from "./conversation.js";
import { nextWorkStep, workStatus, workActions, activeClaim, terminalWork, doneChip, reusableWorkDefinition, confirmsWorkProposal, confirmsWorkAction, matchesReceipt, producerKnown as hasReportedProducer, changeDescription, diffResultLines, diffResultSummary, workRecipeOptions } from "./workflow.js";
import { coordinationLoops } from "./work-loops.js";
import { RECIPE_CATALOG, activeRecipes, previewAllRecipes } from "./work-recipes.js";
import { attemptReceipts, attemptLedger, cancellationState, spendLedger } from "./work-item-session.js";
import { consumeJoinFragment, installShareLinks, canRetryInvitation, requestFailureMessage } from "./share-links.js";
import { shareJoinSecretFromText } from "./share-invite-code.js";
import { installAgentConnections } from "./agent-connections.js";
import { catalogById } from "./room-roster.js";
import { installRoomInstructions } from "./room-instructions.js";
import { installReminders } from "./reminders.js";
import { installPortableWork, installResultCopy } from "./portable-work.js";
import { replyDraftKey, replyDraftData, validReplyDraft, creditQuestion, confirmsReplyCommand, REPLY_CANCELLED } from "./reply-requests.js";
import { workHelpContext, validateHelpData } from "./work-help.js";
import { workOffersContext, validateHelpOfferData } from "./help-offers.js";
import { installInbox } from "./inbox-ui.js";
import { createAccountSettingsUI } from "./account-settings-ui.js";
import { createAuthSigninUI } from "./auth-signin-ui.js";
import { stashPendingInvite, clearPendingInvite, takeRestoredInvite } from "./invite-context.js";
import { selectedRoomFromLocation as roomFromLocation, roomIdFromHash, authPanelTitle, KEY_KIND_HINT } from "./room-deep-link.js";
import { installAgentInvites } from "./agent-invite-ui.js";
import { rememberLastRoom, rememberAccountHint, readLastRoom, readLastRoomTitle, readAccountHint, hasSessionHint, clearBrowserSessionHints, SESSION_HINT_COPY } from "./browser-session.js";

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
function consumeInvitationFragment() {
  if (!location.hash.startsWith("#invite/")) return null;
  const candidate = location.hash.slice("#invite/".length);
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return invitationTokenPattern.test(candidate)
    ? { valid: true, secret: candidate }
    : { valid: false, secret: null };
}
function selectedRoomFromLocation() {
  return roomFromLocation({ search: location.search, hash: location.hash });
}
function accountHomeFromLocation() {
  const values = new URLSearchParams(location.search).getAll("account");
  return values.length === 1 && values[0] === "1";
}
// One-shot signal from the Google OAuth callback: the flow genuinely failed
// (denied consent, bad state). Read and stripped before boot runs so the
// failure surfaces exactly once, as an auth-panel message, never as a
// silent bounce back to the login form.
function googleErrorFromLocation() {
  const values = new URLSearchParams(location.search).getAll("google");
  return values.length === 1 && values[0] === "error";
}
const initialGoogleFailed = googleErrorFromLocation();
if (initialGoogleFailed) {
  const url = new URL(location.href);
  url.searchParams.delete("google");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
// GitHub OAuth callback errors land here (slice 7); the param is stripped
// immediately so a refresh does not replay the failure message.
function githubErrorFromLocation() {
  const values = new URLSearchParams(location.search).getAll("github");
  return values.length === 1 && values[0] === "error";
}
const initialGitHubFailed = githubErrorFromLocation();
if (initialGitHubFailed) {
  const url = new URL(location.href);
  url.searchParams.delete("github");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
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
// A Google/GitHub OAuth round-trip drops the #invite/ fragment (it never
// reaches the server). Restore a stashed invitation one-shot when landing
// without a room context, so the dialog re-opens after OAuth sign-in.
const initialInvitationFragment = consumeInvitationFragment()
  || takeRestoredInvite({ storage: window.sessionStorage, hash: location.hash, search: location.search });
// Stash the live invitation secret at the exact moment an OAuth navigation
// starts. The #invite/ fragment never reaches the server, so without this
// the Google/GitHub round-trip would drop the invitation. The secret touches
// sessionStorage only for the round-trip (cleared on dialog close/accept and
// consumed one-shot at boot); merely previewing an invitation never stores it.
function stashInviteForOAuth() {
  if (invitation.secret) stashPendingInvite(window.sessionStorage, invitation.secret);
}
// The Google entry point is a plain anchor: stash a live invitation before
// the navigation, since the OAuth round-trip drops the #invite/ fragment.
{ const googleButton = $("#google-signin");
  if (googleButton) googleButton.addEventListener("click", stashInviteForOAuth); }
let shareLinksUI = null;
let portableWorkUI = null;
let resultCopyUI = null;
let remindersUI = null;
let agentConnectionsUI = null;
let agentInvitesUI = null;
let instructionsUI = null;
let inboxUI = null;
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
// Phase 2 channels: the visible channel; persisted per room, defaults to the main channel.
let activeChannelId = DEFAULT_CHANNEL_ID, activeChannelRoomId = null;
let workDraftId = null, replyToId = null, busy = false;
let workFormEpoch = 0, workRetryLocked = false;
let actionEpoch = 0;
let offerContextVersion = null;
let currentThreadId = null, conversation = null, drafts = new ConversationDrafts();
let requestMode = null, requestReading = false, requestEpoch = 0;
const composerKey = () => replyDraftKey(requestMode, currentThreadId);
const viewPositions = new Map(), pendingReactions = new Map(), pendingPins = new Set(), locallyOwnedMessageIds = new Set();
let newVisibleMessages = 0, unreadAnchorId = null, mentionIndex = 0;
let roomCursor = 0, roomGeneration = -1, showAllAttention = false, returnClock = null;
let signoutOperationId = 0, signoutLoading = false;
let refreshOperationId = 0, submitOperationId = 0;
let submitControls = null, noticeTimer = null, noticeVersion = 0, workFormOpener = null;
let accessEndContext = null;
let lastComposerSelection = null;
let lastInvitationOpener = null;
let roomActionsContext = null;
// C6: owner-facing agent controls. agentPauses is the owner's last-read paused
// roster (memberId -> { pausedAt, reason }); armedRemoval is the one agent whose
// Remove button is waiting for its confirming second click.
let agentPauses = new Map(), armedRemoval = null, memberActionBusy = false;
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
    if (roomId !== activeChannelRoomId) { activeChannelRoomId = roomId; restoreActiveChannel(); }
    $("#room-title").textContent = state.room?.title ?? roomId;
    $(".room-purpose").textContent = state.room?.purpose ?? "";
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#auth-panel").setAttribute("aria-busy", "false");
    $("#account-rooms-panel").hidden = true;
    $(".connection-bar").hidden = false;
    $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
    $("#account-settings-button").hidden = false;
    syncSessionMenu();
    $("#identity-label").textContent = displayName(session.member.id);
    $("#identity-label").title = `${memberLabel(session.member.id)} · ${kindLabel(session.member.kind)}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
    syncRoomLifecycle();
    shareLinksUI?.sync();
    remindersUI?.sync();
    syncNotifications();
    agentConnectionsUI?.sync();
    agentInvitesUI?.sync();
    updatePeopleHint();
    if (firstSnapshot) {
      rememberLastRoom(roomId, undefined, state.room?.title);
      showRoomGuide();
    }
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
    accessPreviews.clear();
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
    resetNotifications();
    agentConnectionsUI?.reset();
    agentInvitesUI?.reset();
    instructionsUI?.reset();
    if (!keepAccount) {
      clearPrivateWorkspace({ preservePending: leavingPage });
      if (pendingSignout || endedContext === "account-switch") clearBrowserSessionHints();
    }
    else inboxUI?.detachRoom();
    workDraftId = null; replyToId = null; workFormEpoch++; setWorkRetry(false);
    syncRoomLifecycle();
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
    $("#account-settings-button").hidden = true;
    syncSessionMenu();
    $("#auth-panel").setAttribute("aria-busy", pendingSignout ? "true" : "false");
    $("#identity-label").textContent = "Not signed in";
    $("#identity-label").removeAttribute("title");
    for (const id of ["message-list", "event-list", "presence-list", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "message-count", "event-count", "rb-attention-list", "rb-involving-list", "rb-history-list", "decision-list", "usage-grid", "usage-period", "usage-status", "record-export-status"]) {
      const node = $(`#${id}`); node.replaceChildren(); delete node._content;
    }
    $("#usage-refresh").hidden = true; $("#record-export-html").disabled = false; exportRequest += 1;
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) {
      if (!keepAccount || !form.closest("#inbox-panel")) form.reset();
    }
    $("#work-dialog").close();
    if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
    for (const id of ["people-panel", "composer-options", "work-options", "room-about", "connection-details", "rb-history-section", "rb-involving-section", "decision-section", "usage-panel"]) $(`#${id}`).open = false;
    if ($("#room-guide")) $("#room-guide").hidden = true;
    if ($("#people-hint")) $("#people-hint").textContent = "";
    agentPauses = new Map(); armedRemoval = null;
    for (const control of document.querySelectorAll("#auth-form input, #auth-form button")) control.disabled = pendingSignout;
    setFormStatus($("#new-work-status"), ""); setFormStatus($("#action-error"), ""); setFormStatus($("#composer-status"), "");
    $("#action-dialog").close(); $("#new-work-form").hidden = true; $("#reply-bar").hidden = true;
    for (const id of ["review-criteria", "review-summary", "review-next", "decision-review-label", "decision-review-by", "decision-review-text", "decision-review-version"]) setText(`#${id}`, "");
    $("#review-brief").hidden = true; $("#review-notes").open = false;
    $("#decision-review").hidden = true; $("#decision-review").open = false;
    $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = "";
    $("#thread-title").textContent = ""; $("#thread-context").textContent = "";
    $("#thread-bar").hidden = true; $("#search-results").hidden = true; $("#new-messages-button").hidden = true;
    $("#search-mentions")?.setAttribute("aria-pressed", "false"); $("#search-pinned")?.setAttribute("aria-pressed", "false"); $("#message-search").value = ""; $("#clear-search").hidden = true;
    $("#conversation-announcement").textContent = ""; delete $("#message-list").dataset.view;
    for (const id of ["rb-attention-list", "rb-involving-list", "rb-history-list"]) delete $(`#${id}`)._content;
    $("#rb-current-boundary").textContent = ""; $("#rb-history-boundary").textContent = ""; $("#decision-count").textContent = "";
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
agentInvitesUI = installAgentInvites({ client, getState: () => state, getSession: () => session });
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
// Account-session restore flight: declared before the sign-in UI mounts.
// The magic-link auto-redeem runs synchronously during mount (page load
// with ?magic=), so ensureAccountSession must not sit in the temporal dead
// zone below — a TDZ ReferenceError here silently broke one-tap sign-in
// (RC-2026-09-19-066): the redeem failed before any network call and the
// user was left on the welcome screen.
let accountRestoreFlight = null;
function ensureAccountSession() {
  if (accountClient.session) return Promise.resolve(accountClient.session);
  if (accountRestoreFlight) return accountRestoreFlight;
  accountRestoreFlight = accountClient.restore().finally(() => { accountRestoreFlight = null; });
  return accountRestoreFlight;
}
// Sign-in & security settings (slice 7): mounted inside the account rooms
// panel's <details>, opened from the session menu.
const accountSettingsUI = createAccountSettingsUI({ accountClient });
// Multi-method sign-in / create-account (slice 7): mounts into the auth
// panel next to the Google button and the room/account key forms. After a
// browser sign-in the cookie changed, so restore the in-memory session and
// route the same way the account-key flow does.
const signinUI = createAuthSigninUI({
  accountClient,
  ensureAccountSession,
  onOAuthStart: stashInviteForOAuth,
  // QAX-002: the module's own status line lives inside the collapsed "More
  // options" panel, so mirror a failed magic-link redemption where first
  // paint can see it — above the sign-in panel, not behind the toggle.
  onMagicLinkFailure: message => {
    setFormStatus($("#auth-link-error"),
      `${message} Request a new link with More options below, or sign in another way.`, true);
  },
  onSignedIn: async () => {
    await accountClient.restore();
    const requestedRoom = selectedRoomFromLocation();
    if (!requestedRoom) { showAccountWorkspace(); return; }
    const identity = await client.restore(requestedRoom);
    if (!identity || !state || session?.member.id !== identity.member.id || session?.roomId !== identity.roomId) return;
    $("#message-input").focus();
    if (state) revealLocationHash();
  }
});
signinUI.mount($("#auth-signin-ui"));
if ($("#session-hint")) $("#session-hint").textContent = SESSION_HINT_COPY;
function openAccountSettings() {
  setSessionMenuOpen(false);
  if (!accountClient.session?.authenticated) return;
  inboxUI.showRoomList();
  const details = $("#account-settings");
  details.open = true;
  accountSettingsUI.mount($("#account-settings-body"));
  details.scrollIntoView({ block: "nearest" });
}
function clearPrivateWorkspace(options) {
  inboxUI?.reset(options); roomListVersion++;
  $("#account-rooms-list").replaceChildren(); $("#account-rooms-status").textContent = "";
  $("#account-status").textContent = ""; $("#account-status").hidden = true;
  $("#account-settings").open = false; $("#account-settings-body").replaceChildren();
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
  rememberAccountHint();
  $("#auth-panel").hidden = true; $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
  $("#account-settings-button").hidden = false;
  syncSessionMenu();
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
      // Issue #6 A2: an archived room is never presented as a working room; it
      // opens read only (reading and export stay) and says so before the click.
      const archived = room.archived === true;
      button.dataset.roomArchived = archived ? "true" : "false";
      const title = typeof room.title === "string" ? room.title.trim() : "";
      const named = title && title !== room.id;
      const heading = document.createElement("strong");
      heading.textContent = named ? title : room.id;
      const meta = document.createElement("small");
      meta.className = "inbox-row-kind";
      meta.textContent = roomKindLabel(room.kind) + (archived ? " · Archived" : "");
      const action = document.createElement("span");
      action.textContent = archived ? "Read only" : "Open";
      button.append(heading, meta, action);
      button.setAttribute("aria-label", `${archived ? "Read archived room" : "Open"} ${named ? title : room.id}`);
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
// Issue #6 A2: room lifecycle — create (account home), archive (owner), leave (member).
const roomKindLabel = kind => (kind === "organization" ? "Organization" : "Personal");
function syncRoomLifecycle() {
  const room = state?.room ?? null, viewer = state && session ? state.members[session.member.id] : null;
  const archived = Boolean(state) && isRoomArchived(state);
  const badge = $("#room-kind-badge");
  badge.textContent = room ? roomKindLabel(roomKind(room)) : ""; badge.hidden = !room;
  const note = $("#room-archived-note");
  note.hidden = !archived;
  note.textContent = archived ? `Archived ${new Date(room.archivedAt).toLocaleString()}${room.archivedById ? ` by ${displayName(room.archivedById)}` : ""} · read only. Reading and export stay available; nothing new is recorded.` : "";
  $("#main").classList.toggle("room-archived", archived); // The composer and New work follow in syncRequestComposer and render.
  const owner = Boolean(viewer) && viewer.kind === "human" && viewer.id === room?.ownerId;
  $("#room-archive-button").hidden = !viewer || archived || !owner;
  $("#room-leave-button").hidden = !viewer || archived || owner || viewer.kind !== "human";
}
$("#room-archive-button").addEventListener("click", async () => {
  if (!state || !session || busy) return;
  if (!window.confirm("Archive this room? Everyone keeps reading and export; nothing new can be recorded, and this cannot be undone here.")) return;
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id, button = $("#room-archive-button");
  button.disabled = true;
  try {
    await client.send({ id: crypto.randomUUID(), type: T.ROOM_ARCHIVED, data: {} });
    if (sameSession(generation, roomId, memberId)) notice("Room archived. It is read only now; export stays available.");
  } catch (error) {
    if (!sameSession(generation, roomId, memberId)) return;
    notice(error.code === "room_archived" ? "This room is already archived." : "Couldn’t archive the room. Refresh and try again.", true);
  } finally { button.disabled = false; }
});
$("#room-leave-button").addEventListener("click", async () => {
  if (!state || !session || busy) return;
  const member = state.members[session.member.id];
  if (!member || member.active === false) return;
  if (!window.confirm("Leave this room? You lose access to it and need a new invitation to return. Your messages stay in the room.")) return;
  const generation = client.generation, roomId = session.roomId, button = $("#room-leave-button");
  button.disabled = true;
  try {
    await client.send({ id: crypto.randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
      data: { memberId: member.id, expectedMemberRevision: member.revision, permissions: [...member.permissions], active: false } });
  } catch (error) {
    if (!sameSession(generation, roomId, member.id)) return;
    notice(error.code === "room_archived" ? "This room is archived; leaving is not recorded." : "Couldn’t leave the room. Refresh and try again.", true);
  } finally { button.disabled = false; }
});
$("#account-room-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = $("#account-room-form"), status = $("#account-room-status"), owned = accountClient.session;
  if (!owned?.authenticated || form.dataset.busy === "true" || invitationIsCommitting() || signoutLoading) return;
  const title = $("#account-room-title").value.trim(), purpose = $("#account-room-purpose").value.trim(), displayName = $("#account-room-name").value.trim();
  const kind = $("#account-room-kind").value;
  if (!title || !purpose || !displayName) { setFormStatus(status, "Room name, purpose and your name are required.", true); return; }
  // One id per attempt: a retry after a lost response finds the same room instead of creating a twin.
  const roomId = form.dataset.roomId || (form.dataset.roomId = "room-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12));
  form.dataset.busy = "true"; $("#account-room-submit").disabled = true; setFormStatus(status, "Creating…");
  try {
    const session = accountClient.currentSession("creating a room", { authenticated: true });
    const result = await accountClient.request("/api/account-rooms", { method: "POST", data: { roomId, title, purpose, kind, displayName }, session });
    if (accountClient.session !== owned) return;
    delete form.dataset.roomId; form.reset(); setFormStatus(status, ""); $("#account-room-create").open = false;
    await openAccountRoom(result.room.id);
  } catch (error) {
    if (accountClient.session !== owned) return;
    if (error.status === 401 || ["session_binding_changed", "account_session_required"].includes(error.code)) { endAccountAccess(); return; }
    if (error.code === "room_exists") delete form.dataset.roomId; // A lost response created it under another shape; the next attempt gets a fresh id.
    setFormStatus(status, error.code === "room_creation_denied" ? "Your first room is free to create, but more rooms need membership administration in one of your rooms."
      : error.code === "room_exists" ? "A room with that id already exists. Choose Rooms to refresh, then try again."
      : error.status === 429 ? "Too many rooms just now. Try again in a minute."
        : error.status === 422 ? "Check the room name, purpose and your name." : "Couldn’t create the room. Try again.", true);
  } finally { delete form.dataset.busy; $("#account-room-submit").disabled = false; }
});
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
const noticeText = () => $("#status").querySelector(".status-text")?.textContent ?? $("#status").textContent;
function resetNotice(status) {
  status.replaceChildren();
  status.classList.remove("visible", "error");
  // One live region: polite status for successes, alert for errors (set before text lands).
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
}
function clearNotice() {
  noticeVersion += 1;
  clearTimeout(noticeTimer);
  noticeTimer = null;
  resetNotice($("#status"));
}
function notice(text, error = false) {
  const status = $("#status"), version = ++noticeVersion;
  clearTimeout(noticeTimer); noticeTimer = null;
  const show = () => {
    if (version !== noticeVersion) return;
    status.setAttribute("role", error ? "alert" : "status");
    status.setAttribute("aria-live", error ? "assertive" : "polite");
    const body = document.createElement("span");
    body.className = "status-text"; body.textContent = text;
    status.replaceChildren(body);
    if (error) {
      // Errors stay until dismissed or replaced so they can be read, selected and copied.
      const dismiss = document.createElement("button");
      dismiss.type = "button"; dismiss.className = "status-dismiss";
      dismiss.textContent = "Dismiss"; dismiss.setAttribute("aria-label", "Dismiss error");
      dismiss.addEventListener("click", () => { if (version === noticeVersion) clearNotice(); });
      status.append(dismiss);
    }
    status.classList.add("visible");
    status.classList.toggle("error", error);
    if (!error) noticeTimer = setTimeout(() => { if (version === noticeVersion) resetNotice(status); }, 6000);
  };
  // Repeated successful actions still deserve one fresh status announcement each.
  if (noticeText() === text) { status.replaceChildren(); queueMicrotask(show); }
  else show();
}
function handleFailureNotice(error) {
  client.handleFailure(error);
  if (state) notice(requestFailureMessage(error), true);
}
// Signed-out load failures: a service outage (5xx) reads differently from a
// browser that cannot reach the service at all (network error, no status).
function unreachableRoomMessage(error) {
  return error?.status >= 500 ? "The room service is unavailable right now. Try refreshing in a moment."
    : "Can’t reach the room. Check your connection, then try refreshing.";
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
function roomHandoffLocation(roomId) {
  // In-app navigation keeps the historical ?room= contract. Door Open/People
  // already attach both ?room= and #room/ so hash-dropping browsers survive.
  return `${location.pathname}?room=${encodeURIComponent(roomId)}`;
}
function configureAuthPanel(roomId = selectedRoomFromLocation()) {
  const accountMode = accountSignIn();
  const roomTitle = readLastRoomTitle(roomId);
  $("#auth-title").textContent = authPanelTitle(roomId, roomTitle);
  // Fresh auth paint clears any stale magic-link failure banner (QAX-002).
  setFormStatus($("#auth-link-error"), "");
  const roomHint = $("#auth-room-hint");
  if (roomHint) {
    roomHint.hidden = true;
    roomHint.textContent = "";
  }
  if ($("#auth-kind-hint")) $("#auth-kind-hint").textContent = KEY_KIND_HINT;
  $("#access-key-label").textContent = accountMode ? "Account key" : "Room key";
  $("#auth-kind-room")?.setAttribute("aria-pressed", accountMode ? "false" : "true");
  $("#auth-kind-account")?.setAttribute("aria-pressed", accountMode ? "true" : "false");
  $("#auth-kind-room")?.classList.toggle("suggested", Boolean(accountMode && roomId));
  $("#auth-form button[type='submit']").textContent = accountMode ? (roomId ? "Open room" : "Sign in") : "Enter room";
  // OAuth invite stash lands on #invite/<43-char>. Keep first paint collapsed otherwise.
  if (typeof location !== "undefined" && location.hash.startsWith("#invite/")) setSigninExtra(true);
  syncSessionRestore();
  syncSessionMenu();
}
function syncSessionRestore() {
  const lastRoom = readLastRoom();
  const account = Boolean(accountClient.session?.authenticated);
  const panel = $("#session-restore");
  if (panel) panel.hidden = !lastRoom && !account;
  const reopen = $("#reopen-last-room");
  if (reopen) {
    reopen.hidden = !lastRoom;
    const title = readLastRoomTitle(lastRoom);
    reopen.textContent = lastRoom ? `Reopen ${title || `#${lastRoom}`}` : "Reopen last room";
  }
  const cont = $("#continue-account");
  if (cont) cont.hidden = !account;
  syncSessionMenu();
}
function syncSessionMenu() {
  const menu = $("#session-menu");
  const signedIn = Boolean(state || accountClient.session?.authenticated);
  const leftovers = Boolean(readLastRoom() || readAccountHint());
  const clearBtn = $("#clear-session-menu");
  if (clearBtn) clearBtn.hidden = signedIn || !leftovers;
  menu?.classList.toggle("empty", !signedIn && !leftovers);
}
async function reopenRememberedRoom() {
  const lastRoom = readLastRoom();
  if (!lastRoom || signoutLoading || busy) return;
  setFormStatus($("#auth-error"), "");
  try {
    const account = await ensureAccountSession().catch(() => null);
    if (account?.authenticated) {
      history.replaceState(history.state, "", roomHandoffLocation(lastRoom));
      configureAuthPanel(lastRoom);
      await client.restore(lastRoom);
      return;
    }
    await client.restore();
  } catch (error) {
    setFormStatus($("#auth-error"), [401, 403].includes(error.status)
      ? `This browser could not reopen #${lastRoom}. Sign in again.`
      : unreachableRoomMessage(error), true);
    syncSessionRestore();
  }
}
async function continueAccountSession() {
  if (signoutLoading || busy) return;
  try {
    const account = await ensureAccountSession();
    if (account?.authenticated) showAccountWorkspace();
    else setFormStatus($("#auth-error"), "Sign in to continue to your rooms.", true);
  } catch (error) {
    setFormStatus($("#auth-error"), [401, 403].includes(error.status)
      ? "Sign in to continue to your rooms."
      : unreachableRoomMessage(error), true);
  }
  syncSessionRestore();
}
async function clearSavedBrowserSession() {
  if (signoutLoading || busy) return;
  clearBrowserSessionHints();
  if (accountClient.session) {
    try { await accountClient.logout(); } catch { /* slot may already be anonymous */ }
    endAccountAccess();
  }
  syncSessionRestore();
  setFormStatus($("#auth-error"), "Saved session on this browser was cleared.", true);
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
  if (hint) hint.textContent = "your Second / their agents / one Room. @mention uses Connect Wake/Pull once Quill's RC-051 lands. Agent handles stay loud. Done lands as a receipt. Create your Room (bootstrap-agent-room / POST /room/api/agent-rooms), then invite peers. Invite a person: they Open this invite link. Agents use an invite-code (RM-).";
}
function dismissRoomGuide() {
  if ($("#room-guide")) $("#room-guide").hidden = true;
  try { sessionStorage.setItem("pr-guide-dismissed", "1"); } catch {}
}
function showRoomGuide() {
  const guide = $("#room-guide");
  if (!guide) return;
  try { if (sessionStorage.getItem("pr-guide-dismissed") === "1") { guide.hidden = true; return; } } catch {}
  if (state?.messages?.length) { dismissRoomGuide(); return; }
  guide.hidden = false;
}
function syncComposerChrome() {
  const to = $("#message-to-select")?.value;
  const bar = $("#composer-toolbar");
  if (bar) bar.hidden = !to && !requestMode;
  const note = $("#audience-note");
  if (note) {
    // RC-2026-09-19-070: a message addressed to one member is private to the
    // two parties — say so truthfully where the sender picks the recipient.
    const recipient = to && state?.members?.[to] ? state.members[to].displayName : null;
    if (recipient) {
      note.textContent = `Private — only you and ${recipient} can see this message.`;
      note.hidden = false;
    } else note.hidden = true;
  }
  const work = $("#composer-work-button");
  if (work) work.hidden = true;
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
    const counts = preview.memberCounts;
    $("#invitation-members").textContent = counts
      ? `${counts.humans} human${counts.humans === 1 ? "" : "s"} · ${counts.agents} agent${counts.agents === 1 ? "" : "s"}`
      : "Not shown";
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
  // Onboarding Slice 4: name the acting account so nobody accepts from the
  // wrong account. The app calls an account session "Personal account".
  const actingName = authenticated ? "Personal account" : null;
  const actingLine = $("#invitation-acting-account");
  actingLine.hidden = !(actingName && preview && phase !== "terminal");
  if (actingName && preview && phase !== "terminal") actingLine.textContent = `You’ll join as ${actingName}.`;
  action.textContent = accepted
    ? (actingName ? `Open room as ${actingName}` : "Open room")
    : phase === "unknown" ? "Check acceptance again"
    : actingName ? `Accept and open as ${actingName}` : "Accept and open room";
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
  clearPendingInvite(window.sessionStorage);
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
  clearPendingInvite(window.sessionStorage);
  renderInvitation();
  setInvitationFeedback("");
  $("#invitation-dialog").close();
  $("#connection-status").setAttribute("aria-live", "polite");
  $("#invitation-account-form").reset();
  accessEndContext = acceptanceConfirmed ? "accepted-room-switch" : "invited-room-switch";
  client.endAccess();
  history.replaceState(history.state, "", roomHandoffLocation(roomId));
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
  syncWorkPolicy();
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
// W4-43 H1: the three starter recipes surface as dismissible suggestion chips.
// Triggers and outcomes are derived in src/work-recipes.js from committed
// state; chips only open existing surfaces or prefill a draft - they never
// send, launch or spend on the member's behalf.
const dismissedRecipeChips = new Set();
const recipeChipKey = r => `${r.id}:${r.outcome.workItemId ?? r.outcome.requestId ?? ""}`;
function recipeChipHtml(r) {
  const meta = RECIPE_CATALOG.find(c => c.id === r.id), key = recipeChipKey(r);
  let label, action;
  if (r.id === "draft-catch-up") {
    label = `${r.trigger.unseen} new ${r.trigger.unseen === 1 ? "event" : "events"} since your caught-up marker`;
    action = `<button type="button" class="button ghost" data-recipe-action="open-catch-up">Open catch-up draft</button>`;
  } else if (r.id === "suggest-next-work") {
    label = `Next step: ${esc(r.outcome.label)}`;
    action = r.outcome.workItemId
      ? `<button type="button" class="button ghost" data-recipe-action="focus-work" data-work-id="${esc(r.outcome.workItemId)}" aria-label="Open suggested work: ${esc(r.outcome.label)}">Open work</button>`
      : `<button type="button" class="button ghost" data-recipe-action="open-chat" aria-label="Open suggested request: ${esc(r.outcome.label)}">Open request</button>`;
  } else {
    label = `"${esc(r.outcome.title ?? r.outcome.workItemId)}" has waited over a day for review`;
    action = `<button type="button" class="button ghost" data-recipe-action="draft-review" data-work-id="${esc(r.outcome.workItemId)}" data-to="${esc(r.outcome.toMemberId)}">Draft a review request</button>`;
  }
  return `<div class="recipe-chip" data-recipe-chip="${esc(key)}"><span class="recipe-chip-label"><strong>${esc(meta.title)}</strong> - ${label}</span>${action}<button type="button" class="button ghost" data-recipe-dismiss="${esc(key)}" aria-label="Dismiss suggestion: ${esc(meta.title)}">Dismiss</button></div>`;
}
// W4-47 H6: dry-run preview panel. Lists every catalog recipe with what it
// reads, its trigger, what it would do, and whether it would fire right now.
// previewAllRecipes is a pure read over committed state - opening this panel
// commits nothing, writes nothing and never marks intent handled.
function recipePreviewLabel(p) {
  if (!p.firesNow) return "Not firing right now";
  const o = p.preview;
  if (o.kind === "catch_up_draft") return "Firing now: would prepare a catch-up draft";
  if (o.kind === "work_suggestion") return `Firing now: would suggest ${esc(o.label)}`;
  if (o.kind === "review_request_draft") return `Firing now: would draft a review request for "${esc(o.title ?? o.workItemId)}"`;
  return "Firing now";
}
function recipePreviewHtml(p) {
  return `<div class="recipe-preview-item"><strong>${esc(p.title)}</strong>`
    + `<div>Reads: ${esc(p.reads.join("; "))}</div>`
    + `<div>Trigger: ${esc(p.trigger)}</div>`
    + `<div>Would do: ${esc(p.outcome)}</div>`
    + `<div class="recipe-preview-status">${recipePreviewLabel(p)}</div></div>`;
}
function syncRecipePreview() {
  const toggle = $("#recipe-preview-toggle"), panel = $("#recipe-preview");
  if (!toggle || !panel) return;
  if (!state || !session) { toggle.hidden = true; panel.hidden = true; panel.replaceChildren(); return; }
  toggle.hidden = false;
  if (panel.hidden) return;
  const previews = previewAllRecipes(state, session.member.id, { now: Date.now(), cursor: roomCursor, sequence: client.sequence });
  renderContent("#recipe-preview", previews.map(recipePreviewHtml).join(""));
}
function syncRecipeStrip() {
  const strip = $("#recipe-strip");
  if (!strip) return;
  if (!state || !session) { strip.hidden = true; strip.replaceChildren(); return; }
  const recipes = activeRecipes(state, session.member.id, { now: Date.now(), cursor: roomCursor, sequence: client.sequence })
    .filter(r => !dismissedRecipeChips.has(recipeChipKey(r)));
  strip.hidden = recipes.length === 0;
  renderContent("#recipe-strip", recipes.map(recipeChipHtml).join(""));
}
function render() {
  conversation = conversationIndex(state.messages);
  const members = Object.values(state.members), active = members.filter(m => m.active !== false);
  selectOptions("#message-to-select", active, "Everyone");
  syncWorkForm();
  syncActionForm();
  syncRecipeStrip();
  syncRecipePreview();
  setText("#presence-count", `${active.length} ${active.length === 1 ? "member" : "members"}`);
  const railCtx = { workItems: state.workItems, messages: state.messages, now: Date.now() };
  const ownerView = Boolean(session && state.room.ownerId === session.member.id && can("manage_members"));
  // C6: Pause/Resume govern the agent's queued wakes; Remove ends access via
  // MEMBER_ACCESS_CHANGED and asks for a second click instead of a native dialog.
  const memberActions = m => {
    if (!ownerView || m.kind !== "agent" || m.active === false) return "";
    const paused = agentPauses.has(m.id), armed = armedRemoval === m.id;
    return `<div class="member-actions" data-member-actions="${esc(m.id)}"><button type="button" class="text-button" data-member-pause="${esc(m.id)}" data-pause-action="${paused ? "resume" : "pause"}" title="${paused ? "Let queued wakes start again" : "Queued wakes will not start; a running attempt finishes"}">${paused ? "Resume" : "Pause"}</button><button type="button" class="text-button member-remove${armed ? " armed" : ""}" data-member-remove="${esc(m.id)}" aria-pressed="${armed}">${armed ? "Confirm remove" : "Remove"}</button>${armed ? `<button type="button" class="text-button" data-member-remove-cancel="${esc(m.id)}">Keep</button>` : ""}</div>`;
  };
  const presenceRow = m => {
    const presence = memberPresence(m, railCtx);
    // Agents get loud @handles; humans keep the exact "Name (id)" rail label so attribution stays unambiguous (quiet-attribution gate).
    const handle = m.kind === "agent" ? memberHandle(m, displayName(m.id)) : memberLabel(m.id);
    const done = memberDoneChip(m, railCtx);
    const status = memberStatus(m, railCtx);
    const doneChip = done
      ? `<span class="done-chip" title="${esc(done.title)}" data-done-work="${esc(done.workItemId)}">${esc(done.label)}</span>`
      : "";
    const typeChip = m.kind === "agent" && m.agentType
      ? `<span class="agent-type-chip" data-agent-type="${esc(m.agentType)}">${esc(catalogById(m.agentType)?.label || m.agentType)}</span>`
      : "";
    return `<div id="${recordDomId("member", m.id)}" class="presence-member" tabindex="-1" data-member-record-id="${esc(m.id)}" data-presence="${esc(presence)}" data-disclosure-host="${esc(m.id)}" data-focus-key="member:${esc(m.id)}"${m.agentType ? ` data-agent-type="${esc(m.agentType)}"` : ""} ${m.active === false ? "" : `title="${esc(`Address ${m.displayName} in chat`)}"`}><div class="member-avatar ${m.kind}" aria-hidden="true"><span>${initials(m.displayName)}</span><i class="presence-dot presence-${esc(presence)}" title="${esc(presenceLabel(presence))}"></i></div><div><div class="member-head"><strong class="member-handle${m.kind === "agent" ? " member-handle-agent" : ""}">${esc(handle)}</strong>${typeChip}<span class="sr-only">${esc(presenceLabel(presence))}</span>${doneChip}${agentPauses.has(m.id) && m.active !== false ? `<span class="pause-chip" data-paused-member="${esc(m.id)}" title="Queued wakes will not start">Paused</span>` : ""}</div><p class="member-status">${esc(status)}</p>${memberActions(m)}<details><summary data-focus-key="member-capabilities:${esc(m.id)}">Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p>${muteControl(m)}</details></div></div>`;
  };
  // E4: mute is the viewer's own preference; the owner (the appeal path) and yourself are never mutable.
  const muteControl = m => m.id === session?.member?.id || m.id === state.room.ownerId ? "" : `<button type="button" class="text-button mute-toggle" data-mute-member="${esc(m.id)}" data-muted="${isMutedBy(state, session?.member?.id, m.id)}" aria-pressed="${isMutedBy(state, session?.member?.id, m.id)}">${isMutedBy(state, session?.member?.id, m.id) ? `Unmute ${esc(m.displayName)}` : `Mute ${esc(m.displayName)} for me`}</button>`;
  const byPresence = (a, b) => (a.active === false) - (b.active === false) || a.displayName.localeCompare(b.displayName);
  const people = members.filter(m => m.kind !== "agent").sort(byPresence);
  const agents = members.filter(m => m.kind === "agent").sort(byPresence);
  renderContent("#presence-list", `${people.length ? `<p class="presence-heading">People</p>${people.map(presenceRow).join("")}` : ""}${agents.length ? `<p class="presence-heading">Agents</p>${agents.map(presenceRow).join("")}` : ""}`);
  const proposing = can("steer") && !isRoomArchived(state); // Issue #6 A2: no new work in an archived room.
  for (const id of ["new-work-button", "composer-work-button"]) {
    $("#" + id).hidden = !proposing; $("#" + id).disabled = !proposing;
  }
  syncComposerChrome();
  syncChannelChrome();
  renderMessages();
  syncRequestComposer();
  renderSpendAllowance();
  syncReports();
  $("#event-count").textContent = `${client.sequence}`;
  renderReturnBrief();
  renderContent("#event-list", [...state.eventLog].reverse().map(e => `<li id="${recordDomId("event", e.id)}" tabindex="-1" data-event-record-id="${esc(e.id)}" data-focus-key="event:${esc(e.id)}"><span>${esc(humanize(e.type))}</span><strong>${esc(memberLabel(e.actorId))}</strong><time datetime="${esc(e.at)}">${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join(""));

  // Decision register (backlog F2): the register is read from the event feed.
  const decisions = state.eventLog.filter(e => e.type === T.DECISION_RECORDED);
  setText("#decision-count", decisions.length || "");
  renderContent("#decision-list", [...decisions].reverse().map(e =>
    `<li><strong>${esc(e.data.statement)}</strong> <a class="source-link" href="${esc(recordHref("message", e.data.sourceMessageId))}" data-open-message="${esc(e.data.sourceMessageId)}">source</a>${e.data.note ? ` <span class="rb-detail">${esc(e.data.note)}</span>` : ""} <span class="rb-detail">${esc(memberLabel(e.actorId))} · ${esc(time(e.at))}</span></li>`).join("")
    || '<li class="rb-empty">No decisions recorded yet.</li>');
}
// Phase 2 channels: one main channel plus user-created channels. Chat and work
// share the timeline of the selected channel; work cards follow the channel of
// their proposal message (the main channel when there is none).
function channelStorageKey() { return `pr-channel:${activeChannelRoomId ?? "none"}`; }
function restoreActiveChannel() {
  activeChannelId = DEFAULT_CHANNEL_ID;
  try {
    const saved = localStorage.getItem(channelStorageKey());
    if (saved && state?.channels?.[saved] && !state.channels[saved].archivedAt) activeChannelId = saved;
  } catch { /* private mode: stay on the main channel */ }
}
function activeChannel() { return state?.channels?.[activeChannelId] ?? null; }
function setActiveChannel(id) {
  if (!state) return;
  const next = state.channels[id] && !state.channels[id].archivedAt ? id : DEFAULT_CHANNEL_ID;
  activeChannelId = next;
  try { localStorage.setItem(channelStorageKey(), activeChannelId); } catch { /* private mode */ }
  syncChannelChrome();
  renderMessages();
  $("#message-list")?.scrollTo({ top: 0 });
}
function syncChannelChrome() {
  // If the active channel was archived elsewhere, fall back to the main channel.
  if (state && activeChannelId !== DEFAULT_CHANNEL_ID && state.channels[activeChannelId]?.archivedAt) {
    activeChannelId = DEFAULT_CHANNEL_ID;
    try { localStorage.setItem(channelStorageKey(), activeChannelId); } catch { /* private mode */ }
  }
  const name = activeChannel()?.name ?? DEFAULT_CHANNEL_ID;
  setText("#conversation-title", `# ${name}`);
  const input = $("#message-input");
  if (input) input.placeholder = `Message #${name}`;
  renderChannels();
}
function renderChannels() {
  const list = $("#channel-list");
  if (!list || !state) return;
  const ownerView = Boolean(session && state.room.ownerId === session.member.id && can("manage_members"));
  const html = channelList(state).filter(c => !c.archivedAt).map(c => {
    const active = c.id === activeChannelId;
    const manage = ownerView && c.id !== DEFAULT_CHANNEL_ID
      ? `<button type="button" class="icon-button channel-manage" data-channel-manage="${esc(c.id)}" aria-label="Channel settings, ${esc(c.name)}" title="Channel settings">⋯</button>` : "";
    return `<li class="channel-row"><button type="button" class="channel${active ? " is-active" : ""}" data-channel="${esc(c.id)}"${active ? ' aria-current="page"' : ""}><span aria-hidden="true">#</span><span class="channel-name">${esc(c.name)}</span></button>${manage}</li>`;
  }).join("");
  if (list._html !== html) { list.innerHTML = html; list._html = html; }
}
function renderMessages() {
  const list = $("#message-list"), view = currentThreadId ? `thread:${currentThreadId}` : `room:${activeChannelId}`;
  const sameView = list.dataset.view === view;
  const messages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
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
  const announceCount = newMessages.filter(message => message.id !== pendingOutgoingId && !locallyOwnedMessageIds.has(message.id) && !isMutedBy(state, session?.member?.id, message.authorId)).length;
  newMessages.forEach(message => locallyOwnedMessageIds.delete(message.id));
  const channelMessages = state.messages.filter(m => messageChannelId(m) === activeChannelId);
  setText("#message-count", `${channelMessages.length} ${channelMessages.length === 1 ? "message" : "messages"}`);
  $("#thread-bar").hidden = !currentThreadId;
  $("#composer-label").textContent = currentThreadId ? "Reply in this thread" : "Message the room";
  if (currentThreadId) {
    const root = conversation.byId.get(currentThreadId);
    $("#thread-title").textContent = `Thread with ${name(root.authorId)}`;
    setText("#thread-context", `${messages.length - 1} ${messages.length === 2 ? "reply" : "replies"} · visible to everyone in this room`);
  }

  // Retain unchanged message nodes so new arrivals do not discard text selection or focus.
  const keep = new Set(messages.map(m => m.id));
  for (const [id, node] of previous) if (!keep.has(id) && !node.hasAttribute("data-work-timeline")) node.remove();
  const workEntries = currentThreadId || !state ? [] : timelineWorkEntries().filter(e => e.channelId === activeChannelId);
  const ordered = [];
  messages.forEach((message, index) => {
    const node = previous.get(message.id) || document.createElement("li");
    const cluster = messageCluster(messages, index);
    node.id = recordDomId("message", message.id); node.dataset.key = message.id; node.dataset.messageRecordId = message.id;
    const muted = isMutedBy(state, session?.member?.id, message.authorId);
    node.className = `message${cluster.grouped ? " grouped" : ""}${muted ? " muted" : ""}${session && !muted && messageMentionsMember(message.body, session.member) ? " mentioned" : ""}`; node.tabIndex = -1;
    const html = messageContent(message, cluster, message.id === unreadAnchorId);
    if (node._content !== html) {
      if (!node._content || !node.querySelector(".message-body")) node.innerHTML = html;
      else {
        const next = document.createElement("div"); next.innerHTML = html;
        // Reply counts/reactions change independently; the selected message text stays put.
        for (const selector of [".chat-divider", ".grouped-time", ".message-avatar", ".message-meta", ".message-body", ".message-context", ".reactions", ".message-links", ".draft-feedback"]) {
          const before = node.querySelector(selector), after = next.querySelector(selector);
          if (!before && !after) continue;
          if (!before) { node.insertBefore(after, node.firstChild); continue; }
          if (!after) { before.remove(); continue; }
          if (before.className !== after.className) before.className = after.className;
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
    ordered.push(node);
  });
  // Interleave work cards chronologically into the single timeline.
  const msgTs = m => Date.parse(m.createdAt) || 0;
  const workById = new Map();
  for (const entry of workEntries) {
    let wnode = previous.get(`work:${entry.item.id}`);
    if (!wnode || !wnode.hasAttribute("data-work-timeline")) wnode = makeTimelineWorkNode(entry);
    setTimelineWorkNode(wnode, entry.html);
    workById.set(entry.item.id, wnode);
  }
  for (const [key, node] of previous) if (key?.startsWith("work:") && !workById.has(key.slice(5))) node.remove();
  let wi = 0;
  const merged = [];
  messages.forEach((message, index) => {
    while (wi < workEntries.length && workEntries[wi].ts <= msgTs(message)) merged.push(workById.get(workEntries[wi++].item.id));
    merged.push(ordered[index]);
  });
  while (wi < workEntries.length) merged.push(workById.get(workEntries[wi++].item.id));
  if (!messages.length && !workEntries.length) list.innerHTML = `<li class="empty-note">No messages yet. <button type="button" class="text-button" data-empty-write>Write the first one</button>${can("manage_members") ? ' · <button type="button" class="text-button" data-empty-invite>Invite someone</button>' : ""}</li>`;
  else {
    list.querySelectorAll(":scope > .empty-note").forEach(n => n.remove());
    merged.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null); });
    while (list.children.length > merged.length) list.lastChild.remove();
  }
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
  renderPinned();
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
  // E4 moderation: a muted author's message collapses for the muter alone; Report goes to the owner only.
  const muted = isMutedBy(state, session.member.id, m.authorId), other = m.authorId !== session.member.id;
  const moderation = muted ? `<button class="message-to-work" data-message-action="unmute" data-message-id="${esc(m.id)}" type="button">Unmute ${esc(author.displayName)}</button>`
    : other ? `${!m.deletedAt ? `<button class="message-to-work" data-message-action="report" data-message-id="${esc(m.id)}" type="button">Report</button>` : ""}${m.authorId !== state.room.ownerId ? `<button class="message-to-work" data-message-action="mute" data-message-id="${esc(m.id)}" type="button">Mute ${esc(author.displayName)}</button>` : ""}` : "";
  const divider = unreadStart || cluster.dayStart
    ? `<div class="chat-divider${unreadStart ? " unread" : ""}" role="separator">${esc([unreadStart ? "New messages" : "", cluster.dayStart ? cluster.dayLabel : ""].filter(Boolean).join(" · "))}</div>`
    : "";
  const linked = Object.values(state.workItems).filter(i => i.sourceMessageId === m.id || i.id === m.workItemId);
  const parent = conversation.byId.get(m.replyToId);
  const count = (conversation.threads.get(m.id)?.length || 1) - 1;
  const reactionButtons = reactionPills(m.reactions).map(({ key, symbol, memberIds, count, used }) => {
    const selected = memberIds.includes(session.member.id);
    const pending = pendingReactions.get(`${m.id}:${key}`);
    const label = `${pending && !pending.busy ? "Retry " : ""}${key}`;
    return `<button type="button" class="reaction${used ? " used" : ""}" aria-pressed="${selected}" aria-label="${esc(label)} reaction, ${count}" title="${esc(memberIds.map(name).join(", ") || `React with ${key}`)}" data-message-action="react" data-message-id="${esc(m.id)}" data-reaction="${key}"${pending?.busy ? " disabled" : ""}><span aria-hidden="true">${symbol}</span><span>${count || ""}</span>${pending && !pending.busy ? " Retry" : ""}</button>`;
  }).join("");
  const groupedTime = cluster.grouped
    ? `<time class="grouped-time" datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time>`
    : "";
  return `${divider}${groupedTime}<div class="message-avatar ${author.kind}" aria-hidden="true">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(authorLabel)}</strong>${author.kind === "agent" ? `<span>${esc(kindLabel(author.kind))}</span>` : ""}${isPinned(state, m.id) ? `<span class="pinned-chip">Pinned</span>` : ""}<a class="message-time" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" aria-label="Link to message by ${esc(authorLabel)} at ${esc(time(m.createdAt))}"><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a></div><div class="message-context">${m.toMemberId ? `<span class="audience-chip">To ${esc(name(m.toMemberId))} · private</span>` : ""}${parent && parent.id !== currentThreadId ? `<a class="source-link reply-preview" href="${esc(recordHref("message", parent.id))}" data-open-message="${esc(parent.id)}">↳ ${esc(name(parent.authorId))}: ${parent.deletedAt ? "Message deleted" : esc(parent.body.slice(0,90))}</a>` : ""}</div>${muted ? `<p class="message-body message-muted">Hidden: you muted ${esc(authorLabel)}.</p>` : m.deletedAt ? `<p class="message-body message-tombstone">Message deleted</p>` : `<p class="message-body">${mentionHtml(m.body, Object.values(state.members), esc)}</p>`}<div class="draft-feedback">${muted ? "" : draftFeedbackHTML(m)}</div><div class="reactions" role="group" aria-label="Reactions to message by ${esc(authorLabel)}">${muted ? "" : reactionButtons}</div><div class="message-links">${muted ? moderation : `${requestControls(m)}${linked.map(i => `<a class="work-link" href="${esc(workHref(i.id))}" data-open-work="${esc(i.id)}">↳ ${esc(i.title)}</a>${doneChip(i)}`).join("")}${!m.deletedAt && m.workItemId && workActions(state.workItems[m.workItemId], state.members[session.member.id]).some(([action]) => action === "complete") ? `<button class="message-to-work" type="button" data-message-action="result" data-message-id="${esc(m.id)}">Save as result</button>` : ""}<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button">Reply</button>${!m.deletedAt ? `<button class="message-to-work" data-message-action="pin" data-message-id="${esc(m.id)}" type="button" aria-pressed="${isPinned(state, m.id)}">${isPinned(state, m.id) ? "Unpin" : "Pin"}</button>` : ""}${!currentThreadId && count ? `<button class="thread-link" data-message-action="thread" data-message-id="${esc(m.id)}" type="button">${count} ${count === 1 ? "reply" : "replies"} ↗</button>` : ""}${!m.deletedAt && can("steer") && !(m.proposal && m.workItemId) ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : ""}${!m.deletedAt && can("decide") && state.members[session.member.id]?.kind === "human" ? `<button class="message-to-work" data-message-action="decide" data-message-id="${esc(m.id)}" type="button">Record decision</button>` : ""}${moderation}`}</div></div>`;
}
function mentionsFilterOn() {
  return $("#search-mentions")?.getAttribute("aria-pressed") === "true";
}
// Backlog follow-up 8: "Pinned only" narrows search to state.pins (issue #6 B2).
// Pins are messages, so work results step aside while it is on.
function pinnedFilterOn() {
  return $("#search-pinned")?.getAttribute("aria-pressed") === "true";
}
function renderSearch(now = Date.now()) {
  const query = $("#message-search").value;
  const parsed = parseSearchQuery(query);
  const only = mentionsFilterOn() || parsed.mentionsOnly, pinnedOnly = pinnedFilterOn();
  const active = Boolean(query.trim()) || only || pinnedOnly;
  $("#clear-search").hidden = !query && !mentionsFilterOn() && !pinnedOnly;
  $("#search-results").hidden = !active;
  if (!active) { $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = ""; return; }
  const result = searchMessages(state, query, 50, { viewer: session?.member, mentionsOnly: mentionsFilterOn(), pinnedOnly });
  const work = only || pinnedOnly ? { work: [], total: 0 } : searchWork(state, parsed.term || query);
  const total = result.total + work.total, shown = result.messages.length + work.work.length;
  const noun = only && !parsed.term ? (total === 1 ? "mention" : "mentions") : pinnedOnly && !parsed.term ? (total === 1 ? "pinned message" : "pinned messages") : (total === 1 ? "match" : "matches");
  setText("#search-count", `${total} ${noun}${total > shown ? ` · ${shown} shown` : ""} in this room`);
  const list = $("#search-list"), focused = list.contains(document.activeElement) ? document.activeElement.dataset.searchKey : null;
  const empty = only && !parsed.term ? "No one has @-mentioned you yet." : pinnedOnly && !parsed.term ? "Nothing is pinned yet." : pinnedOnly ? "No pinned messages match." : "No matches. Try a name or another phrase.";
  const html = work.work.map(({ item, excerpt }) => `<li><a href="${esc(workHref(item.id))}" data-open-work="${esc(item.id)}" data-search-key="work:${esc(item.id)}"><strong>${esc(item.title)}</strong><span>${esc(excerpt)}</span><small>Work · ${esc(workStatus(item, now).label)}</small></a></li>`).join("")
    + result.messages.filter(m => !isMutedBy(state, session?.member?.id, m.authorId)).map(m => `<li><a href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" data-search-key="message:${esc(m.id)}"><strong>${esc(name(m.authorId))}</strong><span>${esc(m.deletedAt ? "Message deleted" : (m.body ?? "").slice(0, 240))}</span><small>${m.replyToId ? "Open thread at this reply" : "Open in room"}</small></a></li>`).join("") || `<li class="empty-note">${empty}</li>`;
  if (list._content !== html) { list.innerHTML = html; list._content = html; }
  if (focused) ([...list.querySelectorAll("[data-search-key]")].find(e => e.dataset.searchKey === focused) || $("#message-search")).focus({ preventScroll: true });
}
function saveComposer() {
  drafts.save(composerKey(), { body: $("#message-input").value, toMemberId: $("#message-to-select").value, replyToId, channelId: activeChannelId, pending: pendingMessage,
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
  syncComposerChrome();
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
    : request ? (conversation?.byId.get(request.id)?.deletedAt ? "Message deleted" : (conversation?.byId.get(request.id)?.body ?? "").slice(0, 80)) : "";
  setText("#request-mode-label", requestReading ? "Reading request…" : [label, subject, pendingMessage ? "Retry original" : changed ? "Context changed" : ""].filter(Boolean).join(" · "));
  $("#request-refresh").hidden = !request || Boolean(pendingMessage) || requestReading || request.status !== "open";
  $("#request-exit").disabled = busy;
  const input = $("#message-input"), select = $("#message-to-select"), send = $("#message-form button[type=submit]");
  const archived = Boolean(state) && isRoomArchived(state); // Issue #6 A2: an archived room is read only.
  input.readOnly = Boolean(mode && pendingMessage);
  input.disabled = busy || requestReading || archived;
  select.disabled = busy || requestReading || Boolean(mode && (mode.kind !== "request" || pendingMessage));
  select.required = mode?.kind === "request";
  select.setCustomValidity(mode?.kind === "request" && (!select.value || select.value === session?.member.id) ? "Choose another participant." : "");
  send.disabled = busy || requestReading || archived || Boolean(request && request.status !== "open" && !pendingMessage);
  const action = pendingMessage && mode ? "Retry original" : mode ? mode.kind === "request" ? "Send request" : label : "Send";
  send.setAttribute("aria-label", action); send.title = action;
  input.placeholder = archived ? "This room is archived." : composerPlaceholder({ workKind: mode?.kind ?? null, inThread: Boolean(currentThreadId), channelName: activeChannel()?.name ?? DEFAULT_CHANNEL_ID });
  if (active) $("#reply-bar").hidden = true;
  syncComposerChrome();
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
$("#recipe-preview-toggle").addEventListener("click", () => {
  const panel = $("#recipe-preview");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  syncRecipePreview();
});
$("#recipe-strip").addEventListener("click", event => {
  const dismissKey = event.target.closest("[data-recipe-dismiss]")?.dataset.recipeDismiss;
  if (dismissKey) { dismissedRecipeChips.add(dismissKey); syncRecipeStrip(); return; }
  const control = event.target.closest("[data-recipe-action]");
  if (!control) return;
  const action = control.dataset.recipeAction;
  if (action === "open-catch-up") openCatchUp();
  if (action === "open-chat") { $("#message-input").focus(); }
  if (action === "focus-work") {
    const card = document.getElementById(workDomId(control.dataset.workId));
    card?.scrollIntoView({ block: "nearest", behavior: "instant" }); card?.focus({ preventScroll: true });
  }
  if (action === "draft-review") {
    const item = state?.workItems?.[control.dataset.workId];
    if (!item) return;
    setRequestMode({ kind: "request" }, { body: `Could you review "${item.title ?? control.dataset.workId}"? The result has been waiting for verification.`, toMemberId: control.dataset.to });
  }
});
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
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
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
  inboxUI?.showRooms();
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function workRecord(id) {
  return $(`#message-list [data-work-record-id="${CSS.escape(id)}"]`);
}
function revealWork(id) {
  if (!state?.workItems[id] || busy) return;
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
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
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
  $("#people-panel").open = true;
  focusRecord([...$("#presence-list").querySelectorAll("[data-member-record-id]")]
    .find(node => node.dataset.memberRecordId === id));
}
function revealRoom() {
  if (!state || busy) return;
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
  focusRecord($("#room-title"));
}
function revealEvent(id) {
  if (!state || busy) return;
  openSettings("record-panel");
  focusRecord([...$("#event-list").querySelectorAll("[data-event-record-id]")]
    .find(node => node.dataset.eventRecordId === id));
}
function decodeFragment(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
function revealLocationHash() {
  if (!state || !location.hash) return;
  const hash = location.hash;
  const deepRoom = roomIdFromHash(hash);
  if (deepRoom) {
    if (state.room?.id === deepRoom) {
      $("#people-panel").open = true;
      focusRecord($("#people-panel > summary"));
    }
    return;
  }
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
// C2: read-only "what this agent can access" preview. Loaded on demand from the
// same one-task read an agent gets (client.workContext), rendered with the room
// roster for names, and kept across snapshot re-renders until closed. It shows
// exactly the omissions the server reports; opening it starts and grants nothing.
const accessPreviews = new Map();
const BUDGET_LABELS = Object.freeze({ maxRuntimeMs: "Runtime", maxAttempts: "Attempts", maxConcurrent: "Concurrent sessions", maxSpendCents: "Spend cap", spendCents: "Reported spend" });
const budgetValue = (key, value) => value === "unknown" ? "unknown" : key === "maxRuntimeMs" ? (value < 60000 ? `${Math.round(value / 1000)} s` : `${Math.round(value / 60000)} min`) : /Cents$/.test(key) ? `$${(value / 100).toFixed(2)}` : String(value);
function accessPreviewHtml(i) {
  const entry = accessPreviews.get(i.id);
  if (!entry) return "";
  const id = `${workDomId(i.id)}-access`;
  if (entry.error) return `<section class="access-preview" id="${esc(id)}" data-access-panel="${esc(i.id)}" role="region" aria-label="What this agent can access"><p class="form-hint">${esc(entry.error)}</p></section>`;
  const summary = entry.summary, conversation = summary.conversation, sourceId = conversation.sourceMessageIds[0] ?? null;
  const source = state.messages.find(message => message.id === sourceId);
  const conversationLine = conversation.scope === "none" ? "No linked message. The agent sees this task record only, never the conversation."
    : conversation.sourceAvailability === "unavailable" ? `The linked source message (${esc(i.sourceMessageId)}) is not available in this room, so nothing from the conversation is delivered.`
    : `Only the one linked source message${source ? ` <a class="source-link" href="${esc(recordHref("message", source.id))}" data-open-message="${esc(source.id)}">${esc(source.id)}</a> by ${esc(memberLabel(source.authorId))}` : ""}${conversation.sourceAvailability === "deleted" ? " (deleted; only the tombstone remains)" : ""}, and only when the agent asks for it. Not its thread, replies, @mentions or imported channel excerpts.`;
  const evidence = summary.evidence.records.length
    ? summary.evidence.records.map(record => `${esc(humanize(record.record))} · version ${esc(record.evidenceVersion ?? "unknown")}${record.evidenceUrl ? ` · ${esc(record.evidenceUrl)}` : ""}`).join("<br>") + '<br><span class="form-hint">References only; nothing is retrieved or verified by the read.</span>'
    : "No linked evidence yet.";
  const budget = Object.keys(BUDGET_LABELS).map(key => `${BUDGET_LABELS[key]} ${esc(budgetValue(key, summary.budget[key]))}`).join(" · ") + ` · attempts so far ${esc(String(summary.budget.attemptCount))}. Unknown is not unlimited.`;
  const roster = Object.values(state.members).filter(member => member.active !== false);
  const referenced = new Set(summary.participantIds);
  const readers = roster.map(member => `${esc(member.displayName)}${member.kind === "agent" ? " (agent)" : ""}${referenced.has(member.id) ? " · on this task" : ""}`).join(", ");
  return `<section class="access-preview" id="${esc(id)}" data-access-panel="${esc(i.id)}" role="region" aria-labelledby="${esc(id)}-title"><h4 id="${esc(id)}-title">What this agent can access</h4><p class="form-hint">The one-task view an agent reads before it starts, evaluated ${esc(new Date(entry.evaluatedAt).toLocaleString())}. Read-only: opening it starts nothing and grants nothing. Organization allowlists are not available yet.</p><dl class="work-facts"><div><dt>Conversation</dt><dd>${conversationLine}</dd></div><div><dt>Evidence</dt><dd>${evidence}</dd></div><div><dt>Budget</dt><dd>${budget}</dd></div><div><dt>Who can read</dt><dd>Room-wide membership: ${roster.length} active ${roster.length === 1 ? "member" : "members"} share this view — ${readers}. This is not a task-level grant.</dd></div><div><dt>Not included</dt><dd data-access-omitted>${summary.omitted.map(entry => esc(humanize(entry))).join(", ")}</dd></div></dl></section>`;
}
function workCard(i, now, drafts, messages = []) {
  const next = nextWorkStep(i, now), status = workStatus(i, now), help = helpView(i, now);
  // Derived read-time signal only: a pause hint, never a block or a dispatch.
  const loops = coordinationLoops(i, messages);
  const loopNotice = loops.length ? `<p class="loop-warning" data-loop-kind="${esc(loops[0].kind)}"><strong>Possible coordination loop.</strong> ${esc(loops[0].label)}</p>` : "";
  const nextActor = next.memberId ? `${name(next.memberId)} — ` : "";
  const nextLine = `<p class="work-next-step" data-next-step="${esc(next.action)}"><strong>Next:</strong> ${esc(nextActor + status.next)}</p>`;
  const source = i.sourceMessageId ? `<a class="source-link" href="${esc(recordHref("message", i.sourceMessageId))}" data-open-message="${esc(i.sourceMessageId)}" data-focus-key="work-source:${esc(i.id)}">From this conversation</a>` : "";
  const blocker = i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : "";
  const decision = i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : "";
  const claim = i.claim ? `<details class="claim"><summary data-focus-key="work-claim:${esc(i.id)}">Recorded scope · ${esc(claimStateLabel(i, now))}</summary><p>${esc(memberLabel(i.claim.holderId))}</p><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p><p>Expires ${esc(new Date(i.claim.expiresAt).toLocaleString())}. External activity is not measured.</p>${actions(i, true, now)}</details>` : "";
  const checks = `<div><dt>Verifier</dt><dd>${i.independentVerificationRequired ? esc(memberLabel(i.verifierMemberId)) : "Not required"}</dd></div><div><dt>Decision</dt><dd>${i.ownerDecisionRequired ? esc(memberLabel(i.humanDecisionMakerId)) : "Not required"}</dd></div>`;
  const updated = `<p class="form-hint">Last recorded update: ${esc(new Date(i.updatedAt).toLocaleString())}. Live execution is not measured.</p>`;
  const attempts = attemptLedger(i);
  const receipts = attemptReceipts(i);
  // G7: silence is never termination - a stale-heartbeat run is labeled
  // unresponsive with process state unknown, never "stopped".
  const unresponsiveRun = cancellationState(i, { nowMs: Date.now() }).unresponsive;
  const attemptsLine = attempts.length ? `<p class="form-hint" data-attempt-ledger="${esc(i.id)}">Attempts: ${attempts.map((a, ix) => `#${a.attempt} ${esc(memberLabel(a.performer))} · ${a.outcome ?? (unresponsiveRun ? "unresponsive - process state unknown" : "running")}${a.environment ? ` · ${esc(a.environment)}` : ""}${receipts[ix]?.successClaim === "unverified" ? " · unverified (missing outputs or measured usage)" : ""}`).join(" · ")}</p>` : "";
  const reuse = can("steer") ? `<button type="button" class="button ghost" data-reuse-work="${esc(i.id)}" data-focus-key="work-reuse:${esc(i.id)}">Use again</button>` : "";
  const latestDraft = drafts[0];
  const alternatives = drafts.length > 1 ? `<details class="work-drafts"><summary data-focus-key="work-drafts:${esc(i.id)}">Drafts (${drafts.length})</summary>${drafts.map(draft =>
`<p><a class="source-link" href="${esc(recordHref("message", draft.id))}" data-open-message="${esc(draft.id)}" data-focus-key="work-draft-message:${esc(draft.id)}">${esc(memberLabel(draft.authorId))} · ${esc(draftFeedback(i, draft)?.label ?? "Draft")}<br><span class="form-hint">${esc([...draft.body].slice(0, 100).join(""))}${[...draft.body].length > 100 ? "…" : ""}</span></a></p>`).join("")}</details>` : "";
  const staleBasis = latestDraft?.proposal && latestDraft.proposal.basisRevision < i.revision ? latestDraft.proposal.basisRevision : null;
  // F3: a stale-basis draft gets a derived read-time explanation of what changed; never a block.
  const changesToggle = staleBasis === null ? "" : `<button type="button" class="button ghost" data-work-changes="${esc(i.id)}" data-basis="${staleBasis}" data-focus-key="work-changes:${esc(i.id)}">What changed since revision ${staleBasis}</button><div class="work-changes-list" data-changes-list="${esc(i.id)}" hidden></div>`;
  const draftLink = i.receipt?.nativeText ? `<button class="source-link" type="button" data-read-result="${esc(i.id)}" data-focus-key="work-native-result:${esc(i.id)}">View result</button>` + alternatives : alternatives || (latestDraft ? `<a class="source-link" href="${esc(recordHref("message", latestDraft.id))}" data-open-message="${esc(latestDraft.id)}" data-focus-key="work-draft:${esc(i.id)}">View latest draft</a>` : "");
  return `<article id="${workDomId(i.id)}" class="work-card" tabindex="-1" data-work-record-id="${esc(i.id)}" data-disclosure-host="${esc(i.id)}" data-focus-key="work:${esc(i.id)}"><div class="work-card-header"><span class="state state-${status.tone}">${esc(status.label)}</span>${doneChip(i)}</div><h3>${esc(i.title)}</h3>${nextLine}${loopNotice}${draftLink}${changesToggle}${helpCard(i, help)}<details class="work-details"><summary data-focus-key="work-details:${esc(i.id)}">${i.receipt ? "Evidence & details" : "Details"}</summary><span class="mode">${esc(i.mode)} · revision ${i.revision}</span>${source}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(memberLabel(i.accountableMemberId))}</dd></div>${checks}</dl>${updated}${attemptsLine}${receiptCard(i)}${blocker}${decision}${claim}<div class="portable-actions">${i.receipt ? `<button type="button" class="button secondary" data-copy-result="${esc(i.id)}" data-focus-key="work-copy-result:${esc(i.id)}">Copy summary</button>` : ""}${shareDraftButton(i)}${reuse}${help?.canPublish && help.help?.status !== "open" ? helpButton(i, "help", "Ask for help") : ""}${terminalWork(i) ? "" : `<button type="button" class="button ghost" data-reminder-work="${esc(i.id)}" data-focus-key="work-reminder:${esc(i.id)}">Remind me</button>`}<button type="button" class="button secondary" data-portable-work="${esc(i.id)}" data-focus-key="work-ai:${esc(i.id)}">Use my AI</button><button type="button" class="button ghost" data-portable-work="${esc(i.id)}" data-portable-mode="result" data-focus-key="work-result:${esc(i.id)}">Paste AI draft</button><button type="button" class="button ghost" data-access-preview="${esc(i.id)}" data-focus-key="work-access:${esc(i.id)}" aria-expanded="${accessPreviews.has(i.id) ? "true" : "false"}"${accessPreviews.has(i.id) ? ` aria-controls="${workDomId(i.id)}-access"` : ""}>What this agent can access</button></div>${accessPreviewHtml(i)}</details><div class="work-actions">${actions(i, false, now)}</div></article>`;
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
// Unified timeline: work items render inline in #message-list, interleaved
// chronologically with messages (Discord/Slack-style). Work cards follow the
// active channel: a card shows when its proposal message is in the channel.
function timelineWorkEntries() {
  const now = Date.now();
  const draftsByWork = new Map();
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (!message.workItemId || !message.proposal) continue;
    if (!draftsByWork.has(message.workItemId)) draftsByWork.set(message.workItemId, []);
    draftsByWork.get(message.workItemId).push(message);
  }
  return Object.values(state.workItems)
    .map(item => {
      const proposals = draftsByWork.get(item.id) ?? [];
      // proposals is built newest-first via reverse iteration; the most recent
      // proposal determines the work card's channel.
      const mostRecent = proposals[0];
      return { item, channelId: mostRecent ? messageChannelId(mostRecent) : DEFAULT_CHANNEL_ID,
        ts: Date.parse(item.updatedAt) || 0, html: workCard(item, now, proposals, state.messages) };
    })
    .sort((a, b) => a.ts - b.ts);
}
function makeTimelineWorkNode(entry) {
  const wnode = document.createElement("li");
  wnode.dataset.key = `work:${entry.item.id}`;
  wnode.setAttribute("data-work-timeline", entry.item.id);
  wnode.className = "tl-work"; wnode.tabIndex = -1;
  return wnode;
}
function setTimelineWorkNode(wnode, html) {
  if (wnode._content === html) return;
  const saved = captureDisclosures(wnode);
  wnode.innerHTML = html; wnode._content = html;
  restoreDisclosures(wnode, saved);
}
// Syncs work cards into the message timeline without disturbing messages.
// Used by renderReturnBrief for work updates that bypass renderMessages.
function syncTimelineWork() {
  const list = $("#message-list");
  if (!list || !state) return;
  if (currentThreadId) { list.querySelectorAll(":scope > [data-work-timeline]").forEach(n => n.remove()); return; }
  const entries = timelineWorkEntries().filter(e => e.channelId === activeChannelId);
  const byId = new Map(entries.map(e => [e.item.id, e]));
  const stale = [];
  list.querySelectorAll(":scope > [data-work-timeline]").forEach(n => {
    const id = n.getAttribute("data-work-timeline");
    if (byId.has(id)) byId.get(id).node = n; else stale.push(n);
  });
  stale.forEach(n => n.remove());
  const tsById = new Map(state.messages.map(m => [m.id, Date.parse(m.createdAt) || 0]));
  const workTs = new Map(entries.map(e => [e.item.id, e.ts]));
  const childTs = child => child.hasAttribute("data-work-timeline")
    ? workTs.get(child.getAttribute("data-work-timeline")) ?? 0
    : tsById.get(child.dataset.key) ?? 0;
  for (const entry of entries) {
    let wnode = entry.node;
    if (!wnode) { wnode = makeTimelineWorkNode(entry); entry.node = wnode; }
    setTimelineWorkNode(wnode, entry.html);
    let ref = null;
    for (const child of list.children) {
      if (child === wnode) continue;
      if (childTs(child) > entry.ts) { ref = child; break; }
    }
    if (wnode.parentNode !== list || wnode.nextSibling !== ref) list.insertBefore(wnode, ref);
  }
  const emptyNote = list.querySelector(":scope > .empty-note");
  if (emptyNote && (entries.length || list.querySelector(":scope > [data-message-record-id]"))) emptyNote.remove();
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
    const text = `${requestFailureMessage(error)}. ${failureHint ?? (state ? "Your entries were kept; try again." : "Sign in again.")}`;
    // One live-announcement owner per send result: when the form has its own status region
    // it owns the announcement (the visible composer error); the page-level region stays
    // silent so a screen reader announces the failure exactly once.
    if (form.id === "message-form") { clearNotice(); setComposerError(text); }
    else if (local && (!state && local.id !== "auth-error")) clearNotice();
    else if (local) { clearNotice(); setFormStatus(local, text, true); }
    else notice(text, true);
  }
  finally {
    // No `return` in `finally`: it would swallow anything the catch handler threw.
    if (operationId === submitOperationId) {
      busy = false; releaseSubmission(ticket, { restoreFocus: true }); if (state) render();
    }
  }
}
$("#invitation-dismiss").addEventListener("click", () => closeInvitation());
$("#invitation-retry").addEventListener("click", () => { if (invitation.phase === "preview-failed") previewCurrentInvitation(); });
for (const id of ["invitation-dialog", "work-dialog", "action-dialog", "result-dialog", "room-actions-dialog", "decision-dialog"]) $(`#${id}`).addEventListener("keydown", e => {
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
$("#room-guide-dismiss")?.addEventListener("click", () => dismissRoomGuide());
function setSigninExtra(open) {
  const extra = $("#signin-extra"), toggle = $("#signin-more");
  if (!extra || !toggle) return;
  extra.hidden = !open;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.textContent = open ? "Fewer options" : "More options";
}
$("#signin-more")?.addEventListener("click", () => {
  const extra = $("#signin-extra");
  setSigninExtra(extra ? extra.hidden : false);
});
$("#auth-kind-room")?.addEventListener("click", () => setAuthKind("room"));
$("#auth-kind-account")?.addEventListener("click", () => setAuthKind("account"));
$("#reopen-last-room")?.addEventListener("click", () => { void reopenRememberedRoom(); });
$("#continue-account")?.addEventListener("click", () => { void continueAccountSession(); });
$("#clear-session")?.addEventListener("click", () => { void clearSavedBrowserSession(); });
$("#access-key-reveal")?.addEventListener("click", () => {
  const field = $("#access-key"), show = field.type === "password";
  field.type = show ? "text" : "password";
  $("#access-key-reveal").textContent = show ? "Hide" : "Show";
  $("#access-key-reveal").setAttribute("aria-pressed", show ? "true" : "false");
});
function openShareOrTargetedInvite(text) {
  const share = shareJoinSecretFromText(text);
  if (share && shareLinksUI) {
    shareLinksUI.open({ token: share });
    return true;
  }
  const secret = inviteSecretFromText(text);
  if (!secret) return false;
  openInvitation({ valid: true, secret });
  return true;
}
$("#invite-link")?.addEventListener("change", () => {
  const text = $("#invite-link").value;
  if (!openShareOrTargetedInvite(text)) return;
  $("#invite-link").value = "";
});
$("#invite-link")?.addEventListener("paste", event => {
  const text = event.clipboardData?.getData("text") ?? $("#invite-link").value;
  if (!openShareOrTargetedInvite(text)) return;
  event.preventDefault();
  $("#invite-link").value = "";
});
function redeemInviteInput() {
  const input = $("#invite-link");
  const err = $("#invite-error");
  if (openShareOrTargetedInvite(input?.value ?? "")) {
    if (err) err.textContent = "";
    input.value = "";
    return;
  }
  if (err) err.textContent = "That doesn't look like an invite link or join code. Paste the full invite link or ABC-DEF-GHJ.";
}
$("#invite-redeem")?.addEventListener("click", redeemInviteInput);
$("#invite-link")?.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); redeemInviteInput(); }
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
// C1: mobile session menu (short header) - toggle, Escape, outside click.
const sessionMenu = $("#session-menu");
const sessionMenuButton = $("#session-menu-button");
const setSessionMenuOpen = open => {
  sessionMenu.classList.toggle("open", open);
  sessionMenuButton.setAttribute("aria-expanded", String(open));
};
sessionMenuButton.addEventListener("click", () => setSessionMenuOpen(!sessionMenu.classList.contains("open")));
$("#clear-session-menu")?.addEventListener("click", () => { setSessionMenuOpen(false); void clearSavedBrowserSession(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && sessionMenu.classList.contains("open")) {
    setSessionMenuOpen(false);
    sessionMenuButton.focus();
  }
});
document.addEventListener("click", event => {
  if (sessionMenu.classList.contains("open") && !sessionMenu.contains(event.target)) setSessionMenuOpen(false);
});

$("#account-settings-button").addEventListener("click", openAccountSettings);
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
      setFormStatus($("#auth-error"), signedOut ? "" : unreachableRoomMessage(error), true);
      setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
      return;
    }
    handleFailureNotice(error);
  }
});
$("#message-form").addEventListener("submit", e => {
  e.preventDefault(); hideMentions(); if (!state || busy || requestReading) return;
  if (isRoomArchived(state)) { setComposerError("This room is archived and read only."); return; }
  if (activeChannel()?.archivedAt) { setComposerError("This channel is archived."); return; }
  if (requestMode) { submitRequest(e.currentTarget); return; }
  const content = { body: $("#message-input").value.trim(), toMemberId: $("#message-to-select").value || null, replyToId, channelId: activeChannelId };
  if (!content.body) return;
  const previous = pendingMessage?.command?.data;
  const unchanged = previous && previous.body === content.body && previous.toMemberId === content.toMemberId && previous.replyToId === content.replyToId && previous.channelId === content.channelId;
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
    dismissRoomGuide();
  }, { failureHint: "Draft kept. Send again to retry." });
});
// Channel creation and management: any member can create a channel; only the
// room owner renames or archives. Archive is a two-click arm, never a native dialog.
let channelDialogMode = null, channelArchiveArmed = false;
function openChannelDialog(mode, channelId = null) {
  if (!state) return;
  channelDialogMode = { mode, channelId };
  channelArchiveArmed = false;
  const channel = channelId ? state.channels[channelId] : null;
  $("#channel-dialog-title").textContent = mode === "create" ? "New channel" : "Channel settings";
  $("#channel-save-button").textContent = mode === "create" ? "Create channel" : "Rename channel";
  $("#channel-name-input").value = channel?.name ?? "";
  const archiveButton = $("#channel-archive-button");
  archiveButton.hidden = !(mode === "manage" && channelId !== DEFAULT_CHANNEL_ID);
  archiveButton.textContent = "Archive channel";
  setFormStatus($("#channel-form-status"), "");
  if (!$("#channel-dialog").open) $("#channel-dialog").showModal();
  $("#channel-name-input").focus();
  $("#channel-name-input").select();
}
async function waitForChannel(id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state?.channels?.[id] && !state.channels[id].archivedAt) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return Boolean(state?.channels?.[id]);
}
$("#create-channel-button").addEventListener("click", () => openChannelDialog("create"));
$("#channel-dialog-close").addEventListener("click", () => $("#channel-dialog").close());
$("#channel-list").addEventListener("click", e => {
  const manage = e.target.closest("[data-channel-manage]");
  if (manage) { e.stopPropagation(); openChannelDialog("manage", manage.dataset.channelManage); return; }
  const button = e.target.closest("[data-channel]");
  if (button) setActiveChannel(button.dataset.channel);
});
$("#channel-form").addEventListener("submit", async e => {
  e.preventDefault();
  const mode = channelDialogMode;
  const name = $("#channel-name-input").value.trim();
  if (!mode || !name || !state) return;
  const status = $("#channel-form-status");
  setFormStatus(status, mode.mode === "create" ? "Creating…" : "Saving…");
  try {
    const pending = mode.mode === "create"
      ? draftCommand(null, T.CHANNEL_CREATED, { channelId: crypto.randomUUID(), name })
      : draftCommand(null, T.CHANNEL_RENAMED, { channelId: mode.channelId, name });
    const newChannelId = pending.command.data.channelId;
    await client.send(pending.command);
    $("#channel-dialog").close();
    if (mode.mode === "create") {
      if (newChannelId && await waitForChannel(newChannelId)) setActiveChannel(newChannelId);
      notice(`Channel #${name} created.`);
    } else notice("Channel renamed.");
  } catch (error) { setFormStatus(status, `${error.message}`, true); }
});
$("#channel-archive-button").addEventListener("click", async e => {
  const mode = channelDialogMode;
  if (!mode || mode.mode !== "manage" || !mode.channelId || !state) return;
  const button = e.currentTarget;
  if (!channelArchiveArmed) {
    channelArchiveArmed = true;
    button.textContent = "Confirm archive";
    setFormStatus($("#channel-form-status"), "Archived channels stay searchable but accept no new messages.");
    return;
  }
  setFormStatus($("#channel-form-status"), "Archiving…");
  try {
    await client.send(draftCommand(null, T.CHANNEL_ARCHIVED, { channelId: mode.channelId }).command);
    $("#channel-dialog").close();
    if (activeChannelId === mode.channelId) setActiveChannel(DEFAULT_CHANNEL_ID);
    notice("Channel archived.");
  } catch (error) {
    setFormStatus($("#channel-form-status"), `${error.message}`, true);
    channelArchiveArmed = false; button.textContent = "Archive channel";
  }
});
function submitRequest(form) {
  if (!state || busy || requestReading) return;
  const mode = requestMode, key = composerKey(), identity = session, generation = client.generation;
  if (!$("#message-input").value.trim()) return;
  const hadPending = Boolean(pendingMessage);
  try {
    if (!pendingMessage) {
      const data = replyDraftData(mode, { body: $("#message-input").value.trim(),
        toMemberId: $("#message-to-select").value || null, replyToId, messageId: crypto.randomUUID(),
        channelId: activeChannelId });
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
  const chip = e.target.closest("[data-mention-id]");
  if (chip && state) { applyMentionMember(state.members[chip.dataset.mentionId]); return; }
  const button = e.target.closest("[data-message-id]"); if (!button || !state || busy) return;
  const id = button.dataset.messageId;
  if (button.dataset.messageAction?.startsWith("request-")) openRequestMode(button.dataset.messageAction.slice(8), id);
  else if (button.dataset.messageAction === "work") openWork(id);
  else if (button.dataset.messageAction === "decide") openDecision(id);
  else if (button.dataset.messageAction === "result") {
    const message = conversation.byId.get(id), item = state.workItems[message?.workItemId];
    if (item && workActions(item, state.members[session.member.id]).some(([action]) => action === "complete")) openWorkAction(item, "complete", id);
  }
  else if (button.dataset.messageAction === "react") setReaction(id, button.dataset.reaction);
  else if (button.dataset.messageAction === "pin") setPinned(id);
  else if (button.dataset.messageAction === "report") openReport(id);
  else if (["mute", "unmute"].includes(button.dataset.messageAction)) setMute(conversation.byId.get(id)?.authorId, button.dataset.messageAction === "mute");
  else if (["reply", "thread"].includes(button.dataset.messageAction)) {
    switchThread(conversation.rootById.get(id), button.dataset.messageAction === "reply");
    if (button.dataset.messageAction === "reply") {
      replyToId = id;
      const author = replyAuthorToAddress(session.member.id, state.members[conversation.byId.get(id)?.authorId]);
      if (author && !messageMentionsMember($("#message-input").value, author)) applyMentionMember(author);
      else if (author) {
        const select = $("#message-to-select");
        if ([...select.options].some(option => option.value === author.id)) select.value = author.id;
      }
      updateReply(); saveComposer();
    }
  }
});
function updateReply() {
  const target = conversation?.byId.get(replyToId);
  $("#reply-bar").hidden = Boolean(requestMode) || !target || replyToId === currentThreadId;
  const author = target ? replyAuthorToAddress(session?.member?.id, state.members[target.authorId]) : null;
  const addressing = Boolean(author && messageMentionsMember($("#message-input").value, author));
  $("#reply-context").textContent = target
    ? `Replying to ${name(target.authorId)}${addressing ? ` · addressing ${author.displayName}` : ""}: ${target.deletedAt ? "Message deleted" : target.body.slice(0, 100)}`
    : "";
  const mention = $("#reply-mention");
  mention.hidden = !author;
  mention.disabled = busy;
  mention.setAttribute("aria-pressed", addressing ? "true" : "false");
  mention.textContent = author ? `Also @ ${author.displayName}` : "Also @";
}
function clearReply() { replyToId = currentThreadId; updateReply(); }
$("#cancel-reply").addEventListener("click", () => { clearReply(); $("#message-input").focus({ preventScroll: true }); });
$("#reply-mention").addEventListener("click", () => {
  const target = conversation?.byId.get(replyToId);
  const author = target ? replyAuthorToAddress(session?.member?.id, state.members[target.authorId]) : null;
  if (!author) return;
  const input = $("#message-input");
  if (messageMentionsMember(input.value, author)) {
    input.value = removeMention(input.value, author);
    const select = $("#message-to-select");
    if (select.value === author.id) select.value = "";
    saveComposer();
    input.focus({ preventScroll: true });
  } else applyMentionMember(author);
  updateReply();
});
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
  const list = $("#mention-list"), input = $("#message-input");
  if (!list) return;
  list.hidden = true; list.replaceChildren(); mentionIndex = 0;
  // Closed listbox: the textarea stops pointing at an option that no longer exists.
  input?.setAttribute("aria-expanded", "false"); input?.removeAttribute("aria-activedescendant");
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
  // Each row is the option itself (role="option" + aria-selected are invalid on a
  // nested button). Focus stays in the textarea; aria-activedescendant names the row.
  list.innerHTML = matches.map((m, i) => `<li role="option" id="mention-option-${i}" class="mention-option${i === mentionIndex ? " active" : ""}" data-mention-id="${esc(m.id)}" aria-selected="${i === mentionIndex}">${esc(m.displayName)} <span>${esc(kindLabel(m.kind))}</span></li>`).join("");
  const input = $("#message-input");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", `mention-option-${mentionIndex}`);
}
function applyMentionMember(member) {
  const input = $("#message-input");
  if (!input || !member) return;
  const next = addressMember(input.value, input.selectionStart, member);
  input.value = next.body;
  const select = $("#message-to-select");
  if ([...select.options].some(option => option.value === next.toMemberId)) select.value = next.toMemberId;
  hideMentions(); saveComposer(); syncComposerChrome();
  input.focus(); input.setSelectionRange(next.caret, next.caret);
}
$("#message-input").addEventListener("input", () => { lastComposerSelection = null; saveComposer(); renderMentions(); updateReply(); });
$("#message-to-select").addEventListener("change", () => { saveComposer(); syncRequestComposer(); syncComposerChrome(); });
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
  const option = e.target.closest("[data-mention-id]");
  if (!option) return;
  e.preventDefault();
  applyMentionMember(state.members[option.dataset.mentionId]);
});
// C6: the owner's pause roster is one read when People opens and after each
// action; the row buttons never appear for non-owners or inactive agents.
async function refreshAgentPauses() {
  if (!state || !session || state.room.ownerId !== session.member.id || !can("manage_members")) return;
  const generation = client.generation;
  try {
    const view = await client.request(client.path("/agent-pause"));
    if (generation !== client.generation || !state) return;
    agentPauses = new Map((view.paused ?? []).map(p => [p.memberId, p]));
    render();
  } catch { /* the roster stays as last read; the next action re-reads it */ }
}
$("#people-panel").addEventListener("toggle", () => { if ($("#people-panel").open) refreshAgentPauses(); });
$("#presence-list").addEventListener("click", async e => {
  const pauseButton = e.target.closest("[data-member-pause]"), removeButton = e.target.closest("[data-member-remove]"), keepButton = e.target.closest("[data-member-remove-cancel]");
  if (!pauseButton && !removeButton && !keepButton) return;
  e.preventDefault();
  if (!ownsRoomActions(null) || memberActionBusy) return;
  const memberId = pauseButton?.dataset.memberPause ?? removeButton?.dataset.memberRemove ?? keepButton.dataset.memberRemoveCancel;
  const focusAction = selector => $(`#presence-list [${selector}="${CSS.escape(memberId)}"]`)?.focus();
  if (keepButton) { armedRemoval = null; render(); focusAction("data-member-remove"); return; }
  const member = state.members[memberId];
  if (!member || member.kind !== "agent" || member.active === false || state.room.ownerId !== session.member.id || !can("manage_members")) return;
  if (removeButton && armedRemoval !== memberId) { armedRemoval = memberId; render(); focusAction("data-member-remove"); return; }
  memberActionBusy = true;
  const generation = client.generation;
  try {
    if (removeButton) {
      const entry = draftCommand(null, T.MEMBER_ACCESS_CHANGED, { memberId, expectedMemberRevision: member.revision, permissions: [...member.permissions], active: false });
      armedRemoval = null;
      await client.send(entry.command);
      if (generation !== client.generation || !state) return;
      agentPauses.delete(memberId);
      notice(`${displayName(memberId)} removed. Room access and connections ended; context already delivered to its provider is not recalled.`);
    } else {
      const action = pauseButton.dataset.pauseAction;
      const view = await client.request(client.path("/agent-pause"), { method: "POST", data: { action, memberId, requestId: crypto.randomUUID(), ...(action === "pause" ? { reason: null } : {}) } });
      if (generation !== client.generation || !state) return;
      agentPauses = new Map((view.paused ?? []).map(p => [p.memberId, p]));
      notice(action === "pause" ? `${displayName(memberId)} paused: queued wakes will not start; a running attempt finishes.` : `${displayName(memberId)} resumed.`);
    }
    render();
    focusAction(removeButton ? "data-member-record-id" : "data-member-pause");
  } catch (error) {
    if (generation === client.generation && state) notice(error.message || "Action not saved. Try again.", true);
  } finally { memberActionBusy = false; }
});
$("#presence-list").addEventListener("click", e => {
  if (!shouldAddressPresenceClick(e.target)) return;
  const row = e.target.closest(".presence-member");
  const member = state?.members[row?.dataset.memberRecordId];
  if (!member || member.active === false) return;
  applyMentionMember(member);
});
function chatEscapeState() {
  return {
    dialogOpen: Boolean(document.querySelector("dialog[open]")),
    mentionOpen: Boolean($("#mention-list") && !$("#mention-list").hidden),
    replyOpen: Boolean(state && conversation?.byId.get(replyToId) && replyToId !== currentThreadId),
    inThread: Boolean(currentThreadId)
  };
}
function runEscapeChat(event) {
  if (event.key !== "Escape" || event.repeat || event.isComposing || event.keyCode === 229) return false;
  const action = escapeChatAction(chatEscapeState());
  if (!action) return false;
  event.preventDefault();
  if (action === "hide-mentions") hideMentions();
  else if (action === "clear-reply") { clearReply(); saveComposer(); }
  else if (action === "leave-thread") switchThread(null);
  return true;
}
document.addEventListener("keydown", event => {
  if ($("#main").hidden || event.target?.closest?.("dialog")) return;
  runEscapeChat(event);
});
$("#search-form").addEventListener("submit", e => { e.preventDefault(); if (state) renderSearch(); });
$("#message-search").addEventListener("input", () => { if (state) renderSearch(); });
$("#search-mentions").addEventListener("click", () => {
  const on = mentionsFilterOn();
  $("#search-mentions").setAttribute("aria-pressed", on ? "false" : "true");
  if (state) renderSearch();
});
$("#search-pinned").addEventListener("click", () => {
  const on = pinnedFilterOn();
  $("#search-pinned").setAttribute("aria-pressed", on ? "false" : "true");
  if (state) renderSearch();
});
$("#clear-search").addEventListener("click", () => {
  $("#message-search").value = "";
  $("#search-mentions").setAttribute("aria-pressed", "false");
  $("#search-pinned").setAttribute("aria-pressed", "false");
  renderSearch(); $("#message-search").focus();
});

// Navigation only: all consequential actions stay in their existing forms.
// Resolve the current target again on selection; an open menu is not authority.
function ownsRoomActions(context = roomActionsContext) {
  return Boolean(state && session && client.session === session && client.generation === roomGeneration
    && client.ownsAccountSession() && !$("#main").hidden && $("#inbox-panel").hidden
    && (!context || context.session === session && context.generation === client.generation));
}
function revealPeopleChrome() {
  $("#people-panel").open = true;
  const toggle = $("#sidebar-toggle");
  if (toggle && getComputedStyle(toggle).display !== "none") {
    $("#main").classList.add("sidebar-open");
    toggle.setAttribute("aria-expanded", "true");
  }
}
function roomActionEntries() {
  return [
    { id: "write", label: requestMode ? "Open composer" : $("#message-input").value ? "Continue writing" : "Write a message", words: "compose chat draft reply", target: "#message-input" },
    { id: "search", label: "Search room", words: "find messages work", target: "#message-search", always: true },
    { id: "mentions", label: "Mentions", words: "mentions addressed @me to:me", target: "#search-mentions", activate: true, always: true },
    { id: "pinned-search", label: "Pinned", words: "pins pinned search", target: "#search-pinned", activate: true, always: true },
    { id: "catch-up", label: "Catch up", words: "updates attention needs me reminders", always: true },
    { id: "results", label: "View results", words: "completed approved finished artifacts", always: true },
    { id: "people", label: "People", words: "members collaborators team", target: "#people-panel > summary", reveal: "#people-panel" },
    { id: "new-work", label: "New work", words: "create task request", target: "#new-work-button", activate: true },
    { id: "invite", label: "Invite people", words: "share join link", target: "#invite-people-button", activate: true },
    { id: "invite-agents", label: "Invite agents", words: "invite code redeem collaborate contribute bootstrap", target: "#invite-agents-button", reveal: "#people-panel", activate: true },
    { id: "create-room", label: "Create Room", words: "bootstrap-agent-room agent-rooms pri_ own room", target: "#create-room-details > summary", reveal: "#people-panel" },
    { id: "agent", label: "Add agent", words: "ai assistant mcp tools instinct muse grok build grokbot grok bot claude code codex cursor hermes opencode pi connect wake pull desktop takeover catalog", target: "#connect-agent-button", reveal: "#people-panel", activate: true },
    { id: "how-invite", label: "How to invite someone", words: "how guest eight hours link help", always: true },
    { id: "how-agent", label: "How to add an agent", words: "how connect instinct muse grok claude codex cursor hermes opencode pi help catalog", always: true },
    { id: "how-inbox", label: "How to open Inbox", words: "how inbox mail email account", always: true },
    { id: "instructions", label: "Room instructions", words: "guidance brief charter", always: true },
    { id: "usage", label: "Usage", words: "spend seats sessions caps limits budget headroom", always: true }
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
    revealPeopleChrome();
    const button = $("#connect-agent-button");
    const target = button && !button.hidden ? button : $("#people-panel > summary");
    target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true });
    if (button && !button.hidden) return;
    notice("The owner connects assistants from People. Instinct and Muse can Use my AI without a key.");
    return;
  }
  if (id === "how-inbox") {
    if (!$("#workspace-nav").hidden) { $("#nav-inbox").click(); return; }
    notice("Inbox uses Account key. Sign out, then choose Account key on the welcome screen.");
    return;
  }
  if (id === "catch-up") { openCatchUp(); return; }
  if (id === "results") { selectWorkView("results"); return; }
  if (id === "usage") { openSettings("usage-panel"); return; }
  if (id === "instructions") { openSettings("room-about"); $("#room-instructions-open").click(); return; }
  if (id === "search" || id === "mentions" || id === "pinned-search") {
    if ($("#search-form").hidden) $("#topbar-search-toggle").click();
  }
  if (entry.reveal === "#people-panel") revealPeopleChrome();
  else if (entry.reveal) $(entry.reveal).open = true;
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
// Pinned messages (issue #6 B2): any active member can pin or unpin a live
// message; the room keeps at most PIN_LIMIT pins in the order they were placed.
// The server re-checks membership per call and a deleted message drops out of
// the list; this is the honest view of state.pins plus the two controls.
async function setPinned(messageId) {
  if (pendingPins.has(messageId) || !state || !conversation.byId.get(messageId)) return;
  const pinned = isPinned(state, messageId);
  if (!pinned && pinnedMessages(state).length >= PIN_LIMIT) { notice(`This room already has ${PIN_LIMIT} pinned messages. Unpin one first.`, true); return; }
  // Re-entry is guarded by pendingPins rather than a disabled control, so a keyboard user's focus stays on the button.
  const pending = draftCommand(null, pinned ? T.MESSAGE_UNPINNED : T.MESSAGE_PINNED, { messageId });
  pendingPins.add(messageId);
  const generation = client.generation;
  try {
    await client.send(pending.command);
    if (generation === client.generation && state) notice(pinned ? "Message unpinned." : "Message pinned.");
  } catch (error) {
    if (generation === client.generation && state) notice(`${error.message}. Nothing was pinned or unpinned.`, true);
  } finally { pendingPins.delete(messageId); if (state && generation === client.generation) renderMessages(); }
}
function renderPinned() {
  const panel = $("#pinned-panel"), list = $("#pinned-list");
  const pins = state ? pinnedMessages(state) : [];
  panel.hidden = pins.length === 0;
  setText("#pinned-count", pins.length ? `${pins.length} of ${PIN_LIMIT}` : "");
  if (!pins.length) { list.innerHTML = ""; return; }
  const html = pins.map(({ message: m, pinnedById }) => `<li class="pinned-item" data-pinned-message="${esc(m.id)}"><a class="source-link pinned-link" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}">${esc(displayName(m.authorId))} · <time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a><p class="pinned-body">${esc(m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body)}</p><span class="pinned-meta">Pinned by ${esc(displayName(pinnedById))}</span><button type="button" class="text-button" data-message-action="pin" data-message-id="${esc(m.id)}" aria-label="Unpin message by ${esc(displayName(m.authorId))}">Unpin</button></li>`).join("");
  if (list.innerHTML !== html) {
    // Keyboard users keep their place: the same item's control when it is still there,
    // otherwise the neighbouring item, otherwise the section heading. Focus never falls to the page body.
    const focusedItem = list.contains(document.activeElement) ? document.activeElement.closest("[data-pinned-message]") : null;
    const focusedId = focusedItem?.dataset.pinnedMessage, focusedIndex = focusedItem ? [...list.children].indexOf(focusedItem) : -1;
    list.innerHTML = html;
    if (focusedItem) {
      const buttons = [...list.querySelectorAll("button")];
      const target = list.querySelector(`[data-pinned-message="${CSS.escape(focusedId)}"] button`) ?? buttons[Math.min(focusedIndex, buttons.length - 1)] ?? $("#pinned-panel > summary");
      target.focus({ preventScroll: true });
    }
  }
}
$("#pinned-list").addEventListener("click", e => {
  const button = e.target.closest("[data-message-action=\"pin\"]");
  if (button && state && !busy) setPinned(button.dataset.messageId);
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
    pendingReactions.delete(key);
  } catch (error) {
    if (generation === client.generation && state) { pending.busy = false; notice(`${error.message}. Retry keeps the same reaction choice.`, true); }
  } finally { if (state && generation === client.generation) renderMessages(); }
}

// Decision register (backlog F2): a human with decide promotes a message into
// a source-backed decision; the room reads the register from the event feed.
let decisionSourceId = null;
function openDecision(messageId) {
  if (!can("decide") || busy || state.members[session.member.id]?.kind !== "human") return;
  const message = conversation.byId.get(messageId);
  if (!message) return;
  decisionSourceId = messageId;
  $("#decision-form").reset();
  $("#decision-source").textContent = `Source: ${name(message.authorId)}: ${message.deletedAt ? "Message deleted" : message.body.slice(0, 200)}`;
  setFormStatus($("#decision-status"), "");
  $("#decision-dialog").showModal();
  $("#decision-statement-input").focus();
}
$("#close-decision").addEventListener("click", () => { if (!busy) $("#decision-dialog").close(); });
$("#decision-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) $("#decision-dialog").close(); });
$("#decision-form").addEventListener("submit", e => {
  e.preventDefault();
  const data = { sourceMessageId: decisionSourceId, statement: $("#decision-statement-input").value.trim() };
  const note = $("#decision-note-input").value.trim();
  if (note) data.note = note;
  let entry;
  try { entry = draftCommand(null, T.DECISION_RECORDED, data); }
  catch (error) { setFormStatus($("#decision-status"), error.message, true); return; }
  submit($("#decision-form"), async () => {
    await client.send(entry.command);
    if (!state) return;
    $("#decision-dialog").close();
    decisionSourceId = null;
    notice("Decision recorded.");
  }, { failureHint: "Decision not saved. Retry the same entry, or close and start again." });
});
// Room spend allowance (issue #6 C3): every member sees allowance, spent,
// reserved, held and headroom from the same ledger the server enforces at
// session start; only the room owner sees the controls. Unknown spend is
// named (held, unreported), never rendered as zero.
const usd = cents => `$${(cents / 100).toFixed(2)}`;
const countOf = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
let spendFormRevision = null;
function renderSpendAllowance() {
  const panel = $("#spend-panel");
  if (!panel || !state?.room) return;
  const allowance = spendAllowance(state);
  const ledger = spendLedger(state, { nowMs: Date.now(), periodDays: allowance?.periodDays ?? 30 });
  const owner = session?.member?.id === state.room.ownerId && state.members[session.member.id]?.kind === "human";
  const committed = ledger.committedCents;
  panel.dataset.spendAllowance = !allowance ? "none" : committed > allowance.allowanceCents ? "over" : committed >= allowance.allowanceCents ? "full" : "set";
  setText("#spend-summary", allowance ? `${usd(committed)} of ${usd(allowance.allowanceCents)}` : "No allowance");
  const parts = [`${usd(ledger.spentCents)} spent`, `${usd(ledger.reservedCents)} reserved by ${countOf(ledger.sessions.live, "live session")}`];
  if (ledger.heldCents) parts.push(`${usd(ledger.heldCents)} held for ${countOf(ledger.sessions.attemptsHeld, "unreported attempt")}`);
  if (ledger.sessions.attemptsUnreported) parts.push(`${countOf(ledger.sessions.attemptsUnreported, "attempt")} with unknown spend`);
  const period = `over ${countOf(ledger.periodDays, "day")}`;
  setText("#spend-figures", allowance
    ? `${parts.join(" · ")} · ${committed > allowance.allowanceCents ? `over by ${usd(committed - allowance.allowanceCents)}` : `${usd(allowance.allowanceCents - committed)} left`} ${period}.`
    : `${parts.join(" · ")} ${period}. ${owner ? "Set an allowance to cap what agent sessions may commit here." : "The room owner has not set a spend allowance."}`);
  setText("#spend-note", allowance
    ? `Sessions must declare their maximum spend to start; the room reserves it until the run stops. Only the room owner can change this.`
    : "");
  const form = $("#spend-allowance-form");
  form.hidden = !owner;
  $("#spend-allowance-remove").hidden = !owner || !allowance;
  const revision = allowance?.revision ?? 0;
  if (owner && spendFormRevision !== revision && !form.contains(document.activeElement)) {
    spendFormRevision = revision;
    $("#spend-allowance-input").value = allowance ? (allowance.allowanceCents / 100).toFixed(2) : "";
    $("#spend-period-input").value = String(allowance?.periodDays ?? 30);
  }
}
function submitSpendAllowance(data, done, failureHint) {
  const form = $("#spend-allowance-form");
  let entry;
  try { entry = draftCommand(null, T.ROOM_SPEND_ALLOWANCE_SET, data); }
  catch (error) { setFormStatus(form.querySelector(".form-status"), error.message, true); return; }
  submit(form, async () => { await client.send(entry.command); if (!state) return; notice(done); }, { failureHint });
}
$("#spend-allowance-form").addEventListener("submit", e => {
  e.preventDefault();
  const dollarsText = $("#spend-allowance-input").value.trim(), periodDays = Number($("#spend-period-input").value);
  const allowanceCents = Math.round(Number(dollarsText) * 100);
  if (!dollarsText || !Number.isSafeInteger(allowanceCents) || allowanceCents < 0 || !Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 365) {
    setFormStatus($("#spend-allowance-form .form-status"), "Enter the allowance in dollars (0 or more) and a period of 1 to 365 days.", true); return;
  }
  submitSpendAllowance({ allowanceCents, periodDays }, "Spend allowance set.", "Allowance not saved. Retry the same values.");
});
$("#spend-allowance-remove").addEventListener("click", () => {
  submitSpendAllowance({ allowanceCents: null }, "Spend allowance removed.", "Allowance not removed. Retry.");
});

// Moderation (issue #6 E4): report a message to the room owner; mute an author
// for yourself. A report is a private record the owner alone can list (no room
// event, nothing leaves the room); a mute is the viewer's own preference event.
let reportSourceId = null, reportsFlight = null, reportsSequence = -1, reportsGeneration = -1;
function openReport(messageId) {
  if (busy) return;
  const message = conversation.byId.get(messageId);
  if (!message || message.deletedAt || message.authorId === session.member.id) return;
  reportSourceId = messageId;
  $("#report-form").reset();
  $("#report-source").textContent = `Message from ${name(message.authorId)}: ${message.body.slice(0, 200)}`;
  setFormStatus($("#report-status"), "");
  $("#report-dialog").showModal();
  $("#report-reason-input").focus();
}
$("#close-report").addEventListener("click", () => { if (!busy) $("#report-dialog").close(); });
$("#report-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) $("#report-dialog").close(); });
$("#report-form").addEventListener("submit", e => {
  e.preventDefault();
  const reason = $("#report-reason-input").value.trim();
  if (!reason) { setFormStatus($("#report-status"), "Say briefly why you are reporting this message.", true); return; }
  submit($("#report-form"), async () => {
    const result = await client.reports({ messageId: reportSourceId, reason });
    if (!state || !result) return;
    $("#report-dialog").close();
    reportSourceId = null;
    notice(result.duplicate ? "You already reported this message; the room owner has it." : "Report sent to the room owner. Only the owner sees it.");
  }, { failureHint: "Report not sent. Retry the same reason, or close and start again." });
});
async function setMute(memberId, muted) {
  const target = state?.members[memberId];
  if (!target || busy || memberId === session.member.id) return;
  const entry = draftCommand(null, T.MEMBER_MUTE_SET, { memberId, muted });
  const generation = client.generation;
  try {
    await client.send(entry.command);
    if (generation !== client.generation || !state) return;
    notice(muted ? `${target.displayName} muted for you. Their messages are hidden here until you unmute; nobody else is affected.` : `${target.displayName} unmuted.`);
  } catch (error) {
    if (generation === client.generation && state) notice(`${requestFailureMessage(error)}. Your mute choice was not changed.`, true);
  }
}
$("#presence-list").addEventListener("click", e => {
  const button = e.target.closest("[data-mute-member]");
  if (button && state) setMute(button.dataset.muteMember, button.dataset.muted !== "true");
});
function syncReports() {
  const owner = Boolean(state && session && state.room?.ownerId === session.member.id && state.members[session.member.id]?.kind === "human");
  $("#reports-section").hidden = !owner;
  if (!owner) { reportsSequence = -1; return; }
  if ($("#reports-section").open && (reportsSequence !== client.sequence || reportsGeneration !== client.generation)) loadReports();
}
function loadReports() {
  if (reportsFlight) return;
  const generation = client.generation, sequence = client.sequence;
  reportsFlight = client.reports().then(result => {
    if (generation !== client.generation || !state || !result) return;
    reportsSequence = sequence; reportsGeneration = generation;
    renderReports(result.reports);
  }).catch(error => {
    if (generation === client.generation && state) setFormStatus($("#report-list-status"), `${requestFailureMessage(error)}. Open this section again to retry.`, true);
  }).finally(() => { reportsFlight = null; });
}
function renderReports(reports) {
  setFormStatus($("#report-list-status"), "");
  setText("#report-count", reports.length ? String(reports.length) : "");
  renderContent("#report-list", reports.map(report => {
    const message = report.message;
    const excerpt = !message ? "Message no longer in this room" : message.deletedAt ? "Message deleted" : message.body.slice(0, 160);
    return `<li data-report-id="${esc(report.id)}"><strong>${esc(report.reason)}</strong> <span class="rb-detail">reported by ${esc(memberLabel(report.reporterId))} · ${esc(time(report.createdAt))}</span><br><a class="source-link" href="${esc(recordHref("message", report.messageId))}" data-open-message="${esc(report.messageId)}">${esc(memberLabel(report.authorId))}: ${esc(excerpt)}</a></li>`;
  }).join("") || '<li class="rb-empty">No reports. Members report a message from its Report action; only you see them here.</li>');
}
$("#reports-section").addEventListener("toggle", () => { if ($("#reports-section").open) syncReports(); });
// Reports append no room event, so a new one does not move the stream; the owner can ask again.
$("#report-refresh").addEventListener("click", () => { reportsSequence = -1; syncReports(); });
// Room policy (issue #6 A4): when the owner made review or approval mandatory,
// the proposer sees the requirement locked on with the reason. The server
// enforces it regardless of what a client sends; this is only the honest view.
function syncWorkPolicy() {
  const policy = roomPolicy(state);
  for (const [id, required] of [["#require-verification", policy.requireIndependentReview], ["#require-decision", policy.requireOwnerDecision]]) {
    const box = $(id);
    if (required) box.checked = true;
    box.disabled = required;
  }
  const required = [policy.requireIndependentReview && "independent review", policy.requireOwnerDecision && "owner approval"].filter(Boolean);
  // The "turn off review" escape does not exist under policy; say so and drop the settings shortcut.
  $("#reviewer-unavailable-text").textContent = policy.requireIndependentReview
    ? "No independent reviewer available. Room policy requires review: change the owner, or ask the room owner to add a reviewer."
    : "No independent reviewer available. Change the owner or turn off review.";
  $("#review-settings-button").hidden = policy.requireIndependentReview;
  $("#work-policy-note").hidden = required.length === 0;
  $("#work-policy-note").textContent = required.length ? `Room policy: ${required.join(" and ")} ${required.length > 1 ? "are" : "is"} required for every new outcome in this room. Only the room owner can change this.` : "";
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
  const recipeSelect = $("#work-recipe-select");
  if (definition || sourceId) $("#work-recipe-field").hidden = true;
  else {
    const recipes = workRecipeOptions(state.workItems);
    recipeSelect.replaceChildren(new Option("Blank outcome", ""));
    for (const recipe of recipes) recipeSelect.add(new Option(recipe.title.replace(/\s+/g, " ").slice(0, 80), recipe.workItemId));
    $("#work-recipe-field").hidden = recipes.length === 0;
  }
  $("#source-context").textContent = sourceId ? `Source: ${state.messages.find(m => m.id === sourceId)?.body || ""}` : "";
  $("#source-context").hidden = !sourceId; $("#work-title-input").focus();
  syncWorkForm();
}
function closeWorkForm({ returnFocus = true } = {}) {
  const unconfirmed = workRetryLocked;
  $("#work-dialog").close();
  $("#new-work-form").hidden = true; $("#new-work-form").reset();
  setWorkRetry(false); $("#work-reuse-hint").hidden = true; $("#work-recipe-field").hidden = true;
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
    const target = [opener?.node, replacement, $("#new-work-button"), $("#composer-work-button")].find(usable) || $("#conversation-title");
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
$("#work-recipe-select").addEventListener("change", event => {
  const recipeId = event.target.value;
  if (!recipeId) { $("#work-title-input").value = ""; $("#work-done-input").value = ""; return; }
  const item = state?.workItems?.[recipeId];
  if (!item) return;
  try {
    const recipe = reusableWorkDefinition(item);
    $("#work-title-input").value = recipe.title;
    $("#work-done-input").value = recipe.definitionOfDone;
  } catch { /* Definition changed since the list was built; leave the fields as they are. */ }
});
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
$("#message-list").addEventListener("click", e => {
  if (e.target.closest("[data-empty-work]")) { $("#new-work-button").click(); return; }
  if (e.target.closest("[data-empty-suggest]")) { $("#message-input").focus(); return; }
  const button = e.target.closest("[data-reuse-work]");
  if (button) openWork(null, button.dataset.reuseWork);
});
document.addEventListener("click", async e => {
  const button = e.target.closest("[data-access-preview]");
  if (!button || !state || !session) return;
  const workId = button.dataset.accessPreview;
  if (accessPreviews.has(workId)) { accessPreviews.delete(workId); renderReturnBrief(); return; }
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  button.disabled = true;
  try {
    const context = await client.workContext(workId);
    if (!context || !sameSession(generation, roomId, memberId)) return;
    accessPreviews.set(workId, { summary: context.accessSummary, evaluatedAt: context.evaluatedAt });
  } catch (error) {
    if (!sameSession(generation, roomId, memberId)) return;
    accessPreviews.set(workId, { error: `Access preview could not be loaded (${error.code || error.status || "request failed"}); try again.` });
  } finally {
    button.disabled = false;
  }
  renderReturnBrief();
  document.querySelector(`[data-access-preview="${CSS.escape(workId)}"]`)?.focus();
});
document.addEventListener("click", async e => {
  const button = e.target.closest("[data-work-changes]");
  if (!button || !state) return;
  const list = document.querySelector(`[data-changes-list="${CSS.escape(button.dataset.workChanges)}"]`);
  if (!list) return;
  if (!list.hidden) { list.hidden = true; return; }
  button.disabled = true;
  try {
    const history = await client.request(client.path(`/work-changes?workItemId=${encodeURIComponent(button.dataset.workChanges)}&since=${encodeURIComponent(button.dataset.basis)}`));
    list.innerHTML = history.changes.length
      ? `<ul>${history.changes.map(change => `<li><strong>r${esc(String(change.revision))}</strong> ${esc(changeDescription(change))}${change.actorId ? ` · ${esc(memberLabel(change.actorId))}` : ""}${change.at ? ` · ${esc(new Date(change.at).toLocaleString())}` : ""}</li>`).join("")}</ul>`
      : `<p class="form-hint">No recorded changes after that revision.</p>`;
    list.hidden = false;
  } catch (error) {
    list.innerHTML = `<p class="form-hint">Changes could not be loaded; try again.</p>`;
    list.hidden = false;
  } finally {
    button.disabled = false;
  }
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
// Work and results now live in the single timeline (work) and the settings
// dialog (results); the old Work/Results tab toggle is gone. selectWorkView
// stays as a seam for callers: "results" opens Settings at Results.
function openSettings(panelId) {
  const dialog = $("#settings-dialog");
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  if (panelId) {
    const panel = document.getElementById(panelId);
    if (panel) { panel.open = true; panel.querySelector("summary")?.focus({ preventScroll: true }); }
  }
}
function openCatchUp() {
  const dialog = $("#catchup-dialog");
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  $("#return-brief-panel").open = true;
  $("#return-brief-panel > summary").focus({ preventScroll: true });
  loadReturnBrief();
}
function selectWorkView(view) {
  if (view === "results") openSettings("results-panel");
}
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
    if (view.fromResults) {
      const row = [...$("#room-results-list").querySelectorAll("[data-result-work-id]")].find(node => node.dataset.resultWorkId === view.workItemId);
      (row?.querySelector("[data-read-result]") || $("#results-panel > summary")).focus({ preventScroll: true });
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
    const diffBox = $("#result-diff"); diffBox.hidden = true; diffBox.innerHTML = "";
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
      // F4: a resubmitted result names its previous version; show the changed
      // bytes and restate that earlier approval never carries over.
      const previousId = receipt.nativeText.previousCompletionEventId;
      if (previousId) {
        client.workResult(item.id, { completionEventId: previousId }).then(previous => {
          if (!owns() || !previous) return;
          if (previous.result?.receipt?.eventId !== previousId) throw new Error("Pinned previous version changed");
          const before = previous.result?.text?.body;
          if (typeof before !== "string") throw new Error("Previous version has no exact text");
          const rows = diffResultLines(before, value.result.text.body);
          const note = "Previous approval never carries over; review the exact new text.";
          diffBox.innerHTML = rows === null
            ? `<p class="form-hint"><strong>Resubmitted result.</strong> The previous version differs but is too large to compare line by line. ${esc(note)}</p>`
            : (() => { const summary = diffResultSummary(rows);
                const body = rows.length > 200 ? rows.slice(0, 200) : rows;
                return `<p class="form-hint"><strong>Resubmitted result.</strong> ${summary.removedLines} lines removed, ${summary.addedLines} added (${summary.changedBytes} changed bytes). ${esc(note)}</p>` +
                  (summary.changedBytes ? `<pre class="result-diff">${body.map(row => `<span class="diff-${row.type}">${esc(row.type === "added" ? "+ " : row.type === "removed" ? "- " : "  ")}${esc(row.text)}</span>`).join("\n")}${rows.length > 200 ? `<span class="form-hint">… ${rows.length - 200} more rows</span>` : ""}</pre>` : `<p class="form-hint">No text changes from the previous version.</p>`);
              })();
          diffBox.hidden = false;
        }).catch(() => {
          if (!owns()) return;
          diffBox.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> The earlier version could not be loaded for comparison. Previous approval never carries over; review the exact new text.</p>`;
          diffBox.hidden = false;
        });
      }
    }).catch(() => { if (owns()) { view.error = true; resultStatus(); } });
    return;
  }
  const button = e.target.closest("[data-action]"); if (!button || busy) return;
  openWorkAction(state.workItems[button.dataset.workId], button.dataset.action, null, button.dataset.offerId);
}
$("#message-list").addEventListener("click", readResult);
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
  const entry = pendingAction, changed = actionChanged(entry);
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
// Notification feed (B4): items are derived on the server from events after your
// caught-up marker and filtered by your notification preferences. Fetching never
// acknowledges; "Mark read" moves the marker to exactly the sequence the list was
// evaluated through, so items arriving later stay unread.
let notificationOwner = null, notificationFeed = null, notificationSerial = 0, notificationBusy = false, notificationError = "", notificationTimer = null;
// New room events are coalesced: the feed refetches at most once per window while the tab is visible.
const NOTIFICATION_COALESCE_MS = 1500;
const NOTIFICATION_LABELS = { mention: "mentioned you", reply: "replied to you", assignment: "named you on work", work_update: "updated work you are on" };
const ownsNotifications = ticket => Boolean(ticket) && notificationOwner === ticket && client.generation === ticket.generation && client.session === ticket.session && client.ownsAccountSession();
function resetNotifications() {
  notificationSerial++; notificationOwner = null; notificationFeed = null; notificationBusy = false; notificationError = "";
  clearTimeout(notificationTimer); notificationTimer = null;
  $("#notification-count").textContent = ""; $("#notification-count").hidden = true;
  $("#notification-panel").hidden = true; $("#notification-list").replaceChildren(); delete $("#notification-list")._content;
  $("#notification-status").textContent = ""; $("#notification-status").classList.remove("visible");
  $("#notification-read-button").hidden = true; $("#notification-read-button").disabled = true; $("#notification-read-button").textContent = "Mark read";
}
function renderNotifications() {
  const owned = Boolean(state) && ownsNotifications(notificationOwner);
  const feed = owned ? notificationFeed : null, items = feed?.notifications ?? [], count = feed?.unread ?? 0;
  const badge = $("#notification-count");
  badge.textContent = count ? `${count} for you` : ""; badge.hidden = !count;
  $("#notification-panel").hidden = !owned;
  const note = notificationError || (feed?.basis?.truncated ? `Showing changes since event ${feed.basis.from}. Older updates are under Updates.` : "");
  setText("#notification-status", note);
  $("#notification-status").classList.toggle("visible", Boolean(note));
  $("#notification-read-button").hidden = !owned || !count;
  $("#notification-read-button").disabled = !owned || notificationBusy || !count;
  $("#notification-read-button").textContent = notificationBusy ? "Marking read…" : "Mark read";
  renderBriefList("#notification-list", items.map(item => {
    const target = item.messageId ? { kind: "message", id: item.messageId } : { kind: "work", id: item.workItemId };
    const detail = item.messageId ? (conversation?.byId.get(item.messageId)?.body ?? "").slice(0, 80) : (state.workItems[item.workItemId]?.title ?? item.workItemId);
    const label = `${memberLabel(item.actorId)} ${NOTIFICATION_LABELS[item.kind] ?? humanize(item.kind)}${item.changes > 1 ? ` · ${item.changes} changes` : ""}`;
    return `<li class="rb-event notification-item" data-notification-kind="${esc(item.kind)}"><a class="rb-event-link" href="${esc(recordHref(target.kind, target.id))}" data-open-${target.kind}="${esc(target.id)}" data-brief-key="notification:${esc(item.kind)}:${esc(target.id)}"><span class="rb-actor">${esc(label)}</span><time datetime="${esc(item.at)}">${esc(time(item.at))}</time>${detail ? `<span class="rb-detail">${esc(detail)}</span>` : ""}</a></li>`;
  }).join("") || (owned && feed && !notificationError ? '<li class="rb-empty">Nothing new for you.</li>' : ""));
}
async function loadNotifications() {
  const ticket = notificationOwner, request = ++notificationSerial;
  if (!ownsNotifications(ticket)) return;
  try {
    const result = await client.notifications();
    if (!ownsNotifications(ticket) || request !== notificationSerial || !result) return;
    notificationFeed = result; notificationError = "";
  } catch {
    if (!ownsNotifications(ticket) || request !== notificationSerial) return;
    notificationError = "Notifications could not refresh.";
  }
  renderNotifications();
}
function scheduleNotifications(delay) {
  // One pending fetch at a time; an immediate request replaces a coalesced one.
  if (notificationTimer !== null && delay > 0) return;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { notificationTimer = null; void loadNotifications(); }, delay);
}
function syncNotifications() {
  if (!client.session || !client.ownsAccountSession() || !state) { resetNotifications(); return; }
  if (!ownsNotifications(notificationOwner)) { resetNotifications(); notificationOwner = { generation: client.generation, session: client.session, inputs: null, sequence: null }; }
  // Inputs that change the feed directly refetch at once: your cursor, your membership
  // revision and your preferences. New room events only coalesce a refetch, and a hidden
  // tab waits until it is visible again.
  const me = state.members[session.member.id];
  const inputs = `${roomCursor}:${me?.revision ?? ""}:${JSON.stringify(me?.notificationPreferences ?? null)}`;
  if (notificationOwner.inputs !== inputs) { notificationOwner.inputs = inputs; notificationOwner.sequence = client.sequence; scheduleNotifications(0); }
  else if (notificationOwner.sequence !== client.sequence) {
    notificationOwner.sequence = client.sequence;
    if (document.visibilityState === "hidden") notificationOwner.stale = true; else scheduleNotifications(NOTIFICATION_COALESCE_MS);
  }
  renderNotifications();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" && ownsNotifications(notificationOwner) && notificationOwner.stale) { notificationOwner.stale = false; scheduleNotifications(0); }
});
$("#notification-read-button").addEventListener("click", async () => {
  const ticket = notificationOwner, feed = notificationFeed;
  if (!ownsNotifications(ticket) || !feed?.unread || notificationBusy) return;
  notificationBusy = true; renderNotifications();
  let saved = false;
  try {
    const result = await client.caughtUp(feed.sequence); // Exactly what the list was evaluated through.
    if (!ownsNotifications(ticket) || !result) return;
    saved = true; roomCursor = Math.max(roomCursor, result.cursor); notificationError = "";
    await client.refresh();
    if (!ownsNotifications(ticket)) return;
    void loadReturnBrief();
  } catch (error) {
    if (!ownsNotifications(ticket)) return;
    // Truthful feedback: a stored marker is never reported as a failed save.
    if (saved) notice("Marked read. The latest room view could not be refreshed; refresh before relying on this list.", true);
    else notificationError = "Could not mark read. Try again.";
    if ([401, 403].includes(error.status)) client.handleFailure(error);
  } finally {
    if (ownsNotifications(ticket)) { notificationBusy = false; syncNotifications(); }
  }
});
const roleLabel = role => ({ accountableMemberId: "accountable", verifierMemberId: "verifier", humanDecisionMakerId: "decision maker" }[role] ?? humanize(role));
const BRIEF_GROUP_LABELS = { outcome: "Results", question: "Asked of you", blocker: "Blockers", decision: "Decisions", other: "Other updates" };
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
  if (key === "hello") {
    if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
    switchThread(null, true);
    return;
  }
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
    syncTimelineWork();
    const resultFocus = $("#room-results-list").contains(document.activeElement) ? document.activeElement : null;
    renderContent("#room-results-list", completedResults(state).map(resultRow).join("") || '<li class="empty-note">No completed results yet.</li>');
    if (resultFocus && !resultFocus.isConnected && document.activeElement === document.body) $("#results-panel > summary").focus({ preventScroll: true });
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
  const historyGroups = groupBriefHistory(history.items, session?.member?.id);
  renderBriefList("#rb-history-list", (historyGroups.length
    ? historyGroups.map(([name, items]) =>
      `<li class="rb-group"><span class="rb-group-label">${esc(BRIEF_GROUP_LABELS[name])} (${items.length})</span><ul class="rb-list rb-group-list">${items.map(describeBriefEvent).join("")}</ul></li>`).join("")
    : history.items.map(describeBriefEvent).join(""))
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
// F5: read-only usage summary card. Loaded when the card opens (and on
// Refresh), never on every snapshot: the figures are a period summary, not a
// live feed. Spend is what agents reported; "unknown" is rendered as such.
let usageRequest = 0;
const usageNumber = value => Number(value).toLocaleString("en-US");
const usageMoney = cents => cents === "unknown" ? "unknown" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usageBytes = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
function usageCapRow(label, cap, format = usageNumber) {
  return `<dt>${esc(label)}</dt><dd>${esc(format(cap.used))} of ${esc(format(cap.limit))}<small>${esc(format(cap.remaining))} left</small></dd>`;
}
async function loadUsage() {
  if (!state || !client.session) return;
  const request = ++usageRequest;
  $("#usage-status").textContent = "Loading usage…";
  $("#usage-refresh").hidden = true;
  try {
    const usage = await client.request(client.path("/usage"));
    if (request !== usageRequest || !state) return;
    const { members, sessions, spend, spendAllowance: ledger, caps, period } = usage;
    const spendNote = spend.reportedCents === "unknown" ? "no session reported spend"
      : spend.sessionsUnreported ? `${usageNumber(spend.sessionsUnreported)} of ${usageNumber(spend.sessionsReported + spend.sessionsUnreported)} sessions unreported` : "every session reported";
    $("#usage-period").textContent = `${period.days}d`;
    const group = (heading, rows) => `<h3 class="usage-heading">${esc(heading)}</h3><dl>${rows.join("")}</dl>`;
    renderContent("#usage-grid", [
      group("Seats", [
        `<dt>People</dt><dd>${esc(usageNumber(members.humans))}</dd>`,
        `<dt>Agents</dt><dd>${esc(usageNumber(members.agents))}${members.agentIdentities ? `<small>${esc(usageNumber(members.agentIdentities))} via managed identities</small>` : ""}</dd>`
      ]),
      group(`Last ${period.days} days`, [
        `<dt>Sessions started</dt><dd>${esc(usageNumber(sessions.started))}</dd>`,
        `<dt>Sessions stopped</dt><dd>${esc(usageNumber(sessions.stopped))}${sessions.budgetStops ? `<small>${esc(usageNumber(sessions.budgetStops))} stopped by budget</small>` : ""}</dd>`,
        `<dt>Reported spend</dt><dd>${esc(usageMoney(spend.reportedCents))}<small>${esc(spendNote)}</small></dd>`
      ]),
      // C3: the allowance ledger over its own period; "Agent spend" keeps the owner controls.
      group("Spend allowance", [
        `<dt>Allowance</dt><dd data-usage-allowance="${ledger.allowance ? "set" : "none"}">${ledger.allowance ? `${esc(usageMoney(ledger.allowance.allowanceCents))}<small>over ${esc(usageNumber(ledger.period.days))} days</small>` : "none set"}</dd>`,
        `<dt>Spent</dt><dd>${esc(usageMoney(ledger.spentCents))}</dd>`,
        `<dt>Reserved</dt><dd>${esc(usageMoney(ledger.reservedCents))}<small>${esc(usageNumber(ledger.sessions.live))} live</small></dd>`,
        ...(ledger.heldCents ? [`<dt>Held</dt><dd>${esc(usageMoney(ledger.heldCents))}<small>unreported attempts</small></dd>`] : []),
        `<dt>Headroom</dt><dd>${ledger.allowance ? esc(ledger.overCents ? `over by ${usageMoney(ledger.overCents)}` : usageMoney(ledger.headroomCents)) : "no cap"}</dd>`
      ]),
      group("Pilot caps", [
        usageCapRow("Members", caps.members),
        usageCapRow("Work items", caps.workItems),
        usageCapRow("Room history", caps.events),
        usageCapRow("Room size", caps.projectionBytes, usageBytes)
      ])
    ].join(""));
    $("#usage-status").textContent = "";
  } catch (error) {
    if (request !== usageRequest || !state) return;
    $("#usage-status").textContent = error.status === 429 ? "Usage is rate limited; try again in a minute." : "Usage could not be loaded.";
    $("#usage-refresh").hidden = false;
  }
}
$("#usage-panel").addEventListener("toggle", e => { if (e.currentTarget.open) loadUsage(); });
$("#usage-refresh").addEventListener("click", () => loadUsage());
// BUILD-01 F2 follow-up: any member can take the readable export with them.
// The client fetches it with the room headers and the page hands the file to
// the browser; the server decides who may export (the same check as JSONL).
let exportRequest = 0;
async function exportRoomHtml() {
  if (!state || !client.session) return;
  const request = ++exportRequest, button = $("#record-export-html"), status = $("#record-export-status");
  button.disabled = true; status.textContent = "Preparing the export…";
  try {
    const { blob, filename } = await client.exportHtml();
    if (request !== exportRequest || !state) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = `Download started: ${filename}. Deleted messages appear as deleted, as members saw them.`;
  } catch (error) {
    if (request !== exportRequest || !state) return;
    status.textContent = error.status === 429 ? "Export is rate limited; try again in a minute." : "The export could not be prepared. Try again.";
  } finally { if (request === exportRequest) button.disabled = false; }
}
$("#record-export-html").addEventListener("click", () => exportRoomHtml());
$("#topbar-catchup").addEventListener("click", () => { if (state && !busy) openCatchUp(); });
$("#sidebar-toggle").addEventListener("click", () => {
  const shell = $("#main"), open = shell.classList.toggle("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("#room-sidebar .channel.is-active")?.focus();
});
document.addEventListener("click", event => {
  const shell = $("#main");
  if (!shell.classList.contains("sidebar-open")) return;
  if (event.target.closest("#room-sidebar") || event.target.closest("#sidebar-toggle")) return;
  shell.classList.remove("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const shell = $("#main");
  if (!shell.classList.contains("sidebar-open")) return;
  shell.classList.remove("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  $("#sidebar-toggle").focus();
});
$("#topbar-settings").addEventListener("click", () => openSettings());
$("#catchup-close").addEventListener("click", () => $("#catchup-dialog").close());
$("#settings-close").addEventListener("click", () => $("#settings-dialog").close());
$("#topbar-search-toggle").addEventListener("click", () => {
  const form = $("#search-form"), show = form.hidden;
  form.hidden = !show;
  $("#topbar-search-toggle").setAttribute("aria-expanded", String(show));
  if (show) $("#message-search").focus();
  else { $("#message-search").value = ""; renderSearch(Date.now()); }
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
  listPurposes: () => Object.values(state?.workItems ?? {}).map(item => ({ id: item.id, title: item.title,
    done: ["complete", "superseded"].includes(nextWorkStep(item).action) })),
  onJoinedRoom: focus => {
    if (focus.kind === "work" && state?.workItems[focus.id]) {
      revealWork(focus.id);
      notice(`You're here to help with "${state.workItems[focus.id].title}".`);
    } else if (focus.kind === "message" && conversation.byId.has(focus.id)) {
      revealMessage(focus.id);
    } else {
      notice("The item this invitation pointed to is no longer in this room.");
    }
  },
  async openRoom(roomId, roomMode, joinedSession) {
    if (state && session?.roomId === roomId && session.member.id === joinedSession?.member?.id
      && session.account?.id === joinedSession.account?.id && session.sessionBinding === joinedSession.sessionBinding) {
      await client.refresh();
      if (!state || !session) throw new Error("Room access changed. Reopen the invitation.");
      return;
    }
    accessEndContext = "accepted-room-switch";
    client.endAccess();
    history.replaceState(history.state, "", roomMode ? location.pathname : roomHandoffLocation(roomId));
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
      setFormStatus($("#auth-error"), initialGoogleFailed
        ? "Google sign-in didn't finish — it may have been cancelled, or Google declined the request. Try again, or sign in with an account key instead."
        : initialGitHubFailed
        ? "GitHub sign-in didn't finish — it may have been cancelled, or GitHub declined the request. Try again, or sign in another way."
        : "");
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
  // QAU-006: only probe for a session when a browser hint says one could
  // exist. A signed-out first paint with no remembered room or account hint
  // would 401 the GET /api/session probe, and the browser surfaces that as a
  // console error on the welcome screen — so skip the probe and render the
  // signed-out state directly.
  if (hasSessionHint()) {
    try {
      await client.restore();
      return;
    } catch (error) {
      if (![401, 403].includes(error.status)) throw error;
    }
    let account = null;
    try { account = await ensureAccountSession(); } catch { account = null; }
    if (account?.authenticated) {
      const lastRoom = readLastRoom();
      if (lastRoom) {
        try {
          history.replaceState(history.state, "", roomHandoffLocation(lastRoom));
          configureAuthPanel(lastRoom);
          await client.restore(lastRoom);
          return;
        } catch (error) {
          if (![401, 403].includes(error.status)) throw error;
        }
      }
      showAccountWorkspace();
      syncSessionRestore();
      return;
    }
  }
  syncSessionRestore();
  throw Object.assign(new Error("sign in required"), { status: 401 });
})().catch(error => {
  if (accountClient.session?.authenticated && [401, 403].includes(error.status)) {
    showAccountWorkspace(); confirmAccount(); return;
  }
  const signedOut = [401, 403].includes(error.status);
  if (signedOut) recovery.clear();
  const requestedRoom = selectedRoomFromLocation();
  setFormStatus($("#auth-error"), initialGoogleFailed
    ? "Google sign-in didn't finish — it may have been cancelled, or Google declined the request. Try again, or sign in with an account key instead."
    : initialGitHubFailed
    ? "GitHub sign-in didn't finish — it may have been cancelled, or GitHub declined the request. Try again, or sign in another way."
    : signedOut
    ? requestedRoom ? `This account cannot open #${requestedRoom}. Use an account with active membership there.` : ""
    : unreachableRoomMessage(error), true);
  setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
  $("#identity-label").textContent = signedOut ? "Not signed in" : "Session unavailable";
  $("#auth-panel").hidden = false;
  if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
});
