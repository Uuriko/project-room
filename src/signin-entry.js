import { AccountClient } from "./account-client.js";
import { createAuthSigninUI } from "./auth-signin-ui.js";
import { createAgentSigninUI } from "./agent-signin-ui.js";
import { applyStoredTheme } from "./account-settings-ui.js";
import { rememberAccountHint } from "./browser-session.js";
import { createSigninNavigation } from "./signin-navigation.js";
import { uiText } from "./strings.js";

export function mountSigninEntry({ openWorkspace }) {
  const $ = selector => document.querySelector(selector);
  const accountClient = new AccountClient();
  const listeners = new AbortController();
  const on = (node, type, handler) => node.addEventListener(type, handler, { signal: listeners.signal });
  let restoreFlight = null, active = true;
  const restore = () => restoreFlight ??= accountClient.restore().finally(() => { restoreFlight = null; });
  const navigation = createSigninNavigation({ getUI: () => signin, active: () => $("#auth-panel").contains($("#auth-signin-ui")) });
  const enterAccount = async () => {
    const session = await restore();
    if (!session?.authenticated) throw new Error(uiText("entry.sessionChanged"));
    rememberAccountHint();
    await openWorkspace({ accountClient, signedIn: !location.search && !location.hash });
  };
  const signin = createAuthSigninUI({
    accountClient,
    ensureAccountSession: () => accountClient.session ? Promise.resolve(accountClient.session) : restore(),
    onViewChange: navigation.sync,
    onBack: navigation.back,
    onSignedIn: enterAccount,
    onBusyChange: value => {
      if (!value && active && (location.search || location.hash)) void openWorkspace().catch(() => {});
    },
    onSignInUncertain: async () => { await restore(); },
    onPasswordResetComplete: async () => { await restore(); signin.showPassword(); },
    onMagicLinkRequest: () => "/",
    onAccountSwitch: () => window.confirm(uiText("entry.switchAccount"))
  });
  const agent = createAgentSigninUI({
    onSignedIn: async session => {
      const target = new URL(location.href);
      target.searchParams.set("room", session.roomId);
      history.replaceState(history.state, "", target.href);
      await openWorkspace();
    },
    firstRunActions: {
      greet: () => $("#message-input")?.focus(),
      discover: () => { $("#people-panel").open = true; },
      baseUrl: location.origin
    }
  });
  applyStoredTheme();
  $("#static-hero")?.remove();
  $("#auth-panel").hidden = false;
  $("#session-menu").classList.add("empty");
  $("#identity-label").textContent = uiText("entry.signedOut");
  $("#connection-status").textContent = uiText("entry.connection");
  $("#connection-status").dataset.state = "signed-out";
  $("#session-menu-panel").prepend($("#identity-label"));
  $("#refresh-button").classList.remove("icon-button");
  $("#refresh-button").textContent = uiText("entry.refresh");
  $("#connection-explanation").textContent = uiText("entry.connection");
  signin.mount($("#auth-signin-ui"));
  agent.mount($("#agent-signin-ui"));
  on($("#agent-signin-button"), "click", () => {
    if (!signin.canLeave()) return;
    signin.showPassword();
    $("#signin-methods").hidden = true;
    $("#signin-entry-routes").hidden = true;
    $("#agent-auth-step").hidden = false;
    $("#agent-signin-button").setAttribute("aria-expanded", "true");
    $("#agent-signin-ui input")?.focus();
  });
  on($("#agent-auth-back"), "click", () => {
    if (!agent.leave()) return;
    $("#agent-auth-step").hidden = true;
    $("#agent-signin-button").setAttribute("aria-expanded", "false");
    signin.showPassword();
    $("#agent-signin-button").focus();
  });
  on($("#skip-link"), "click", event => { event.preventDefault(); $("#auth-title").focus(); });
  on($("#refresh-button"), "click", () => { if (signin.canLeave() && agent.canLeave()) location.reload(); });
  on(window, "hashchange", () => {
    if (!signin.canLeave() || !agent.canLeave()) return;
    void openWorkspace().catch(() => {});
  });
  return () => {
    active = false;
    listeners.abort(); navigation.dispose(); signin.unmount(); agent.unmount();
    $("#signin-controller").prepend($("#auth-signin-ui"));
    $("#agent-auth-step").hidden = true;
  };
}
