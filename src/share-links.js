const $ = selector => document.querySelector(selector);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function consumeJoinFragment() {
  if (!location.hash.startsWith("#join/")) return null;
  const value = location.hash.slice(6);
  history.replaceState(history.state, "", location.pathname + location.search);
  return { token: tokenPattern.test(value) ? value : null };
}
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const date = value => new Date(value).toLocaleString();

export function formatShareInvitation(note, url) {
  if (typeof note !== "string" || note.length > 600 || !url) return "";
  return note.trim() ? `${note.trim()}\n\n${url}` : url;
}

export function setShareLinkStatus(element, text) {
  element.textContent = text;
  element.classList.toggle("visible", Boolean(text));
}

const interrupted = error => error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError;
export const canRetryInvitation = error => interrupted(error) || error?.status === 429 || error?.status >= 500;
export function invitationFailureMessage(error) {
  if (interrupted(error)) {
    return "The connection was interrupted. We could not confirm the result. Your entries are kept; try again here to check or finish the same request.";
  }
  return error.message;
}

export function invitationManagementFailureMessage(error, operation) {
  if (!interrupted(error)) return error.message;
  if (operation === "list") return "The connection was interrupted. Close and reopen this window to reload invitation links.";
  if (operation === "cancel") return "The connection was interrupted. We could not confirm cancellation. Try cancelling this same link again to check or finish it.";
  return invitationFailureMessage(error);
}

export async function reuseVisibleRoom(client, roomId, visibleSession) {
  if (!visibleSession || visibleSession !== client.session || visibleSession.roomId !== roomId) return null;
  const generation = client.generation;
  // Revalidate the identity actually shown in the Room, not an older account cookie
  // left by another sign-in mode. Existing access needs no invitation redemption.
  await client.refresh();
  if (client.generation !== generation || client.session !== visibleSession) throw new Error("Your room identity changed. Close and review the invitation again.");
  return { roomId, roomMode: visibleSession.authMode !== "account", session: visibleSession, duplicate: true };
}

export function installShareLinks({ client, accountClient, getState, getSession, openRoom,
  setConnectionStatus = text => { $("#connection-status").textContent = text; } }) {
  let managementVersion = 0, listVersion = 0, joinVersion = 0, joinSecret = null, redemptionId = null, joining = false, pendingCreate = null;
  let joined = null, previewRoomId = null;
  let managementSession = null, managementGeneration = null, currentLink = null, expiryTimer = null, copyRevision = 0, copying = false;
  const manager = $("#share-link-dialog"), joinDialog = $("#join-link-dialog");
  const status = text => setShareLinkStatus($("#share-link-status"), text);
  const listStatus = text => setShareLinkStatus($("#share-management-status"), text);
  const joinStatus = text => setShareLinkStatus($("#join-link-status"), text);
  function joinBusy(value) {
    joining = value;
    for (const control of joinDialog.querySelectorAll("button,input")) control.disabled = value;
  }
  const member = () => getState()?.members[getSession()?.member.id];
  const canManage = () => member()?.kind === "human" && member()?.active !== false && member()?.permissions.includes("manage_members");
  const ownsManagement = () => managementSession && managementSession === getSession()
    && managementGeneration === client.generation && managementSession === client.session && client.ownsAccountSession() && canManage();
  const managementCurrent = (version, generation) => version === managementVersion && generation === client.generation && manager.open && ownsManagement();
  function updateCopyControls() {
    $("#share-link-copy").disabled = copying || !currentLink;
    $("#share-note-copy").disabled = copying || !currentLink || !$("#share-note-text").value.trim()
      || !$("#share-note-preview").value;
  }
  function clearResult(message = "") {
    const heldFocus = $("#share-link-result").contains(document.activeElement);
    copyRevision++; currentLink = null; clearTimeout(expiryTimer); expiryTimer = null;
    $("#share-link-url").value = ""; delete $("#share-link-url").dataset.linkId;
    $("#share-note-text").value = ""; $("#share-note-preview").value = "";
    $("#share-note").open = false; $("#share-note-result").hidden = true;
    $("#share-link-result").hidden = true; $("#share-link-form").hidden = false;
    status(message); updateCopyControls();
    if (heldFocus && manager.open && ownsManagement()) $("#share-link-create").focus();
  }
  function checkResult() {
    if (currentLink && (currentLink.expiresAt <= Date.now() || currentLink.memberRevision !== member()?.revision)) {
      clearResult("This link is no longer active. Create a new link.");
    }
    return currentLink;
  }
  function managementError(error) {
    if ([401, 403].includes(error?.status) || ["session_binding_changed", "session_binding_required", "invalid_session_binding"].includes(error?.code)) {
      resetManagement(); setConnectionStatus("Invitation access changed. Reopen the room before inviting.");
    }
  }
  function updateLimits() {
    const hours = Number($("#share-link-expiry").value), limit = Number($("#share-link-limit").value);
    const duration = hours === 168 ? "7 days" : `${hours} ${hours === 1 ? "hour" : "hours"}`;
    $("#share-settings-summary").textContent = `${duration} · ${Number.isInteger(limit) && limit >= 1 && limit <= 25 ? `${limit} ${limit === 1 ? "guest" : "guests"}` : "Choose a guest limit"}`;
  }
  function creationBusy(value) {
    for (const id of ["share-link-create", "share-link-expiry", "share-link-limit"]) $("#" + id).disabled = value;
  }
  function updateSwitchWarning() {
    const currentRoom = getSession()?.roomId ?? getState()?.room?.id;
    $("#join-switch-warning").hidden = !previewRoomId || !(currentRoom ? currentRoom !== previewRoomId : accountClient.session?.authenticated);
  }
  function sync() {
    $("#invite-people-button").hidden = !canManage();
    if (manager.open && !ownsManagement()) resetManagement();
    else checkResult();
    if (joinDialog.open) updateSwitchWarning();
  }
  function resetManagement() {
    managementVersion++; listVersion++; pendingCreate = null;
    managementSession = null; managementGeneration = null; clearResult();
    $("#share-settings").open = false; $("#share-management").open = false;
    $("#share-link-list").replaceChildren(); status(""); listStatus("");
    creationBusy(false); updateLimits();
    if (manager.open) manager.close();
    sync();
  }
  async function list(version, generation, confirmed = "") {
    const sequence = ++listVersion;
    listStatus(confirmed || "Loading links…");
    try {
    const result = await client.request(client.path("/share-links"));
    if (!managementCurrent(version, generation)) { sync(); return; }
    if (sequence !== listVersion) return;
    if (currentLink && result.links.some(link => link.id === currentLink.id && link.status !== "active")) {
      clearResult("This link is no longer active. Create a new link.");
    }
    const items = result.links.map(link => {
      const li = document.createElement("li"), text = document.createElement("p");
      li.dataset.linkId = link.id;
      const description = status => `${link.joins}/${link.maxJoins} guests joined · ${status.replaceAll("_", " ")} · expires ${date(link.expiresAt)}`;
      text.textContent = description(link.status);
      li.append(text);
      if (link.status === "active") {
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button ghost";
        cancel.textContent = "Cancel link"; cancel.setAttribute("aria-label", `Cancel link created ${date(link.createdAt)}`);
        cancel.addEventListener("click", async () => {
          if (!managementCurrent(version, generation)) return;
          const heldFocus = document.activeElement === cancel;
          let cancelled = false;
          listVersion++; // A pre-cancellation read cannot restore an active row.
          if (currentLink?.id === link.id) clearResult();
          cancel.disabled = true;
          try {
            await client.request(client.path("/share-links-cancel"), { method: "POST", data: { linkId: link.id } });
            if (!managementCurrent(version, generation)) { sync(); return; }
            cancelled = true;
            cancel.textContent = "Cancelled";
            text.textContent = description("cancelled");
            await list(version, generation, "Link cancelled. Existing members keep their access.");
          } catch (error) { if (managementCurrent(version, generation) && !cancelled) { managementError(error); listStatus(invitationManagementFailureMessage(error, "cancel")); cancel.disabled = false; } else sync(); }
          finally {
            if (cancelled && heldFocus && managementCurrent(version, generation)
              && [document.body, cancel].includes(document.activeElement)) $("#share-management-summary").focus();
          }
        });
        li.append(cancel);
      }
      return li;
    });
    $("#share-link-list").replaceChildren(...items);
    if (!items.length) $("#share-link-list").textContent = "No invitation links yet.";
    listStatus(confirmed);
    } catch (error) {
      if (managementCurrent(version, generation) && sequence === listVersion) { managementError(error); listStatus(`${confirmed ? confirmed + " " : ""}${invitationManagementFailureMessage(error, "list")}`); }
      else sync();
      throw error;
    }
  }
  $("#invite-people-button").addEventListener("click", async () => {
    resetManagement(); const version = ++managementVersion, generation = client.generation;
    managementSession = getSession(); managementGeneration = generation;
    if (!ownsManagement()) return;
    $("#share-local-note").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    manager.showModal(); $("#share-link-create").focus();
    // Link-list feedback never owns the newer creation/clipboard status.
    await list(version, generation).catch(() => {});
  });
  $("#share-link-close").addEventListener("click", () => manager.close());
  manager.addEventListener("close", () => { resetManagement(); if (!$("#invite-people-button").hidden) $("#invite-people-button").focus(); });
  $("#share-link-another").addEventListener("click", () => {
    clearResult(); $("#share-link-create").focus();
  });
  $("#share-link-form").addEventListener("input", () => { pendingCreate = null; updateLimits(); });
  $("#share-link-form").addEventListener("invalid", event => {
    if ($("#share-settings").contains(event.target)) { $("#share-settings").open = true; event.target.focus(); }
  }, true);
  $("#share-link-form").addEventListener("submit", async event => {
    event.preventDefault(); const version = managementVersion, generation = client.generation;
    if (!managementCurrent(version, generation)) return;
    const request = pendingCreate ||= { requestId: crypto.randomUUID(), linkToken: newToken(),
      expiresAt: Date.now() + Number($("#share-link-expiry").value) * 3600000,
      maxJoins: Number($("#share-link-limit").value), expectedMemberRevision: getState().members[getSession().member.id].revision };
    creationBusy(true); status("Creating link…");
    try {
      const result = await client.request(client.path("/share-links"), { method: "POST", data: request });
      if (!managementCurrent(version, generation)) { sync(); return; }
      pendingCreate = null; // The owned response confirms this request's outcome.
      if (result.link.status !== "active") throw new Error("This link is no longer active. Create a new link.");
      clearResult();
      currentLink = { id: result.link.id, expiresAt: result.link.expiresAt, memberRevision: request.expectedMemberRevision };
      if (!checkResult()) return;
      $("#share-link-url").value = `${location.origin}/#join/${request.linkToken}`;
      $("#share-link-url").dataset.linkId = result.link.id;
      $("#share-link-result").hidden = false;
      $("#share-link-form").hidden = true;
      expiryTimer = setTimeout(checkResult, Math.max(0, currentLink.expiresAt - Date.now()));
      expiryTimer.unref?.();
      updateCopyControls();
      status("Link ready.");
      $("#share-link-copy").focus();
      list(version, generation).catch(() => {});
    } catch (error) { if (managementCurrent(version, generation)) { managementError(error); status(invitationManagementFailureMessage(error, "create")); } else sync(); }
    finally { if (managementCurrent(version, generation)) creationBusy(false); }
  });
  $("#share-note-text").addEventListener("input", () => {
    copyRevision++; status("");
    const note = $("#share-note-text").value;
    $("#share-note-preview").value = note.trim() ? formatShareInvitation(note, $("#share-link-url").value) : "";
    $("#share-note-result").hidden = !$("#share-note-preview").value;
    updateCopyControls();
  });
  $("#share-note").addEventListener("toggle", () => { copyRevision++; if (currentLink) status(""); });
  async function copy(withNote) {
    sync();
    const version = managementVersion, generation = client.generation;
    if (copying || !managementCurrent(version, generation) || !checkResult()) return;
    const field = $(withNote ? "#share-note-preview" : "#share-link-url"), value = field.value;
    if (!value || (withNote && (!$("#share-note").open || !$("#share-note-text").value.trim()))) return;
    const revision = ++copyRevision, link = currentLink, focus = document.activeElement;
    const currentResult = () => managementCurrent(version, generation) && checkResult() === link && revision === copyRevision
      && field.value === value && (!withNote || ($("#share-note").open && !$("#share-note-result").hidden));
    copying = true; updateCopyControls();
    status(withNote ? "Copying invitation…" : "Copying link…");
    try { await navigator.clipboard.writeText(value); if (currentResult()) status(withNote ? "Invitation copied." : "Link copied."); }
    catch {
      if (currentResult()) {
        if ([document.body, focus].includes(document.activeElement)) { field.focus(); field.select(); }
        status(withNote ? "Select and copy the preview above." : "Select and copy the link above.");
      }
    } finally { copying = false; sync(); updateCopyControls(); }
  }
  $("#share-link-copy").addEventListener("click", () => copy(false));
  $("#share-note-copy").addEventListener("click", () => copy(true));
  async function open(fragment) {
    if (joining) { joinStatus("Finish the current join before opening another invitation."); return; }
    const retryHadFocus = document.activeElement === $("#join-link-retry");
    const version = ++joinVersion; joinSecret = fragment.token; redemptionId = crypto.randomUUID(); joined = null; previewRoomId = null;
    $("#join-link-form").reset(); $("#join-link-form").hidden = true;
    $("#join-link-retry").hidden = true;
    $("#join-access-details").open = false; $("#join-switch-warning").hidden = true;
    $("#join-link-permissions").textContent = ""; $("#join-link-expiry").textContent = "";
    $("#join-link-submit").textContent = "Join room"; $("#join-link-signout").hidden = true;
    $("#join-link-title").textContent = "Join this room"; $("#join-link-scope").textContent = "Checking your invitation…";
    joinStatus(""); if (!joinDialog.open) joinDialog.showModal();
    if (!joinSecret) { $("#join-link-scope").textContent = "This invitation link is incomplete. Ask for a new link."; return; }
    try {
      const { preview, session: account } = await accountClient.prepareShareLink(joinSecret);
      if (version !== joinVersion || !account) return;
      previewRoomId = preview.room.id;
      $("#join-link-title").textContent = `Join ${preview.room.title}`;
      $("#join-link-scope").textContent = "Read history and join the conversation. Everyone in the room can read your messages.";
      $("#join-link-permissions").textContent = preview.access;
      $("#join-link-expiry").textContent = `Invitation expires ${date(preview.link.expiresAt)} · ${preview.link.remainingJoins} guest places left.`;
      updateSwitchWarning();
      $("#join-link-form").hidden = false; $("#join-link-name").focus();
    } catch (error) {
      if (version !== joinVersion) return;
      $("#join-link-scope").textContent = "Unable to open this invitation.";
      const retryable = canRetryInvitation(error);
      $("#join-link-retry").hidden = !retryable;
      joinStatus(interrupted(error) ? "Connection interrupted. Try again." : invitationFailureMessage(error));
      if (retryable && retryHadFocus && [document.body, $("#join-link-retry")].includes(document.activeElement)) $("#join-link-retry").focus();
    }
  }
  $("#join-link-retry").addEventListener("click", () => { if (joinSecret && !joining) open({ token: joinSecret }); });
  $("#join-link-form").addEventListener("submit", async event => {
    event.preventDefault(); if (joining || !joinSecret) return;
    const version = joinVersion, name = $("#join-link-name").value.trim(); let failed = false;
    joinBusy(true);
    joinStatus(joined ? "Opening room…" : "Joining room…");
    try {
      if (!joined) {
        if (getState()) joined = await reuseVisibleRoom(client, previewRoomId, getSession());
        if (!joined) {
          if (!accountClient.session) await accountClient.restore();
          if (version !== joinVersion) return;
          joined = await accountClient.joinShareLink({ linkToken: joinSecret, displayName: name, redemptionId });
        }
        if (!joined) throw new Error("Your browser identity changed. Close and reopen the invitation.");
      }
      if (version !== joinVersion) return;
      await openRoom(joined.roomId, joined.roomMode === true, joined.session);
      if (version !== joinVersion) return;
      joinDialog.close(); $("#message-input").focus();
    } catch (error) {
      if (version !== joinVersion) return;
      failed = true;
      joinStatus(invitationFailureMessage(error));
      $("#join-link-signout").hidden = error.code !== "guest_session_ended";
      if (joined) $("#join-link-submit").textContent = "Open joined room";
    } finally {
      joinBusy(false);
      if (failed && version === joinVersion && joinDialog.open) $("#join-link-submit").focus();
    }
  });
  $("#join-link-signout").addEventListener("click", async () => {
    if (joining) return;
    const version = joinVersion;
    let failed = false;
    joinBusy(true); joinStatus("Signing out…");
    try {
      const restored = await accountClient.restore();
      if (version !== joinVersion || !joinDialog.open) return;
      if (!restored) throw new Error("Your browser identity changed. Try again to confirm sign-out.");
      if (restored.authenticated !== false || restored.account !== null) throw new Error("Your browser identity changed. Close and review the invitation again.");
      const signedOut = await accountClient.logout();
      if (version !== joinVersion || !joinDialog.open) return;
      if (signedOut?.authenticated !== false || signedOut.account !== null) throw new Error("Sign-out was not confirmed. Try again.");
      redemptionId = crypto.randomUUID(); $("#join-link-signout").hidden = true;
      joinStatus("Signed out. You can now join with a new guest identity.");
    } catch (error) {
      if (version === joinVersion) { failed = true; joinStatus(invitationFailureMessage(error)); }
    } finally {
      joinBusy(false);
      if (version === joinVersion && joinDialog.open) $(failed ? "#join-link-signout" : "#join-link-name").focus();
    }
  });
  $("#join-link-close").addEventListener("click", () => { if (!joining) joinDialog.close(); });
  joinDialog.addEventListener("cancel", event => { if (joining) event.preventDefault(); });
  joinDialog.addEventListener("close", () => {
    joinVersion++; joinSecret = null; redemptionId = null; joined = null; previewRoomId = null; $("#join-link-form").reset();
    $("#join-link-retry").hidden = true;
    if (!getState()) {
      $("#auth-panel").hidden = false;
      setConnectionStatus("Not connected · open an invitation link to join");
      $("#access-key").focus();
    }
  });
  window.addEventListener("hashchange", () => { const fragment = consumeJoinFragment(); if (fragment) open(fragment); });
  return { sync, resetManagement, open };
}
