// Email sign-in uses a delivered single-use link. The account cookie stays
// HttpOnly; authentication writes use the current browser slot and CSRF token.
import { escapeHtml } from "./account-settings-ui.js";

// Shared by startup routing and redemption so malformed reset links do not
// reserve the invitation journey. This classifies input; it never consumes it.
export function classifyAuthLink(params) {
  const hasReset = params.has("reset"), hasMagic = params.has("magic");
  if (!hasReset && !hasMagic && !params.has("email")) return { kind: "none" };
  const proof = (params.get(hasReset ? "reset" : "magic") || "").trim();
  const email = (params.get("email") || "").trim();
  if (hasReset === hasMagic || params.getAll(hasReset ? "reset" : "magic").length !== 1
    || params.getAll("email").length !== 1 || !proof || !email) return { kind: "invalid" };
  return { kind: hasReset ? "reset" : "magic", proof, email };
}

export function createAuthSigninUI({ accountClient, ensureAccountSession, onSignedIn, onMagicLinkFailure, onBusyChange, beforeSignIn, onSignInUncertain, onMagicLinkRequest, onAccountSwitch, onPasswordResetComplete, onViewChange, onBack }) {
  let container = null;
  let emailMethod = "password", passwordMode = "login", passwordEmail = "";
  let magicPhase = "request", magicEmail = "", busy = false;
  let resetPhase = "request", resetEmail = "", resetCode = "";
  let magicManualCode = false, pendingLink = null, pendingTerms = null, statusText = "", statusError = false;
  const surface = () => container;
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
  const mutationApi = async (session, path, data, validate) => {
    const generation = accountClient.generation;
    const owns = () => accountClient.owns(generation, session);
    try {
      const view = await api(session, path, data);
      if (!owns()) throw Object.assign(new Error("The browser account changed. Sign in again."), { status: 409, code: "auth_view_changed" });
      if (!validate(view)) {
        throw new Error("Sign-in didn’t complete. Try again.");
      }
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
  const authApi = (session, path, data) => mutationApi(session, path, data, view => {
    const signed = view?.session ?? view;
    return signed?.authenticated === true && typeof signed.account?.id === "string" && Boolean(signed.account.id.trim());
  });
  function currentView() {
    if (pendingTerms) return "terms";
    if (pendingLink) return "account-switch";
    if (emailMethod === "forgot") return "forgot";
    if (emailMethod === "reset") return `reset-${resetPhase}`;
    return emailMethod === "password" ? `password-${passwordMode}` : `magic-${magicPhase}`;
  }
  function showView(view) {
    if (busy || pendingTerms) return false;
    const valid = ["password-login", "password-signup", "forgot", "reset-request", "reset-sent", "reset-form", "magic-request", "magic-sent", "account-switch"];
    if (!valid.includes(view)) return false;
    if (view === "account-switch") { if (!pendingLink) return false; }
    else {
      pendingLink = null;
      if (view.startsWith("password-")) { emailMethod = "password"; passwordMode = view.slice(9); }
      else if (view.startsWith("reset-")) { emailMethod = "reset"; resetPhase = view.slice(6); }
      else if (view.startsWith("magic-")) { emailMethod = "magic"; magicPhase = view.slice(6); }
      else emailMethod = "forgot";
    }
    setStatus(""); render(); focusView(); return true;
  }
  function focusView() {
    const node = surface();
    const target = node?.querySelector('[name="email"]') || node?.querySelector('[name="newPassword"]') || node?.querySelector("[data-reset-password]") || node?.querySelector("button:not([data-signin-back]):not(:disabled)");
    target?.focus();
  }
  function back() { if (busy) return false; resetCode = ""; return showView("password-login"); }
  const failureText = error => error?.message || "Couldn’t sign in. Try again.";
  function panelHtml() {
    if (pendingTerms) return `<form data-signin-form="terms"><p class="form-hint">The terms changed. Read the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>, then continue.</p><button class="button primary" type="submit" ${busy ? "disabled" : ""}>Agree and continue</button></form>`;
    if (pendingLink) return `<p class="form-hint">This link is for a different account.</p><button type="button" class="button primary" data-magic-switch ${busy ? "disabled" : ""}>Switch account</button>`;
    if (emailMethod === "forgot") return `<button type="button" class="button primary" data-recovery-option="reset" data-reset-password>Reset password</button><button type="button" class="text-button" data-recovery-option="magic" data-email-method="magic">Email me a sign-in link</button>`;
    if (emailMethod === "reset") {
      if (resetPhase === "sent") return `<p class="form-hint">If an account uses ${escapeHtml(resetEmail)}, check your email for a password reset link.</p><button type="button" class="text-button" data-recovery-option="reset" data-reset-password>Use a different email</button>`;
      if (resetPhase === "form") return `<form data-signin-form="reset-consume"><label>New password <input name="newPassword" type="password" required autocomplete="new-password" minlength="10" maxlength="256"></label><label>Confirm new password <input name="confirmPassword" type="password" required autocomplete="new-password" minlength="10" maxlength="256"></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>Reset password</button></form>`;
      return `<form data-signin-form="reset-request"><label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(resetEmail || passwordEmail)}"></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>Email password reset link</button></form>`;
    }
    if (emailMethod === "password") {
      const signup = passwordMode === "signup";
      return `<form data-signin-form="password" autocomplete="on">
        <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(passwordEmail)}"></label>
        <label>Password <input name="password" type="password" required autocomplete="${signup ? "new-password" : "current-password"}"></label>
        <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${signup ? "Create account" : "Sign in"}</button>
        <button type="button" class="text-button" data-password-mode="${signup ? "login" : "signup"}">${signup ? "Sign in" : "Create account"}</button>
        <button type="button" class="text-button" data-forgot-password>Forgot password?</button>
      </form>`;
    }
    if (magicPhase === "sent") return `<form data-signin-form="magic-code" autocomplete="on">
      <p class="form-hint">Check ${escapeHtml(magicEmail)} for your sign-in link.</p>
      ${magicManualCode ? `<label>Sign-in code <input name="code" required autocomplete="one-time-code" maxlength="128"></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>Sign in</button>` : ""}
      <button type="button" class="text-button" data-magic-manual-code>${magicManualCode ? "Hide code" : "Use a code instead"}</button>
      <button type="button" class="text-button" data-magic-restart>Use a different email</button>
    </form>`;
    return `<form data-signin-form="magic-request" autocomplete="on">
      <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(magicEmail)}"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>Email me a sign-in link</button>

    </form>`;
  }
  function render() {
    const node = surface();
    const view = currentView();
    const hideBack = view.startsWith("password-") || view === "terms";
    if (node) node.innerHTML = `${hideBack ? "" : `<button type="button" class="text-button" data-signin-back ${busy ? "disabled" : ""}>Back</button>`}<div data-signin-panel>${panelHtml()}</div><p class="status form-status" role="alert" data-signin-status></p>`;
    setStatus(statusText, statusError);
    onViewChange?.(currentView());
  }
  const paintBusySurface = render;
  async function finish(view) {
    const session = view?.session ?? view;
    if (!session?.authenticated || !session?.account) throw new Error("Sign-in didn\u2019t complete. Try again.");
    if (session.terms?.required) {
      pendingTerms = session;
      setStatus("");
      render();
      return;
    }
    pendingTerms = null;
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
      if (error.code === "magic_account_mismatch") pendingLink = { kind: "magic", email, code };
      throw error;
    }
  }
  const onClick = async event => {
    if (busy) return;
    if (event.target?.closest?.("[data-signin-back]")) { if (onBack?.() !== false) back(); return; }
    if (event.target?.closest?.("[data-forgot-password]")) {
      const email = surface()?.querySelector('[name="email"]')?.value?.trim();
      if (email) passwordEmail = magicEmail = resetEmail = email;
      showView("forgot"); return;
    }
    const recovery = event.target?.closest?.("[data-recovery-option]");
    if (recovery) { showView(recovery.dataset.recoveryOption === "reset" ? "reset-request" : "magic-request"); return; }
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
        if (link.kind === "reset") { resetEmail = link.email; resetCode = link.code; emailMethod = "reset"; resetPhase = "form"; }
        else await redeem(link.email, link.code);
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
    if (!form || !container?.contains?.(form)) return;
    event.preventDefault();
    if (busy) return;
    if (form.dataset.signinForm === "terms") {
      const session = pendingTerms;
      if (!session?.terms?.version) return;
      await withBusy(async () => {
        const accepted = await api(session, "/api/account/terms", { version: session.terms.version });
        pendingTerms = null;
        await finish(accepted);
      });
      return;
    }
    if (form.dataset.signinForm === "reset-consume") {
      const fields = Object.fromEntries([...form.querySelectorAll('input[name]')].map(input => [input.name, input.value]));
      if (!resetCode) { setStatus("Request a new password reset link.", true); return; }
      if (fields.newPassword?.length < 10 || fields.newPassword?.length > 256) { setStatus("Use 10–256 characters for your password.", true); return; }
      if (fields.newPassword !== fields.confirmPassword) { setStatus("Passwords don’t match.", true); return; }
      if (await beforeSignIn?.() === false) return;
      await withBusy(async () => {
        const session = await authedSession(), generation = accountClient.generation;
        try {
          await mutationApi(session, "/api/auth/password/reset/consume", { email: resetEmail, code: resetCode, newPassword: fields.newPassword, sessionRevision: session.sessionRevision }, reply => reply?.status === "password_reset" && reply.signInRequired === true);
        } catch (error) {
          if (error.code === "reset_account_mismatch") pendingLink = { kind: "reset", email: resetEmail, code: resetCode };
          throw error;
        }
        if (!accountClient.invalidate(generation, session)) throw Object.assign(new Error("The browser account changed. Sign in again."), { status: 409, code: "auth_view_changed" });
        resetCode = ""; passwordEmail = resetEmail; emailMethod = "password"; passwordMode = "login";
        await onPasswordResetComplete?.();
        setStatus("Password reset. Sign in to continue.");
      }); return;
    }
    if (form.dataset.signinForm === "password") {
      const fields = Object.fromEntries([...form.querySelectorAll('input[name]')].map(input => [input.name, input.value]));
      passwordEmail = fields.email?.trim() ?? "";
      if (passwordMode === "signup" && (fields.password?.length < 10 || fields.password?.length > 256)) {
        setStatus("Use 10–256 characters for your password.", true); return;
      }
      if (await beforeSignIn?.() === false) return;
      await withBusy(async () => {
        const session = await authedSession();
        if (passwordMode === "signup") {
          const reply = await api(session, "/api/auth/password/signup", { email: passwordEmail, password: fields.password, sessionRevision: session.sessionRevision });
          if (reply?.status !== "check_email" || typeof reply.mailConfigured !== "boolean") throw new Error("Couldn’t create the account. Try again.");
          const restored = await accountClient.restore();
          if (restored?.authenticated) {
            await onSignedIn?.(restored);
            setStatus(reply.mailConfigured ? "Check your email for a verification code." : "Email delivery isn’t configured, so this account stays unverified.");
          } else {
            // Unauthenticated after a uniform 202 means the email was already
            // registered. Never promise a sign-in link when mail is off.
            setStatus(reply.mailConfigured
              ? "Check your email for a sign-in link."
              : "Email delivery isn’t configured on this Room, so no sign-in link was sent. If this email is already registered, sign in instead.");
          }
          return;
        }
        const view = await authApi(session, "/api/auth/password/login", { email: passwordEmail, password: fields.password, sessionRevision: session.sessionRevision });
        await finish(view);
      }); return;
    }
    if (form.dataset.signinForm === "magic-code") {
      const code = [...form.querySelectorAll('input[name]')].find(input => input.name === "code")?.value?.trim() ?? "";
      if (!magicManualCode || !code || await beforeSignIn?.() === false) return;
      await withBusy(() => redeem(magicEmail, code)); return;
    }
    const resetting = form.dataset.signinForm === "reset-request";
    if (!resetting && form.dataset.signinForm !== "magic-request") return;
    const email = [...form.querySelectorAll('input[name]')].find(input => input.name === "email")?.value?.trim() ?? "";
    if (resetting) resetEmail = email; else magicEmail = email;
    await withBusy(async () => {
      const session = await authedSession();
      const returnTo = onMagicLinkRequest?.();
      const reply = await api(session, resetting ? "/api/auth/password/reset/request" : "/api/auth/magic/request", { email, ...(returnTo ? { returnTo } : {}) });
      if (reply?.status === "unavailable") { setStatus(reply.message || "Email delivery isn’t configured on this Room.", true); return; }
      if (reply?.status !== "sent") throw new Error("Couldn’t send the sign-in link. Try again.");
      if (resetting) resetPhase = "sent"; else magicPhase = "sent"; magicManualCode = false;
      render();
    });
  };
  async function consumeMagicLinkFromUrl() {
    let params;
    try { params = new URLSearchParams(window.location.search); }
    catch { return; }
    const link = classifyAuthLink(params);
    if (link.kind === "none") return;
    // Clear every auth parameter even when validation fails or proofs compete.
    params.delete("reset"); params.delete("magic"); params.delete("email");
    const rest = params.toString();
    const clean = window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash;
    try { window.history.replaceState(null, "", clean); } catch { /* URL cleanup may be unavailable */ }
    if (link.kind === "invalid") {
      const message = "This sign-in link is incomplete or invalid.";
      // Mounting hosts finish wiring their other sign-in controls this turn.
      await Promise.resolve();
      onMagicLinkFailure?.(message);
      setStatus(`${message} Request a new link.`, true);
      return;
    }
    const { proof, email } = link;
    if (link.kind === "reset") {
      resetCode = proof; resetEmail = email;
      emailMethod = "reset"; resetPhase = "form"; render(); focusView();
      return { pendingPasswordReset: true };
    }
    const code = proof;
    if (await beforeSignIn?.() === false) return;
    emailMethod = "magic"; magicEmail = email;
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
    canLeave() { return !busy && !pendingTerms; },
    requireTerms(session) {
      if (!session?.terms?.required) return false;
      pendingTerms = session;
      setStatus("");
      render();
      return true;
    },
    showView, back, focus: focusView,
    showPassword(mode = "login") { return showView(mode === "signup" ? "password-signup" : "password-login"); },
    showMagic() {
      if (busy) return false;
      emailMethod = "magic"; if (!pendingLink) magicPhase = "request"; render(); return true;
    },
    openEmail(mode = "magic", panel) {
      if (busy) return false;
      if (panel && container && !panel.contains?.(container)) panel.prepend?.(container);
      if (panel) panel.hidden = false;
      emailMethod = mode === "password" ? "password" : "magic";
      render(); return true;
    },
    closeEmail() { return back(); },
    clear() {
      resetCode = ""; resetEmail = ""; resetPhase = "request"; magicPhase = "request"; magicEmail = ""; magicManualCode = false; pendingLink = null; pendingTerms = null; statusText = ""; passwordEmail = ""; passwordMode = "login"; emailMethod = "password"; busy = false;
      onBusyChange?.(false);
      render();
    },
    mount(target) {
      container = target; render(); bind(container);
      return consumeMagicLinkFromUrl();
    }
  };
}
