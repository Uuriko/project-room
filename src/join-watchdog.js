// Loader watchdog for the public join page (#1608): a classic script (not a
// module) that runs even when src/join.js fails to load — blocked, 404'd, or
// stalled. After 15s with the loader card still visible, it swaps in the
// no-invite fallback so "Loading your invite…" can never stick forever.
// Harmless when the module ran: the module hides the loader card first (its
// own preview timeout fires at 10s, before this watchdog).
//
// Kept as a separate file (not inline) because the page is served with
// Content-Security-Policy script-src 'self' — inline scripts are blocked.
(function () {
  setTimeout(function () {
    var loading = document.getElementById("join-loading");
    if (!loading || loading.hidden) return;
    // Door-relative: /room is the marketing page on both doors (the node
    // server and the www door edge). {{ASSET_BASE}}/room 404'd as /room/room
    // on the www door.
    var door = location.pathname.indexOf("/room/") === 0 ? "/room/" : "/";
    loading.innerHTML = "<h1>No invite found</h1>"
      + "<p>Ask a room owner for an invite link, or <a href=\"" + door + "\">sign in and request access</a>.</p>"
      + "<p class=\"form-hint\"><a href=\"/room\">What is Project Room?</a></p>";
  }, 15000);
})();
