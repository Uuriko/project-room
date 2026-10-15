import { githubSigninVerified, onGithubSigninGateChange } from "./provider-gate.js";

export function createSigninNavigation({ getUI, active }) {
  const $ = selector => document.querySelector(selector);
  let current = "password-login", replay = false;
  // #3548: the GitHub door is gated on deployment verification, not just
  // the view — hidden on the welcome view as before, and hidden everywhere
  // until the provider gate opens. Re-applied live when the gate changes.
  const applyGithubVisibility = () => {
    const button = $("#github-signin");
    if (button) button.hidden = current === "welcome" || !githubSigninVerified();
  };
  const releaseGate = onGithubSigninGateChange(() => { if (active()) applyGithubVisibility(); });
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
    $("#google-signin").hidden = view === "welcome";
    applyGithubVisibility();
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
    back() {
      if (active() && history.state?.roomSigninView) { history.back(); return false; }
      return true;
    },
    dispose() { releaseGate(); window.removeEventListener("popstate", onPopState); }
  };
}
