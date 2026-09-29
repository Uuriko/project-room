// Email sign-in uses a delivered single-use link. The account cookie stays
// HttpOnly; authentication writes use the current browser slot and CSRF token.
import { escapeHtml } from "./account-settings-ui.js";

export function createAuthSigninUI({ accountClient, ensureAccountSession, onSignedIn, onMagicLinkFailure, onBusyChange, beforeSignIn, onSignInUncertain, onMagicLinkRequest, onAccountSwitch }) {
  let container = null, emailPanel = null;
  let emailHost = false, emailMethod = "magic", passwordMode = "login", passwordEmail = "";
  let magicPhase = "request", magicEmail = "", busy = false;
  let magicManualCode = false, pendingLink = null, statusText = "", statusError = false;
  const surface = () => emailHost ? emailPanel : container;
  const statusNode = () => surface()?.querySelector("[data-signin-status]") ?? null;
  function setStatus(text, error = false) {
    statusText = text; statusError = error;
    const node = statusNode();
    if (node) { node.textContent = text; node.classList.toggle("visible", Boolean(text)); node.classList.toggle("error", Boolean(text) && error); }
  }
  async function authedSession() {
    await ensureAccountSession();
    return accountClient.currentSession("signing in");
  }
  const api = (session, path, data) => accountClient.request(path, { method: "POST", session, data });
  const authApi = async (session, path, data) => {
    const generation = accountClient.generation;
    const owns = () => accountClient.owns(generation, session);
    try {
      const view = await api(session, path, data);
      if (!owns()) throw Object.assign(new Error("The browser account changed. Sign in again."), { status: 409, code: "auth_view_changed" });
      return view;
    } catch (error) {
      const uncertain = !Number.isSafeInteger(error.status)
        || ["stale_session_revision", "session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code);
      if (uncertain && owns()) {
        accountClient.invalidate(generation, session);
        await onSignInUncertain?.();
      }
      throw error;
    }
  };
  const failureText = error => error?.message || "Couldn’t sign in. Try again.";
  function panelHtml() {
    if (emailMethod === "password") {
      const signup = passwordMode === "signup";
      return `<form data-signin-form="password" autocomplete="on">
        <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(passwordEmail)}"></label>
        <label>Password <input name="password" type="password" required autocomplete="${signup ? "new-password" : "current-password"}"></label>
        <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${signup ? "Create account" : "Sign in"}</button>
        <button type="button" class="text-button" data-password-mode="${signup ? "login" : "signup"}">${signup ? "Sign in" : "Create account"}</button>
        <button type="button" class="text-button" data-email-method="magic">Email me a sign-in link</button>
      </form>`;
    }
    if (pendingLink) return `<p class="form-hint">This link is for a different account.</p>
      <button type="button" class="button primary" data-magic-switch ${busy ? "disabled" : ""}>Switch account</button>`;
    if (magicPhase === "sent") return `<form data-signin-form="magic-code" autocomplete="on">
      <p class="form-hint">Check ${escapeHtml(magicEmail)} for your sign-in link.</p>
      ${magicManualCode ? `<label>Sign-in code <input name="code" required autocomplete="one-time-code" maxlength="128"></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>Sign in</button>` : ""}
      <button type="button" class="text-button" data-magic-manual-code>${magicManualCode ? "Hide code" : "Use a code instead"}</button>
      <button type="button" class="text-button" data-magic-restart>Use a different email</button>
    </form>`;
    return `<form data-signin-form="magic-request" autocomplete="on">
      <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(magicEmail)}"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>Email me a sign-in link</button>
      <button type="button" class="text-button" data-email-method="password">Use a password</button>
    </form>`;
  }
  function render() {
    const node = surface();
    if (node) node.innerHTML = `<div data-signin-panel>${panelHtml()}</div><p class="status form-status" role="alert" data-signin-status></p>`;
    setStatus(statusText, statusError);
  }
  const paintBusySurface = render;
  async function finish(view) {
    const session = view?.session ?? view;
    if (!session?.authenticated || !session?.account) throw new Error("Sign-in didn\u2019t complete. Try again.");
    setStatus("");
    await onSignedIn(session);
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true; onBusyChange?.(true); paintBusySurface(); setStatus("");
    try { await fn(); }
    catch (error) { setStatus(failureText(error), true); }
    finally { busy = false; onBusyChange?.(false); paintBusySurface(); }
  }

  async function redeem(email, code) {
    try {
      const session = await authedSession();
      const view = await authApi(session, "/api/auth/magic/consume", { email, code, sessionRevision: session.sessionRevision });
      await finish(view);
    } catch (error) {
      if (error.code === "magic_account_mismatch") pendingLink = { email, code };
      throw error;
    }
  }
  const onClick = async event => {
    if (busy) return;
    const method = event.target?.closest?.("[data-email-method]");
    const mode = event.target?.closest?.("[data-password-mode]");
    if (method || mode) {
      const currentEmail = surface()?.querySelector('[name="email"]')?.value;
      if (currentEmail) { magicEmail = currentEmail; passwordEmail = currentEmail; }
      if (method) emailMethod = method.dataset.emailMethod === "password" ? "password" : "magic";
      if (mode) passwordMode = mode.dataset.passwordMode === "signup" ? "signup" : "login";
      pendingLink = null; magicPhase = "request"; setStatus(""); render();
      surface()?.querySelector('[name="email"]')?.focus(); return;
    }
    if (event.target?.closest?.("[data-magic-switch]")) {
      if (!pendingLink || onAccountSwitch?.() !== true) return;
      const link = pendingLink;
      await withBusy(async () => {
        let ended;
        try { ended = await accountClient.logout(); }
        catch (error) {
          if (!accountClient.session) await onSignInUncertain?.();
          throw error;
        }
        if (!ended) throw new Error("The browser account changed. Sign in again.");
        await onSignInUncertain?.();
        if (accountClient.session?.authenticated) throw new Error("The browser account changed. Sign in again.");
        pendingLink = null;
        await redeem(link.email, link.code);
      });
      return;
    }
    if (event.target?.closest?.("[data-magic-manual-code]")) {
      magicManualCode = !magicManualCode; render(); return;
    }
    if (!event.target?.closest?.("[data-magic-restart]")) return;
    magicPhase = "request"; magicManualCode = false; pendingLink = null; setStatus("");
    render();
    surface()?.querySelector('[name="email"]')?.focus();
  };
  const onSubmit = async event => {
    const form = event.target?.closest?.('[data-signin-form]');
    if (!form || !(container?.contains?.(form) || emailPanel?.contains?.(form))) return;
    event.preventDefault();
    if (busy) return;
    if (form.dataset.signinForm === "password") {
      const fields = Object.fromEntries([...form.querySelectorAll('input[name]')].map(input => [input.name, input.value]));
      passwordEmail = fields.email?.trim() ?? "";
      if (passwordMode === "signup" && (fields.password?.length < 10 || fields.password?.length > 256)) {
        setStatus("Use 10–256 characters for your password.", true); return;
      }
      if (await beforeSignIn?.() === false) return;
      await withBusy(async () => {
        const session = await authedSession();
        const view = await authApi(session, `/api/auth/password/${passwordMode}`, { email: passwordEmail, password: fields.password, sessionRevision: session.sessionRevision });
        await finish(view);
      }); return;
    }
    if (form.dataset.signinForm === "magic-code") {
      const code = [...form.querySelectorAll('input[name]')].find(input => input.name === "code")?.value?.trim() ?? "";
      if (!magicManualCode || !code || await beforeSignIn?.() === false) return;
      await withBusy(() => redeem(magicEmail, code)); return;
    }
    if (form.dataset.signinForm !== "magic-request") return;
    const email = [...form.querySelectorAll('input[name]')].find(input => input.name === "email")?.value?.trim() ?? "";
    magicEmail = email;
    await withBusy(async () => {
      const session = await authedSession();
      const returnTo = onMagicLinkRequest?.();
      const reply = await api(session, "/api/auth/magic/request", { email, ...(returnTo ? { returnTo } : {}) });
      if (reply?.status === "unavailable") { setStatus(reply.message || "Email delivery isn’t configured on this Room.", true); return; }
      if (reply?.status !== "sent") throw new Error("Couldn’t send the sign-in link. Try again.");
      magicPhase = "sent"; magicManualCode = false;
      render();
    });
  };
  async function consumeMagicLinkFromUrl() {
    let params;
    try { params = new URLSearchParams(window.location.search); }
    catch { return; }
    const code = (params.get("magic") || "").trim();
    const email = (params.get("email") || "").trim();
    if (!code || !email) return;
    params.delete("magic");
    params.delete("email");
    const rest = params.toString();
    const clean = window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash;
    try { window.history.replaceState(null, "", clean); } catch { /* ignore */ }
    if (await beforeSignIn?.() === false) return;
    magicEmail = email;
    magicPhase = "sent";
    render();
    setStatus("Signing you in…");
    // The host makes redemption failures visible even before email entry opens.
    let linkFailure = null;
    await withBusy(async () => {
      try {
        await redeem(email, code);
      } catch (error) {
        linkFailure = failureText(error);
        throw error;
      }
    });
    if (linkFailure) onMagicLinkFailure?.(linkFailure);
  }

  function bind(node) {
    node.addEventListener("click", onClick);
    node.addEventListener("submit", onSubmit);
  }
  return {
    canLeave() { return !busy; },
    showMagic() {
      if (busy) return false;
      emailHost = false; emailMethod = "magic"; if (!pendingLink) magicPhase = "request"; render(); return true;
    },
    openEmail(_mode, panel) {
      if (busy) return false;
      if (panel) emailPanel = panel;
      emailHost = true; emailMethod = "magic";
      if (emailPanel) {
        emailPanel.hidden = false;
        if (!emailPanel.dataset.bound) { bind(emailPanel); emailPanel.dataset.bound = "1"; }
      }
      render(); return true;
    },
    closeEmail() {
      if (busy) return false;
      if (emailPanel) { emailPanel.hidden = true; emailPanel.innerHTML = ""; }
      emailHost = false; emailMethod = "magic"; if (!pendingLink) magicPhase = "request"; render(); return true;
    },
    clear() {
      magicPhase = "request"; magicEmail = ""; magicManualCode = false; pendingLink = null; statusText = ""; passwordEmail = ""; passwordMode = "login"; emailMethod = "magic"; busy = false;
      onBusyChange?.(false);
      if (emailPanel) { emailPanel.hidden = true; emailPanel.innerHTML = ""; }
      emailHost = false; render();
    },
    mount(target) {
      container = target; render(); bind(container);
      return consumeMagicLinkFromUrl();
    }
  };
}
