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

export function setShareLinkStatus(element, text) {
  element.textContent = text;
  element.classList.toggle("visible", Boolean(text));
}

const interrupted = error => error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError;
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

export function installShareLinks({ client, accountClient, getState, getSession, openRoom }) {
  let managementVersion = 0, joinVersion = 0, joinSecret = null, redemptionId = null, joining = false, pendingCreate = null;
  let joined = null, previewRoomId = null;
  const manager = $("#share-link-dialog"), joinDialog = $("#join-link-dialog");
  const status = text => setShareLinkStatus($("#share-link-status"), text);
  const joinStatus = text => setShareLinkStatus($("#join-link-status"), text);
  const managementCurrent = (version, generation) => version === managementVersion && generation === client.generation && manager.open;
  function sync() {
    const member = getState()?.members[getSession()?.member.id];
    $("#invite-people-button").hidden = !(member?.kind === "human" && member?.active !== false && member?.permissions.includes("manage_members"));
    if ($("#invite-people-button").hidden && manager.open) manager.close();
  }
  function resetManagement() {
    managementVersion++; pendingCreate = null;
    $("#share-link-url").value = ""; $("#share-link-result").hidden = true;
    $("#share-link-list").replaceChildren(); status("");
    $("#share-link-create").disabled = false;
    if (manager.open) manager.close();
    sync();
  }
  async function list(version, generation) {
    const result = await client.request(client.path("/share-links"));
    if (!managementCurrent(version, generation)) return;
    const items = result.links.map(link => {
      const li = document.createElement("li"), text = document.createElement("p");
      text.textContent = `${link.joins}/${link.maxJoins} guests joined · ${link.status.replaceAll("_", " ")} · expires ${date(link.expiresAt)}`;
      li.append(text);
      if (link.status === "active") {
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button ghost";
        cancel.textContent = "Cancel link"; cancel.setAttribute("aria-label", `Cancel link created ${date(link.createdAt)}`);
        cancel.addEventListener("click", async () => {
          if (!managementCurrent(version, generation)) return;
          cancel.disabled = true;
          try {
            await client.request(client.path("/share-links-cancel"), { method: "POST", data: { linkId: link.id } });
            if (!managementCurrent(version, generation)) return;
            if ($("#share-link-url").dataset.linkId === link.id) { $("#share-link-url").value = ""; $("#share-link-result").hidden = true; }
            status("Link cancelled. Existing members keep their access.");
            try { await list(version, generation); }
            catch { if (managementCurrent(version, generation)) status("Link cancelled. Existing members keep their access. The list could not refresh; close and reopen this window to reload it."); }
          } catch (error) { if (managementCurrent(version, generation)) { status(invitationManagementFailureMessage(error, "cancel")); cancel.disabled = false; } }
        });
        li.append(cancel);
      }
      return li;
    });
    $("#share-link-list").replaceChildren(...items);
    if (!items.length) $("#share-link-list").textContent = "No invitation links yet.";
  }
  $("#invite-people-button").addEventListener("click", async () => {
    resetManagement(); const version = ++managementVersion, generation = client.generation;
    $("#share-local-note").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    manager.showModal(); status("Loading links…");
    try { await list(version, generation); if (managementCurrent(version, generation)) status(""); }
    catch (error) { if (managementCurrent(version, generation)) status(invitationManagementFailureMessage(error, "list")); }
  });
  $("#share-link-close").addEventListener("click", () => manager.close());
  manager.addEventListener("close", () => { resetManagement(); $("#invite-people-button").focus(); });
  $("#share-link-form").addEventListener("input", () => { pendingCreate = null; });
  $("#share-link-form").addEventListener("submit", async event => {
    event.preventDefault(); const version = managementVersion, generation = client.generation;
    if (!managementCurrent(version, generation)) return;
    const request = pendingCreate ||= { requestId: crypto.randomUUID(), linkToken: newToken(),
      expiresAt: Date.now() + Number($("#share-link-expiry").value) * 3600000,
      maxJoins: Number($("#share-link-limit").value), expectedMemberRevision: getState().members[getSession().member.id].revision };
    $("#share-link-create").disabled = true; status("Creating your invitation…");
    try {
      const result = await client.request(client.path("/share-links"), { method: "POST", data: request });
      if (!managementCurrent(version, generation)) return;
      if (result.link.status !== "active") throw new Error("This link is no longer active. Change the settings to create another.");
      $("#share-link-url").value = `${location.origin}/#join/${request.linkToken}`;
      $("#share-link-url").dataset.linkId = result.link.id;
      $("#share-link-result").hidden = false; pendingCreate = null;
      status("Ready. Copy the link and send it to the people you want to invite.");
      $("#share-link-copy").focus();
      try { await list(version, generation); }
      catch { if (managementCurrent(version, generation)) status("Link created. You can copy it above. The list could not refresh; close and reopen this window to reload it."); }
    } catch (error) { if (managementCurrent(version, generation)) status(invitationManagementFailureMessage(error, "create")); }
    finally { if (managementCurrent(version, generation)) $("#share-link-create").disabled = false; }
  });
  $("#share-link-copy").addEventListener("click", async () => {
    const version = managementVersion, generation = client.generation, value = $("#share-link-url").value;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); if (managementCurrent(version, generation)) status("Link copied."); }
    catch { if (managementCurrent(version, generation)) { $("#share-link-url").focus(); $("#share-link-url").select(); status("Select and copy the link above."); } }
  });
  async function open(fragment) {
    if (joining) { joinStatus("Finish the current join before opening another invitation."); return; }
    const version = ++joinVersion; joinSecret = fragment.token; redemptionId = crypto.randomUUID(); joined = null; previewRoomId = null;
    $("#join-link-form").reset(); $("#join-link-form").hidden = true;
    $("#join-link-submit").textContent = "Join room"; $("#join-link-signout").hidden = true;
    $("#join-link-title").textContent = "Join this room"; $("#join-link-scope").textContent = "Checking your invitation…";
    joinStatus(""); if (!joinDialog.open) joinDialog.showModal();
    if (!joinSecret) { $("#join-link-scope").textContent = "This invitation link is incomplete. Ask for a new link."; return; }
    try {
      const { preview, session: account } = await accountClient.prepareShareLink(joinSecret);
      if (version !== joinVersion || !account) return;
      previewRoomId = preview.room.id;
      $("#join-link-title").textContent = `Join ${preview.room.title}`;
      $("#join-link-scope").textContent = `${preview.access} This link expires ${date(preview.link.expiresAt)}; ${preview.link.remainingJoins} new guests can still join.`;
      $("#join-link-form").hidden = false; $("#join-link-name").focus();
    } catch (error) { if (version === joinVersion) { $("#join-link-scope").textContent = "Unable to open this invitation."; joinStatus(invitationFailureMessage(error)); } }
  }
  $("#join-link-form").addEventListener("submit", async event => {
    event.preventDefault(); if (joining || !joinSecret) return;
    const version = joinVersion, name = $("#join-link-name").value.trim(); let failed = false; joining = true;
    for (const control of joinDialog.querySelectorAll("button,input")) control.disabled = true;
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
      joining = false;
      for (const control of joinDialog.querySelectorAll("button,input")) control.disabled = false;
      if (failed && version === joinVersion && joinDialog.open) $("#join-link-submit").focus();
    }
  });
  $("#join-link-signout").addEventListener("click", async () => {
    if (joining) return;
    const version = joinVersion;
    try {
      await accountClient.restore(); await accountClient.logout();
      if (version !== joinVersion) return;
      redemptionId = crypto.randomUUID(); $("#join-link-signout").hidden = true;
      joinStatus("Signed out. You can now join with a new guest identity.");
    } catch (error) { if (version === joinVersion) joinStatus(error.message); }
  });
  $("#join-link-close").addEventListener("click", () => { if (!joining) joinDialog.close(); });
  joinDialog.addEventListener("cancel", event => { if (joining) event.preventDefault(); });
  joinDialog.addEventListener("close", () => {
    joinVersion++; joinSecret = null; redemptionId = null; joined = null; previewRoomId = null; $("#join-link-form").reset();
    if (!getState()) {
      $("#auth-panel").hidden = false;
      $("#connection-status").textContent = "Not connected · open an invitation link to join";
      $("#access-key").focus();
    }
  });
  window.addEventListener("hashchange", () => { const fragment = consumeJoinFragment(); if (fragment) open(fragment); });
  return { sync, resetManagement, open };
}
