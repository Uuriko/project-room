// Boot watchdog for the root door (F-U1B2-1): a classic script (not a
// module) that runs even when src/entry.js fails to load — blocked, 404'd,
// or stalled, along with its static imports. entry.js sets
// documentElement.dataset.entryStarted (via entry-started.js) only after
// its static imports evaluate, so after 15s with that flag still unset the
// entry module never ran and its own showLoadFailure() is unreachable:
// swap in the same load-failure surface entry.js uses, so "Connecting to
// room service…" can never stick forever. Failures after entry evaluates
// (dynamic imports) leave the flag set and are entry.js's own path, so
// this watchdog stays out of their way.
//
// Kept as a separate file (not inline) because the page is served with
// Content-Security-Policy script-src 'self' — inline scripts are blocked.
// The copy is hardcoded, as in join-watchdog.js, because a classic script
// cannot import the string table; it matches entry.loadFailed /
// entry.retry in strings/en.js.
(function () {
  setTimeout(function () {
    if (document.documentElement.dataset.entryStarted === "true") return;
    var hero = document.querySelector("#static-hero");
    if (!hero) return;
    hero.remove();
    var status = document.querySelector("#auth-error");
    status.textContent = "The room could not load. Reload to try again.";
    status.classList.add("error", "visible");
    document.querySelector("#auth-panel").hidden = false;
    if (!document.querySelector("#entry-retry")) {
      var retry = document.createElement("button");
      retry.id = "entry-retry";
      retry.type = "button";
      retry.className = "button secondary";
      retry.textContent = "Reload";
      retry.addEventListener("click", function () { location.reload(); });
      status.after(retry);
    }
  }, 15000);
})();
