import { EVENT_TYPES as T, WORK_STATES as S } from "./events.js";
import { AccountClient, RoomClient, draftCommand } from "./client.js";
import { ReturnBrief } from "./return-brief.js";
import { REACTIONS, conversationIndex, searchMessages, ConversationDrafts, DraftRecovery, draftRecoveryScope, sendsOnEnter } from "./conversation.js";
import { nextWorkStep, workStatus, workActions, activeClaim, producerKnown as hasReportedProducer } from "./workflow.js";
import { consumeJoinFragment, installShareLinks, canRetryInvitation } from "./share-links.js";

const $ = selector => document.querySelector(selector);
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
const initialJoinFragment = consumeJoinFragment();
const initialInvitationFragment = consumeInvitationFragment();
let shareLinksUI = null;
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
let workDraftId = null, replyToId = null, busy = false;
let currentThreadId = null, conversation = null, drafts = new ConversationDrafts();
const viewPositions = new Map(), pendingReactions = new Map(), locallyOwnedMessageIds = new Set();
let newVisibleMessages = 0;
let signoutOperationId = 0, signoutLoading = false;
let refreshOperationId = 0, submitOperationId = 0;
let submitControls = null, noticeTimer = null, noticeVersion = 0, workFormOpener = null;
let accessEndContext = null;
let lastComposerSelection = null;
let lastInvitationOpener = null;
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
    const roomId = state.room?.id ?? identity.roomId;
    $("#room-title").textContent = state.room?.title ?? roomId;
    $(".room-purpose").textContent = state.room?.purpose ?? "";
    $("#conversation-title").textContent = `# ${roomId}`;
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#auth-panel").setAttribute("aria-busy", "false");
    $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
    $("#identity-label").textContent = displayName(session.member.id);
    $("#identity-label").title = `${memberLabel(session.member.id)} · ${session.member.kind}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
    shareLinksUI?.sync();
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
    const endedContext = accessEndContext;
    accessEndContext = null;
    const pendingSignout = signoutLoading;
    if (!leavingPage) recovery.clear();
    releaseSubmission(submitControls);
    submitOperationId += 1; busy = false;
    state = null; session = null; pendingMessage = null; pendingWork = null; pendingAction = null;
    shareLinksUI?.resetManagement();
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
    $("#identity-label").removeAttribute("title");
    for (const id of ["message-list", "work-list", "event-list", "presence-list", "member-stack", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "message-count", "event-count", "rb-attention-list", "rb-involving-list", "rb-history-list"]) {
      const node = $(`#${id}`); node.replaceChildren(); delete node._content;
    }
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) form.reset();
    $("#work-dialog").close();
    for (const id of ["people-panel", "composer-options", "work-options", "room-about", "connection-details"]) $(`#${id}`).open = false;
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
    const openingAcceptedRoom = endedContext === "accepted-room-switch";
    const openingInvitedRoom = endedContext === "invited-room-switch";
    const switchedAccount = endedContext === "account-switch";
    setFormStatus($("#auth-error"), openingAcceptedRoom || openingInvitedRoom || $("#invitation-dialog").open ? ""
      : switchedAccount ? "The browser account changed; private Room state and drafts were cleared."
        : "Sign in with an active key. Session ended; private drafts were cleared.", true);
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
const name = id => memberLabel(id);
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
  status.dataset.state = connected ? "connected" : "other";
  if (status.textContent !== visible) status.textContent = visible;
  $("#connection-explanation").textContent = normalized;
}
function setFormStatus(status, text, error = false) {
  status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text) && error);
}
function renderComposerError() {
  const text = drafts.get(currentThreadId).error;
  const status = $("#composer-status");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text));
}
function setComposerError(text) {
  drafts.save(currentThreadId, { error: text });
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
  const accountMode = Boolean(roomId);
  $("#access-key-label").textContent = accountMode ? "Account key" : "Member key";
  $("#auth-description").textContent = accountMode
    ? `Sign in to #${roomId}. Membership required.`
    : "Open an invite link, or use your member key.";
  $("#auth-hint").textContent = accountMode
    ? "An account key does not grant membership. Keep it private."
    : "Need a link? Ask the room owner. Keep your key private.";
  $("#auth-form button[type='submit']").textContent = accountMode ? "Open room" : "Enter room";
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
    $("#invitation-purpose").textContent = preview.roomPurpose || "No Room purpose was provided.";
    $("#invitation-display-name").textContent = preview.displayName;
    $("#invitation-member-id").textContent = preview.memberId;
    $("#invitation-role").textContent = humanize(preview.role);
    $("#invitation-permissions").textContent = preview.permissions.length
      ? preview.permissions.map(humanize).join(", ")
      : "Conversation access only; no additional capabilities";
    $("#invitation-issuer").textContent = preview.invitedByDisplayName || "Room administrator";
    const expiry = new Date(preview.expiresAt);
    $("#invitation-expires").dateTime = expiry.toISOString();
    $("#invitation-expires").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(expiry);
  }
  let summary = phase === "terminal" ? "This invitation is unavailable." : "Loading the invitation’s exact Room and membership scope…";
  if (preview && phase !== "terminal") summary = pending
    ? `${preview.displayName} is invited to join ${preview.roomTitle || preview.roomId} as ${humanize(preview.role)}.`
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
    ? "This invitation was already accepted. Sign in with an account that has membership to open the Room."
    : "The invitation offers Room membership; your separately provisioned account key identifies the account that would accept it.";
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
  select.innerHTML = `<option value="">${esc(blank)}</option>${members.map(m => `<option value="${esc(m.id)}">${esc(memberLabel(m.id))} · ${esc(m.kind)}</option>`).join("")}`;
  if (previous && !members.some(m => m.id === previous)) select.insertAdjacentHTML("beforeend", `<option value="${esc(previous)}" disabled>Previously selected member unavailable — choose again</option>`);
  if (previous) select.value = previous;
  select.dataset.signature = signature;
}
function syncWorkForm() {
  if (!state || busy) return;
  const active = Object.values(state.members).filter(member => member.active !== false);
  const writing = $("#work-mode-select").value === "write";
  const reviewing = $("#require-verification").checked;
  selectOptions("#assignee-select", active.filter(member => ["accept_work", "complete_work", ...(writing ? ["write_external"] : [])]
    .every(permission => member.permissions.includes(permission))), "Choose accountable member");
  const reviewers = active.filter(member => member.permissions.includes("verify") && member.id !== $("#assignee-select").value);
  selectOptions("#verifier-select", reviewers, "Choose independent verifier");
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
  setText("#presence-count", `${active.length} ${active.length === 1 ? "member" : "members"}`);
  renderContent("#member-stack", active.slice(0, 4).map(m => `<div class="member-avatar ${m.kind}" title="${esc(memberLabel(m.id))}" aria-hidden="true"><span>${initials(m.displayName)}</span></div>`).join(""));
  renderContent("#presence-list", members.map(m => `<div id="${recordDomId("member", m.id)}" class="presence-member" tabindex="-1" data-member-record-id="${esc(m.id)}" data-disclosure-host="${esc(m.id)}" data-focus-key="member:${esc(m.id)}"><div class="member-avatar ${m.kind}" aria-hidden="true"><span>${initials(m.displayName)}</span></div><div><strong>${esc(memberLabel(m.id))}</strong><span>${esc(m.kind)} · ${m.active === false ? "access revoked" : "presence unknown"}</span><details><summary data-focus-key="member-capabilities:${esc(m.id)}">Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p></details></div></div>`).join(""));
  for (const id of ["new-work-button", "composer-work-button"]) {
    $("#" + id).hidden = !can("steer"); $("#" + id).disabled = !can("steer");
  }
  const items = Object.values(state.workItems);
  const waiting = items.filter(i => readyForDecision(i) && i.humanDecisionMakerId === session.member.id).length;
  const summaryHtml = `<article class="summary-card"><span>Your decisions</span><strong>${waiting}</strong><p>Completion, verification, and approval stay separate.</p></article><article class="summary-card"><span>Work in this room</span><strong>${items.length}</strong><p>${items.filter(i => i.state === S.BLOCKED).length} blocked. Conversation never creates work automatically.</p></article>`;
  renderContent("#summary-grid", summaryHtml);
  renderMessages();
  renderSearch();
  renderContent("#work-list", items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(workCard).join("") || `<p class="empty-note">${can("steer") ? "Turn a message into work, or start something new." : "Suggest work in the conversation. The owner can create it."}</p>`);
  $("#event-count").textContent = `${client.sequence}`;
  renderReturnBrief();
  renderContent("#event-list", [...state.eventLog].reverse().map(e => `<li id="${recordDomId("event", e.id)}" tabindex="-1" data-event-record-id="${esc(e.id)}" data-focus-key="event:${esc(e.id)}"><span>${esc(humanize(e.type))}</span><strong>${esc(name(e.actorId))}</strong><time datetime="${esc(e.at)}">${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join(""));
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
  if (!messages.length) list.innerHTML = '<li class="empty-note">Say hello. What are we working on?</li>';
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
  const authorLabel = displayName(m.authorId);
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
  return `<div class="message-avatar ${author.kind}" aria-hidden="true">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(authorLabel)}</strong><span>${esc(author.kind)}</span><a class="message-time" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" aria-label="Link to message by ${esc(authorLabel)} at ${esc(time(m.createdAt))}"><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a></div><div class="message-context">${m.toMemberId ? `<span class="audience-chip">To ${esc(name(m.toMemberId))} · room-visible</span>` : ""}${parent && parent.id !== currentThreadId ? `<a class="source-link reply-preview" href="${esc(recordHref("message", parent.id))}" data-open-message="${esc(parent.id)}">↳ ${esc(name(parent.authorId))}: ${esc(parent.body.slice(0,90))}</a>` : ""}</div><p>${esc(m.body)}</p><details class="reactions"><summary data-message-action="reaction-menu" data-message-id="${esc(m.id)}" aria-label="Reactions to message by ${esc(authorLabel)}">${esc(reactionSummary)}</summary><div class="reaction-options">${reactionButtons}</div></details><div class="message-links">${linked.map(i => `<a class="work-link" href="${esc(workHref(i.id))}" data-open-work="${esc(i.id)}">↳ ${esc(i.title)}</a>`).join("")}<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button">Reply</button>${!currentThreadId && count ? `<button class="thread-link" data-message-action="thread" data-message-id="${esc(m.id)}" type="button">${count} ${count === 1 ? "reply" : "replies"} ↗</button>` : ""}${can("steer") ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : ""}</div></div>`;
}
function renderSearch() {
  const query = $("#message-search").value;
  $("#clear-search").hidden = !query;
  $("#search-results").hidden = !query.trim();
  if (!query.trim()) { $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = ""; return; }
  const result = searchMessages(state, query);
  setText("#search-count", `${result.total} ${result.total === 1 ? "match" : "matches"}${result.total > result.messages.length ? ` · latest ${result.messages.length} shown` : ""} in this room`);
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
  setText("#draft-recovery-status", saved ? "Draft recovery enabled in this tab for 12 hours. Sign-out clears it." : "Draft recovery unavailable. Keep this page open to retain unsent text.");
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
function revealWork(id) {
  if (!state?.workItems[id] || busy) return;
  const card = workRecord(id);
  if (card) card.querySelector(".work-details").open = true;
  focusRecord(card);
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
function actions(i) {
  return workActions(i, state.members[session.member.id]).map(([action, label]) => `<button type="button" class="button secondary" data-action="${action}" data-work-id="${esc(i.id)}" data-focus-key="work-action:${esc(i.id)}:${action}"${busy ? " disabled" : ""}>${label}</button>`).join("");
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
  const next = nextWorkStep(i), status = workStatus(i);
  const nextActor = next.memberId ? `${memberLabel(next.memberId)} — ` : "";
  const nextLine = `<p class="work-next-step" data-next-step="${esc(next.action)}"><strong>Next:</strong> ${esc(nextActor + status.next)}</p>`;
  const source = i.sourceMessageId ? `<a class="source-link" href="${esc(recordHref("message", i.sourceMessageId))}" data-open-message="${esc(i.sourceMessageId)}" data-focus-key="work-source:${esc(i.id)}">From this conversation</a>` : "";
  const blocker = i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : "";
  const decision = i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : "";
  const claim = i.claim ? `<details class="claim"><summary data-focus-key="work-claim:${esc(i.id)}">Recorded scope · ${esc(claimStateLabel(i))}</summary><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p><p>Expires ${esc(i.claim.expiresAt)}. This service does not execute external actions.</p></details>` : "";
  const checks = `<div><dt>Verifier</dt><dd>${i.independentVerificationRequired ? esc(memberLabel(i.verifierMemberId)) : "Not required"}</dd></div><div><dt>Decision</dt><dd>${i.ownerDecisionRequired ? esc(memberLabel(i.humanDecisionMakerId)) : "Not required"}</dd></div>`;
  const updated = `<p class="form-hint">Last recorded update: ${esc(new Date(i.updatedAt).toLocaleString())}. Live execution is not measured.</p>`;
  return `<article id="${workDomId(i.id)}" class="work-card" tabindex="-1" data-work-record-id="${esc(i.id)}" data-disclosure-host="${esc(i.id)}" data-focus-key="work:${esc(i.id)}"><div class="work-card-header"><span class="state state-${status.tone}">${esc(status.label)}</span></div><h3>${esc(i.title)}</h3>${nextLine}<details class="work-details"><summary data-focus-key="work-details:${esc(i.id)}">${i.receipt ? "Evidence & details" : "Details"}</summary><span class="mode">${esc(i.mode)} · revision ${i.revision}</span>${source}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(memberLabel(i.accountableMemberId))}</dd></div>${checks}</dl>${updated}${receiptCard(i)}${blocker}${decision}${claim}</details><div class="work-actions">${actions(i)}</div></article>`;
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
$("#invitation-dialog").addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const controls = [...e.currentTarget.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")]
    .filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1), active = document.activeElement;
  if (!first || !controls.includes(active) || (e.shiftKey ? active === first : active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first)?.focus();
    if (!first) $("#invitation-title").focus();
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
  const roomBefore = state && session ? session : null;
  if (roomBefore) {
    saveComposer();
    if ((drafts.hasText() || !$("#new-work-form").hidden || $("#action-dialog").open)
      && !window.confirm("Signing in with a different account clears this Room’s unsent drafts and forms before acceptance. Continue with this account key?")) return;
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
      invitation.phase = "changed-account";
      setInvitationFeedback("The browser account changed before sign-in could be confirmed. Sign in again to continue safely.", true);
      renderInvitation();
      return;
    }
    $("#invitation-account-key").value = "";
    await moveCurrentRoomToAccount(loggedIn);
    if (!currentInvitation(version, secret)) return;
    invitation.phase = "ready";
    setInvitationFeedback(invitation.preview.status === "accepted"
      ? "Account confirmed. Open the Room only if this is the membership you expected."
      : "Account confirmed. Review the exact scope before accepting.");
    renderInvitation();
    $("#invitation-accept").focus({ preventScroll: true });
  } catch (error) {
    if (!currentInvitation(version, secret)) return;
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
$("#auth-form").addEventListener("submit", async e => {
  if (signoutLoading) { e.preventDefault(); return; }
  e.preventDefault(); setFormStatus($("#auth-error"), "");
  const accessKey = $("#access-key").value.trim();
  const requestedRoom = selectedRoomFromLocation();
  await submit(e.currentTarget, async current => {
    let identity;
    if (requestedRoom) {
      await ensureAccountSession();
      const account = await accountClient.login(accessKey);
      if (!account) return;
      identity = await client.restore(requestedRoom);
    } else identity = await client.login(accessKey);
    if (!current() || !identity || !state || session?.member.id !== identity.member.id || session?.roomId !== identity.roomId) return;
    $("#access-key").value = ""; $("#message-input").focus(); notice("Signed in. Welcome to your room.");
  }, { failureHint: requestedRoom ? "Check the account key and Room membership, then try again." : "Check the access key and try again." });
  if (state) revealLocationHash();
});
$("#signout-button").addEventListener("click", async () => {
  if (busy || signoutLoading || !state || !session || invitationIsCommitting()) return;
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
        configureAuthPanel();
        const ended = "Sign in with an active key. Session ended; private drafts were cleared.";
        if ($("#auth-error").textContent !== ended) setFormStatus($("#auth-error"), ended, true);
        if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
      }
    }
  }
});
$("#refresh-button").addEventListener("click", async () => {
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
    await client.send(pendingMessage.command);
    if (generation !== client.generation || !state) return;
    drafts.clear(threadId);
    $("#message-input").value = ""; pendingMessage = null; clearReply();
    persistDrafts();
    notice(`Message saved${threadId ? " in this thread" : " to the room"}.`);
  }, { failureHint: "Draft kept. Send again to retry." });
});
$("#message-list").addEventListener("click", e => {
  const button = e.target.closest("[data-message-id]"); if (!button || !state || busy) return;
  const id = button.dataset.messageId;
  if (button.dataset.messageAction === "work") openWork(id);
  else if (button.dataset.messageAction === "react") setReaction(id, button.dataset.reaction);
  else if (["reply", "thread"].includes(button.dataset.messageAction)) {
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
$("#message-input").addEventListener("input", () => { lastComposerSelection = null; saveComposer(); });
$("#message-to-select").addEventListener("change", saveComposer);
const touchKeyboard = matchMedia("(hover: none) and (pointer: coarse)");
function syncComposerHint() {
  $("#draft-hint").textContent = touchKeyboard.matches ? "Return for a new line · ↑ to send" : "Enter to send · Shift + Enter for a new line";
  $("#message-input").enterKeyHint = touchKeyboard.matches ? "enter" : "send";
}
touchKeyboard.addEventListener("change", syncComposerHint);
syncComposerHint();
$("#message-input").addEventListener("keydown", e => {
  // Some IME confirmation keys arrive after compositionend; keyCode 229 is the
  // legacy UI Events signal. Neither confirmation nor key repeat sends a message.
  if (sendsOnEnter(e, touchKeyboard.matches)) {
    e.preventDefault();
    if (!busy && $("#message-input").value.trim()) $("#message-form").requestSubmit();
  }
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
window.addEventListener("hashchange", () => {
  const fragment = consumeInvitationFragment();
  if (fragment) openInvitation(fragment);
  else revealLocationHash();
});
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
  $("#work-options").open = false;
  $("#work-dialog").showModal();
  $("#source-message-id").value = sourceId || "";
  if (sourceId) $("#work-title-input").value = (state.messages.find(m => m.id === sourceId)?.body || "").trim().replace(/\s+/g, " ").slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
  $("#source-context").textContent = sourceId ? `Source: ${state.messages.find(m => m.id === sourceId)?.body || ""}` : "";
  $("#source-context").hidden = !sourceId; $("#work-title-input").focus();
  syncWorkForm();
}
function closeWorkForm({ returnFocus = true } = {}) {
  $("#work-dialog").close();
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
$("#review-settings-button").addEventListener("click", () => {
  $("#work-options").open = true;
  $("#require-verification").focus();
});
$("#cancel-work-button").addEventListener("click", () => closeWorkForm());
$("#work-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) closeWorkForm(); });
$("#new-work-form").addEventListener("change", syncWorkForm);
$("#new-work-form").addEventListener("submit", e => {
  e.preventDefault(); if (!state || busy) return;
  const independentVerificationRequired = $("#require-verification").checked, ownerDecisionRequired = $("#require-decision").checked;
  const data = { workItemId: workDraftId, title: $("#work-title-input").value.trim(), definitionOfDone: $("#work-done-input").value.trim(), accountableMemberId: $("#assignee-select").value, verifierMemberId: independentVerificationRequired ? $("#verifier-select").value : null, independentVerificationRequired, ownerDecisionRequired, humanDecisionMakerId: ownerDecisionRequired ? state.room.ownerId : null, mode: $("#work-mode-select").value, sourceMessageId: $("#source-message-id").value || null };
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
  if (state) saveComposer();
  if ((state && (drafts.hasText() || !$("#new-work-form").hidden || $("#action-dialog").open))
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
  const roomId = selectedRoomFromLocation();
  (roomId ? ensureAccountSession().then(account => account.authenticated ? client.restore(roomId) : null) : client.restore()).catch(handleFailureNotice);
});
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
  if (requestedRoom) {
    const account = await ensureAccountSession();
    if (!account?.authenticated) {
      $("#identity-label").textContent = "Not signed in";
      setFormStatus($("#auth-error"), `Sign in with a canonical account that has membership in #${requestedRoom}.`, true);
      setConnectionStatus("Not connected · account sign-in required");
      $("#auth-panel").hidden = false;
      if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
      return;
    }
    await client.restore(requestedRoom);
    return;
  }
  await client.restore();
})().catch(error => {
  const signedOut = [401, 403].includes(error.status);
  if (signedOut) recovery.clear();
  const requestedRoom = selectedRoomFromLocation();
  setFormStatus($("#auth-error"), signedOut
    ? requestedRoom ? `This account cannot open #${requestedRoom}. Use an account with active membership there.` : ""
    : "Room service unavailable. Check the service and retry; no connection is claimed.", true);
  setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
  $("#identity-label").textContent = signedOut ? "Not signed in" : "Session unavailable";
  $("#auth-panel").hidden = false;
  if (!$("#invitation-dialog").open) queueMicrotask(() => $("#access-key").focus({ preventScroll: true }));
});
