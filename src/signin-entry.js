import { AccountClient } from "./account-client.js";
import { createAuthSigninUI } from "./auth-signin-ui.js";
import { applyStoredTheme } from "./account-settings-ui.js";
import { rememberAccountHint } from "./browser-session.js";
import { createSigninNavigation } from "./signin-navigation.js";
import { roomIdFromHash } from "./room-deep-link.js";
import { uiText } from "./strings.js";

export const ROOM_RETURN_KEY = "project-room:signin-room:v1";

function roomStorage(storage) {
  if (storage) return storage;
  try {
    const store = globalThis.sessionStorage;
    return store && typeof store.getItem === "function" ? store : null;
  } catch { return null; }
}

export function roomIdFromRoomHash(hash) {
  return roomIdFromHash(hash);
}

export function rememberRoomReturn(hash, storage) {
  const id = roomIdFromHash(hash);
  if (!id) return null;
  try { roomStorage(storage)?.setItem(ROOM_RETURN_KEY, id); } catch { /* private mode */ }
  return id;
}

export function readRoomReturn(storage) {
  try {
    const id = roomStorage(storage)?.getItem(ROOM_RETURN_KEY);
    return id && roomIdFromHash(`#room/${id}`) ? id : null;
  } catch { return null; }
}

export function takeRoomReturn(storage) {
  const id = readRoomReturn(storage);
  try { roomStorage(storage)?.removeItem(ROOM_RETURN_KEY); } catch { /* private mode */ }
  return id;
}

export function signInToOpenLabel(id) {
  return uiText("entry.signInToOpen", { id });
}

function restoreRememberedRoom() {
  const roomId = readRoomReturn();
  if (!roomId || roomIdFromHash(location.hash)) return roomId;
  const target = new URL(location.href);
  target.hash = `#room/${roomId}`;
  history.replaceState(history.state, "", target.pathname + target.search + target.hash);
  return roomId;
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
  const enterAccount = async () => {
    const session = await restore();
    if (!session?.authenticated) throw new Error(uiText("entry.sessionChanged"));
    rememberAccountHint();
    restoreRememberedRoom();
    await enterWorkspace({ accountClient, signedIn: !location.search && !location.hash });
    takeRoomReturn();
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
        const returned = readRoomReturn();
        const target = new URL(location.href);
        target.searchParams.set("room", returned || session.roomId);
        if (returned) target.hash = `#room/${returned}`;
        history.replaceState(history.state, "", target.pathname + target.search + target.hash);
        await enterWorkspace();
        takeRoomReturn();
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
  const openedRoom = rememberRoomReturn(location.hash);
  if (openedRoom) {
    const title = $("#auth-title");
    if (title) title.textContent = signInToOpenLabel(openedRoom);
  }
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
