// Room navigation is independent of optional external-message integrations.
export function installWorkspaceNavigation({ account, getRoom, onRooms, onNavigate }) {
  const $ = selector => document.querySelector(selector);
  let browsing = false;
  function sync() {
    const authenticated = Boolean(account.session?.authenticated);
    $("#workspace-nav").hidden = !authenticated;
    $("#account-rooms-panel").hidden = !authenticated || (!browsing && Boolean(getRoom()));
    $("#main").hidden = browsing || !getRoom();
  }
  function showRoomList(push = false) {
    browsing = true;
    const url = new URL(location.href);
    url.searchParams.delete("room"); url.hash = "#pr-view/room-list";
    if (url.href !== location.href) history[push ? "pushState" : "replaceState"](null, "", url.pathname + url.search + url.hash);
    onNavigate(); sync(); onRooms();
  }
  function showRooms() {
    const wasBrowsing = browsing;
    browsing = false; if (wasBrowsing) onNavigate(); sync();
    if (getRoom()) $("#conversation-title").focus({ preventScroll: true });
    else showRoomList();
  }
  $("#nav-rooms").addEventListener("click", () => showRoomList(true));
  return {
    sync, showRoomList, showRooms, open: showRoomList,
    reset() { browsing = false; $("#workspace-nav").hidden = true; },
    detachRoom() { sync(); },
  };
}

export function nameBeforeFirstRoom({ askName, ensure, session }) {
  let flight = null;
  return () => {
    if (flight) return flight;
    const owned = session();
    flight = (async () => {
      try { await askName?.(); } catch { /* setup is optional; the room is still made */ }
      if (session() !== owned) return null;
      return ensure();
    })().finally(() => { flight = null; });
    return flight;
  };
}
