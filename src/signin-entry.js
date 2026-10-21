import { AccountClient } from "./account-client.js";
import { createAuthSigninUI } from "./auth-signin-ui.js";
import { applyStoredTheme } from "./account-settings-ui.js";
import { rememberAccountHint } from "./browser-session.js";
import { createSigninNavigation } from "./signin-navigation.js";
import { uiText } from "./strings.js";

// QA 2026-10-20: the workspace module graph (src/app.js + src/request-access.js),
// relative to src/. Preloading it while the person fills the sign-in form
// removes a four-level module waterfall from the post-login wait.
// tests/qa-1020-login-latency.test.js keeps this list equal to the real graph.
export const WORKSPACE_MODULES = Object.freeze([
  "account-client.js", "account-settings-ui.js", "agent-connections.js", "agent-invite-ui.js", "app.js",
  "auth-signin-ui.js", "board-mine.js", "board-ui.js", "browser-session.js", "chat-suggestions.js",
  "client.js", "clipboard.js", "composer-files.js", "conversation-intent.js", "conversation.js",
  "display-name-guard.js", "dm-consents.js", "error-copy.js", "events.js", "first-room-copy.js",
  "friend-bond.js", "handoff-envelope-ui.js", "help-offers.js", "human-experience.js", "human-push.js",
  "invite-context.js", "member-display-names.js", "message-reducers.js", "needs-attention.js",
  "../strings/en.js", "owner-cockpit.js", "owner-project-offers-ui.js", "polls.js", "portable-work.js",
  "reminder-time.js", "reminders.js", "reply-requests.js", "request-access.js", "result-availability.js",
  "result-comparison.js", "result-feedback.js", "result-reader.js", "return-brief.js", "room-charter.js",
  "room-deep-link.js", "room-instructions.js", "room-layout.js", "room-roster.js", "session-expiry.js",
  "share-invite-code.js", "share-links.js", "signin-navigation.js", "spend-pricing-ui.js", "strings.js",
  "updates-ui.js", "work-announcements.js", "work-help.js", "work-item-session.js", "work-loops.js",
  "work-packet.js", "work-reducers.js", "work-selectors.js", "work-status.js", "workflow.js",
  "workspace-navigation.js"
]);
let workspaceWarm = false;
export function warmWorkspaceModules(doc = document) {
  if (workspaceWarm) return;
  workspaceWarm = true;
  for (const path of WORKSPACE_MODULES) {
    const link = doc.createElement("link");
    link.rel = "modulepreload"; link.href = new URL(path, import.meta.url).href;
    doc.head.append(link);
  }
}

export function mountSigninEntry({ openWorkspace }) {
  const $ = selector => document.querySelector(selector);
  const accountClient = new AccountClient();
  const listeners = new AbortController();
  const on = (node, type, handler) => node.addEventListener(type, handler, { signal: listeners.signal });
  let restoreFlight = null, active = true, enteringWorkspace = false;
  const enterWorkspace = options => {
    enteringWorkspace = true;
    $("#auth-panel").inert = true;
    $("#auth-panel").setAttribute("aria-busy", "true");
    return openWorkspace(options).catch(error => {
      enteringWorkspace = false;
      $("#auth-panel").inert = false;
      $("#auth-panel").removeAttribute("aria-busy");
      throw error;
    });
  };

  const restore = () => restoreFlight ??= accountClient.restore().finally(() => { restoreFlight = null; });
  const navigation = createSigninNavigation({ getUI: () => signin, active: () => $("#auth-panel").contains($("#auth-signin-ui")) });
  const enterAccount = async signedIn => {
    // The sign-in endpoints answer with the full session view; adopting it
    // saves a GET /api/account-session round trip (QA 2026-10-20).
    const session = accountClient.adopt(signedIn) ?? await restore();
    if (!session?.authenticated) throw new Error(uiText("entry.sessionChanged"));
    rememberAccountHint();
    await enterWorkspace({ accountClient, signedIn: !location.search && !location.hash });
  };
  const signin = createAuthSigninUI({
    accountClient,
    ensureAccountSession: () => accountClient.session ? Promise.resolve(accountClient.session) : restore(),
    // Same capability loader the workspace app supplies (app.js): without
    // it the entry's auth UI never learns the deployment cannot send mail
    // and offers an email sign-in link it cannot serve (Codex review of
    // the #3068 integration, 2026-10-14).
    loadSigninOptions: () => accountClient.request("/api/auth/signin-options", { method: "GET" }),
    onProviderCapabilities: providers => {
      for (const name of ["google", "github"]) {
        if (providers?.[name]?.configured === false) navigation.setProviderUnavailable(name);
      }
    },
    onViewChange: navigation.sync,
    onBack: navigation.back,
    onSignedIn: enterAccount,
    onBusyChange: value => {
      if (!active) return;
      if (value) warmWorkspaceModules();
      $("#auth-panel").inert = value || enteringWorkspace;
      $("#auth-panel").setAttribute("aria-busy", String(value || enteringWorkspace));
      if (!value && active && (location.search || location.hash)) void enterWorkspace().catch(() => {});
    },
    onSignInUncertain: async () => { await restore(); },
    onPasswordResetComplete: async () => { await restore(); signin.showPassword(); },
    onMagicLinkRequest: () => "/",
    onAccountSwitch: () => window.confirm(uiText("entry.switchAccount"))
  });
  // The agent sign-in component loads lazily on first need: it is a
  // secondary path off the wall (on current main the wall links to the
  // standalone /agent-signin page and the in-page panel is absent), so its
  // module must not tax every fresh sign-in load. Until it loads, the
  // agent surface is simply unmounted — canLeave()/leave() are trivially
  // true, the component's own unmounted contract.
  let agentUi = null, agentFlight = null;
  const ensureAgent = () => agentFlight ??= import("./agent-signin-ui.js").then(({ createAgentSigninUI }) => {
    agentUi = createAgentSigninUI({
      onSignedIn: async session => {
        const target = new URL(location.href);
        target.searchParams.set("room", session.roomId);
        history.replaceState(history.state, "", target.href);
        await enterWorkspace();
      },
      firstRunActions: {
        greet: () => $("#message-input")?.focus(),
        discover: () => { $("#people-panel").open = true; },
        baseUrl: location.origin
      }
    });
    return agentUi;
  });
  const agent = {
    canLeave: () => agentUi?.canLeave() ?? true,
    leave: () => agentUi?.leave() ?? true,
    unmount: () => agentUi?.unmount()
  };
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
  // Warm the workspace modules as soon as someone starts on the form, so the
  // download overlaps typing instead of following the login response.
  on($("#auth-signin-ui"), "focusin", () => warmWorkspaceModules());
  on($("#auth-signin-ui"), "pointerdown", () => warmWorkspaceModules());
  // Integration (CX2-PERF, flagged for Codex on the integration PR): on current
  // main the wall's agent sign-in is the standalone /agent-signin page
  // (decision #37, PR #3445) — #agent-auth-step / #agent-signin-ui are not in
  // the document and #agent-signin-button is a link to that page. The PR's
  // in-page agent panel wiring therefore applies only where the panel exists;
  // elsewhere the button keeps its link behavior and the agent component
  // stays unmounted (its canLeave() is safe unmounted).
  if ($("#agent-auth-step")) {
    void ensureAgent().then(ui => ui.mount($("#agent-signin-ui"))).catch(() => {});
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
  }
  on($("#skip-link"), "click", event => { event.preventDefault(); $("#auth-title").focus(); });
  on($("#refresh-button"), "click", () => {
    if (signin.canLeave() && agent.canLeave()) void enterWorkspace({ restoreRoomSession: true }).catch(() => {});
  });
  $("#refresh-button").disabled = false;
  on(window, "hashchange", () => {
    if (!signin.canLeave() || !agent.canLeave()) return;
    void enterWorkspace().catch(() => {});
  });
  return () => {
    active = false;
    $("#auth-panel").inert = false;
    $("#auth-panel").removeAttribute("aria-busy");
    listeners.abort(); navigation.dispose(); signin.unmount(); agent.unmount();
    $("#signin-controller").prepend($("#auth-signin-ui"));
    if ($("#agent-auth-step")) $("#agent-auth-step").hidden = true;
  };
}
