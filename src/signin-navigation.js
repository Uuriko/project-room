export function createSigninNavigation({ getUI, active }) {
  const $ = selector => document.querySelector(selector);
  let current = "password-login", replay = false;
  // OAuth providers the deployment positively reported unconfigured (via
  // the signin-options feed, relayed by the host). Their start routes answer
  // 503, so the anchors stay hidden in every view — fail-open: a provider is
  // only ever added here on a positive "configured: false" answer.
  const unavailableProviders = new Set();
  // Providers the feed positively reported configured; anchors start
  // hidden in the static HTML and are revealed only from this set (B-7).
  const availableProviders = new Set();
  function sync(view) {
    const previous = current;
    current = view;
    if (!active()) return;
    const auxiliary = view !== "welcome" && !view.startsWith("password-");
    if (!replay && (auxiliary || previous === "welcome" && view.startsWith("password-")) && previous !== view) {
      if (previous.startsWith("password-")) {
        const base = { ...history.state };
        base.roomSigninView = previous; delete base.roomSigninStep;
        history.replaceState(base, "", location.href);
      }
      const sameFlow = previous.startsWith("magic-") && view.startsWith("magic-")
        || previous.startsWith("reset-") && view.startsWith("reset-");
      history[sameFlow ? "replaceState" : "pushState"]({ ...history.state, roomSigninView: view }, "", location.href);
    }
    $(auxiliary ? "#email-auth-panel" : "#signin-controller").prepend($("#auth-signin-ui"));
    $("#email-auth-panel").hidden = !auxiliary;
    $("#email-auth-step").hidden = !auxiliary;
    $("#signin-methods").hidden = auxiliary;
    $("#signin-entry-routes").hidden = auxiliary;
    $("#google-signin").hidden = view === "welcome" || !availableProviders.has("google");
    $("#github-signin").hidden = view === "welcome" || !availableProviders.has("github");
    if (unavailableProviders.has("google")) $("#google-signin").hidden = true;
    if (unavailableProviders.has("github")) $("#github-signin").hidden = true;
    $("#terms-notice").hidden = view === "welcome";
  }
  function withReplay(value, action) {
    replay = value;
    try { return action(); } finally { replay = false; }
  }
  const onPopState = event => {
    if ($("#auth-panel").hidden || !active()) return;
    const ui = getUI();
    if (!ui.canLeave()) { history.forward(); return; }
    withReplay(true, () => ui.showView(event.state?.roomSigninView || "password-login"));
    ui.focus();
  };
  window.addEventListener("popstate", onPopState);
  return {
    sync, withReplay,
    setProviderUnavailable(name) {
      unavailableProviders.add(name);
      availableProviders.delete(name);
      if (!active()) return;
      const anchor = $(`#${name}-signin`);
      if (anchor) anchor.hidden = true;
    },
    setProviderAvailable(name) {
      availableProviders.add(name);
      unavailableProviders.delete(name);
      if (!active()) return;
      if (current !== "welcome") { const anchor = $(`#${name}-signin`); if (anchor) anchor.hidden = false; }
    },
    back() {
      if (active() && history.state?.roomSigninView) { history.back(); return false; }
      return true;
    },
    dispose() { window.removeEventListener("popstate", onPopState); }
  };
}
