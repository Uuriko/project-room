// Multi-method sign-in / create-account surface (slice 7, RC-2026-09-17-016).
//
// Mounts into the auth panel next to the existing Google button and the
// room/account key forms: email+password (create account or sign in), email
// magic link, passkey, and recovery code, plus a GitHub OAuth button.
// Browser flows use the cookie slot: this module never reads the HttpOnly
// account cookie — it posts { ..., sessionRevision } with the CSRF token
// from the account session, and the server resolves the slot from the
// cookie (signInSlotToken in server/http.mjs). OAuth buttons drive the
// start routes with fetch + manual redirect so the CSRF header rides along
// and unconfigured providers surface an honest message instead of raw JSON.
import { base64urlToBytes, bytesToBase64url, escapeHtml } from "./account-settings-ui.js";

// Convert the server's authentication options into a PublicKeyCredentialRequestOptions.
export function toAuthenticationPublicKey(options) {
  return {
    challenge: base64urlToBytes(options.challenge),
    rpId: options.rpId,
    allowCredentials: (options.allowCredentials ?? []).map(credential => ({
      ...credential,
      id: base64urlToBytes(credential.id)
    })),
    userVerification: options.userVerification,
    timeout: options.timeout
  };
}

// Encode the get() credential for POST /api/auth/passkey/authenticate/finish.
export function toAuthenticationResponse(credential) {
  const response = credential.response ?? {};
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bytesToBase64url(response.authenticatorData),
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      signature: bytesToBase64url(response.signature),
      userHandle: response.userHandle == null ? null : bytesToBase64url(response.userHandle)
    }
  };
}

const METHOD_LABELS = { password: "Email + password", magic: "Magic link", passkey: "Passkey", recovery: "Recovery code" };

export function createAuthSigninUI({ accountClient, ensureAccountSession, onSignedIn, onOAuthStart, onMagicLinkFailure }) {
  let container = null;
  let activeMethod = null;
  let passwordMode = "signup"; // or "login"
  // Email may be kept across the create/sign-in toggle. The password is never
  // stored and never written back into the input, so only the browser's
  // password manager can offer a value.
  let passwordFields = { email: "" };
  let emailPanel = null;
  let passwordHost = "chooser";
  let magicPhase = "request"; // or "code"
  let magicEmail = "";
  let magicManualCode = false; // link-first: code entry is an opt-in fallback
  let busy = false;

  const statusNode = () => (passwordHost === "email" ? emailPanel?.querySelector?.("[data-signin-status]") : null)
    ?? container?.querySelector("[data-signin-status]") ?? null;
  function setStatus(text, error = false) {
    const node = statusNode();
    if (node) { node.textContent = text; node.classList.toggle("visible", Boolean(text)); node.classList.toggle("error", Boolean(text) && error); }
  }
  async function authedSession() {
    await ensureAccountSession();
    return accountClient.currentSession("signing in");
  }
  const api = (session, path, data) => accountClient.request(path, { method: "POST", session, data });
  const failureText = error => error?.message || "Couldn\u2019t sign in. Try again.";

  function shellHtml() {
    return `<p class="form-hint">Choose another sign-in method.</p>
      <div class="auth-oauth-row">
        <button type="button" class="button secondary" data-oauth="github">Continue with GitHub</button>
      </div>
      <div class="auth-methods" role="group" aria-label="Other sign-in methods">
        ${Object.entries(METHOD_LABELS).map(([method, label]) =>
          `<button type="button" class="button ghost" data-method="${method}" aria-pressed="${method === activeMethod}">${label}</button>`).join("")}
      </div>
      <div data-signin-panel>${panelHtml()}</div>
      <p class="status form-status" role="alert" data-signin-status></p>`;
  }
  function panelHtml() {
    if (activeMethod === "password") return passwordHtml();
    if (activeMethod === "magic") return magicHtml();
    if (activeMethod === "passkey") return passkeyHtml();
    if (activeMethod === "recovery") return recoveryHtml();
    return "";
  }
  function passwordHtml() {
    const signup = passwordMode === "signup";
    return `<form data-signin-form="password" autocomplete="on">
      ${passwordHost === "email" ? `<h2 class="auth-email-title">${signup ? "Create your account" : "Sign in with email"}</h2>` : `<div class="auth-method-tabs" role="group" aria-label="Create account or sign in">
        <button type="button" class="button ghost" data-password-mode="signup" aria-pressed="${signup}">Create account</button>
        <button type="button" class="button ghost" data-password-mode="login" aria-pressed="${!signup}">Sign in</button>
      </div>`}
      <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(passwordFields.email)}"></label>
      <label>Password <input name="password" type="password" required autocomplete="${signup ? "new-password" : "current-password"}" minlength="12" maxlength="256"${signup ? ` aria-describedby="auth-${passwordHost}-password-hint"` : ""}></label>
      ${signup ? `<p id="auth-${passwordHost}-password-hint" class="form-hint">Use at least 12 characters.</p>` : ""}
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${signup ? "Create account" : "Sign in"}</button>
      ${passwordHost === "email" ? `<p class="form-hint">${signup ? "Already have an account?" : "New here?"} <button type="button" class="text-button" data-password-mode="${signup ? "login" : "signup"}">${signup ? "Sign in" : "Create account"}</button></p>` : ""}
    </form>`;
  }
  function magicHtml() {
    if (magicPhase === "code") return `<form data-signin-form="magic-code" autocomplete="on">
      <p class="form-hint">We emailed a <strong>sign-in link</strong> to ${escapeHtml(magicEmail)}. Click the link in the email — no typing needed. It expires in 15 minutes.</p>
      ${magicManualCode
        ? `<label>Sign-in code <input name="code" type="text" required autocomplete="one-time-code" inputmode="text" maxlength="128" placeholder="Paste the code"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>Sign in</button>`
        : ``}
      <button type="button" class="text-button" data-magic-manual-code>${magicManualCode ? "Hide the code field" : "Or enter the code manually instead"}</button>
      <button type="button" class="text-button" data-magic-restart>Use a different email</button>
    </form>`;
    return `<form data-signin-form="magic-request" autocomplete="on">
      <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(magicEmail)}"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>Email me a sign-in link</button>
    </form>`;
  }
  function passkeyHtml() {
    const supported = typeof window !== "undefined" && typeof navigator !== "undefined" && !!window.PublicKeyCredential;
    return `<form data-signin-form="passkey">
      ${supported ? "" : `<p class="form-hint">This browser doesn\u2019t support passkeys.</p>`}
      <button class="button primary" type="submit" ${busy || !supported ? "disabled" : ""}>Sign in with passkey</button>
    </form>`;
  }
  function recoveryHtml() {
    return `<form data-signin-form="recovery" autocomplete="on">
      <p class="form-hint">Lost your other sign-in methods? Use one of your single-use recovery codes.</p>
      <label>Email <input name="email" type="email" required autocomplete="email" maxlength="254"></label>
      <label>Recovery code <input name="code" type="text" required autocomplete="off" spellcheck="false" maxlength="64" placeholder="xxxxxx-xxxxxx"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>Sign in</button>
    </form>`;
  }

  function render() { if (container) container.innerHTML = shellHtml(); }
  function renderPanel() {
    if (!container) return;
    const panel = container.querySelector("[data-signin-panel]");
    if (panel) panel.innerHTML = panelHtml();
    else render();
  }
  function paintPassword() {
    if (passwordHost === "email" && emailPanel) {
      emailPanel.hidden = false;
      let formHost = emailPanel.querySelector?.("[data-email-form]");
      if (!formHost) {
        emailPanel.innerHTML = `<div data-email-form></div><p class="status form-status" role="alert" data-signin-status></p>`;
        formHost = emailPanel.querySelector?.("[data-email-form]");
      }
      if (formHost) formHost.innerHTML = passwordHtml();
      else emailPanel.innerHTML = passwordHtml();
      return;
    }
    renderPanel();
  }
  function paintBusySurface() {
    if (activeMethod === "password" && passwordHost === "email") paintPassword();
    else renderPanel();
  }

  function readForm(form) {
    const values = {};
    for (const input of form.querySelectorAll("input[name]")) values[input.name] = input.value;
    return values;
  }

  async function finish(view) {
    const session = view?.session ?? view;
    if (!session?.authenticated || !session?.account) { setStatus("Sign-in didn\u2019t complete. Try again.", true); return; }
    setStatus("");
    await onSignedIn(session);
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true; paintBusySurface(); setStatus("");
    try { await fn(); }
    catch (error) { setStatus(failureText(error), true); }
    finally { busy = false; paintBusySurface(); }
  }

  const onClick = async event => {
    const methodButton = event.target?.closest?.("[data-method]");
    if (methodButton) {
      activeMethod = activeMethod === methodButton.dataset.method ? null : methodButton.dataset.method;
      render();
      return;
    }
    const modeButton = event.target?.closest?.("[data-password-mode]");
    if (modeButton) {
      if (busy) return;
      const form = modeButton.closest?.("form") ?? container?.querySelector('[data-signin-form="password"]');
      if (form) passwordFields = { email: form.querySelector('[name="email"]')?.value ?? "" };
      passwordMode = modeButton.dataset.passwordMode;
      if (emailPanel?.contains?.(modeButton)) passwordHost = "email";
      paintPassword();
      if (passwordHost === "email") emailPanel?.querySelector('[name="email"]')?.focus();
      return;
    }
    if (event.target?.closest?.("[data-magic-restart]")) {
      magicPhase = "request";
      magicManualCode = false;
      renderPanel();
      return;
    }
    if (event.target?.closest?.("[data-magic-manual-code]")) {
      magicManualCode = !magicManualCode;
      renderPanel();
      return;
    }
    const oauthButton = event.target?.closest?.("[data-oauth]");
    if (oauthButton) {
      // Stash a live invitation before navigating: the OAuth round-trip
      // drops the #invite/ fragment, and this is the only moment the
      // secret may touch sessionStorage.
      try { await onOAuthStart?.(); } catch {}
      // Direct navigation: the start route 302-redirects to GitHub when
      // configured and serves an honest HTML landing page when it is not.
      window.location.assign("/api/auth/github/start");
    }
  };

  const onSubmit = async event => {
    const form = event.target?.closest?.("[data-signin-form]");
    if (!form || !(container?.contains?.(form) || emailPanel?.contains?.(form))) return;
    event.preventDefault();
    const kind = form.dataset.signinForm;
    if (kind === "password") {
      const { email, password } = readForm(form);
      passwordFields = { email };
      await withBusy(async () => {
        const session = await authedSession();
        const view = await api(session, `/api/auth/password/${passwordMode}`,
          { email: email.trim(), password, sessionRevision: session.sessionRevision });
        await finish(view);
      });
      return;
    }
    if (kind === "magic-request") {
      const { email } = readForm(form);
      await withBusy(async () => {
        const session = await authedSession();
        const reply = await api(session, "/api/auth/magic/request", { email: email.trim() });
        if (reply?.status === "unavailable") { setStatus(reply.message || "Email delivery isn\u2019t configured on this Room.", true); return; }
        magicEmail = email.trim();
        magicPhase = "code";
        magicManualCode = false;
        renderPanel();
        setStatus("");
      });
      return;
    }
    if (kind === "magic-code") {
      const { code } = readForm(form);
      await withBusy(async () => {
        const session = await authedSession();
        const view = await api(session, "/api/auth/magic/consume",
          { email: magicEmail, code: code.trim(), sessionRevision: session.sessionRevision });
        await finish(view);
      });
      return;
    }
    if (kind === "passkey") {
      await withBusy(async () => {
        const session = await authedSession();
        const options = await api(session, "/api/auth/passkey/authenticate/options", {});
        const credential = await navigator.credentials.get({ publicKey: toAuthenticationPublicKey(options) });
        if (!credential) throw new Error("No passkey was selected.");
        const view = await api(session, "/api/auth/passkey/authenticate/finish",
          { challengeId: options.challengeId, response: toAuthenticationResponse(credential), sessionRevision: session.sessionRevision });
        await finish(view);
      });
      return;
    }
    if (kind === "recovery") {
      const { email, code } = readForm(form);
      await withBusy(async () => {
        const session = await authedSession();
        const reply = await api(session, "/api/auth/recovery-codes/redeem",
          { email: email.trim(), code: code.trim(), sessionRevision: session.sessionRevision });
        await finish(reply);
      });
    }
  };

  // One-tap magic link: the sign-in email links to ?magic=<code>&email=<addr>.
  // Redeem it immediately on load so the tap signs the user in with no
  // typing. The params are stripped from the URL before any network call
  // so the single-use code doesn't linger in history.
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
    if (accountClient.session?.authenticated) return;
    activeMethod = "magic";
    magicEmail = email;
    magicPhase = "code";
    renderPanel();
    setStatus("Signing you in…");
    // The status line above lives inside the collapsed "More options" panel,
    // so a failed redemption would leave the user staring at Welcome with no
    // indication the link failed. Report the failure to the host too, so first
    // paint can surface it visibly (QAX-002).
    let linkFailure = null;
    await withBusy(async () => {
      try {
        const session = await authedSession();
        const view = await api(session, "/api/auth/magic/consume",
          { email, code, sessionRevision: session.sessionRevision });
        const signed = view?.session ?? view;
        if (!signed?.authenticated || !signed?.account) throw new Error("Sign-in didn\u2019t complete. Try again.");
        await finish(view);
      } catch (error) {
        linkFailure = failureText(error);
        throw error;
      }
    });
    if (linkFailure && !accountClient.session?.authenticated) onMagicLinkFailure?.(linkFailure);
  }

  function bind(node) {
    node.addEventListener("click", onClick);
    node.addEventListener("submit", onSubmit);
  }

  return {
    showPassword(mode) {
      if (busy) return;
      passwordHost = "chooser";
      activeMethod = "password"; passwordMode = mode === "login" ? "login" : "signup";
      render();
    },
    // The welcome email step shares the invitation account form.
    openEmail(mode, panel) {
      if (busy) return false;
      if (panel) emailPanel = panel;
      passwordHost = "email";
      activeMethod = "password";
      passwordMode = mode === "login" ? "login" : "signup";
      if (emailPanel && !emailPanel.dataset.bound) {
        bind(emailPanel);
        emailPanel.dataset.bound = "1";
      }
      paintPassword();
      return true;
    },
    closeEmail() {
      if (busy) return false;
      passwordFields = { email: emailPanel?.querySelector('[name="email"]')?.value ?? passwordFields.email };
      if (emailPanel) { emailPanel.hidden = true; emailPanel.innerHTML = ""; }
      passwordHost = "chooser";
      activeMethod = null;
      render();
      return true;
    },
    // Sign-out. Drops every in-memory auth field, including any password that
    // was only held for the request that just finished.
    clear() {
      passwordFields = { email: "" };
      passwordMode = "signup";
      passwordHost = "chooser";
      activeMethod = null;
      magicPhase = "request";
      magicEmail = "";
      magicManualCode = false;
      busy = false;
      if (emailPanel) { emailPanel.hidden = true; emailPanel.innerHTML = ""; }
      render();
    },
    mount(target) {
      container = target;
      render();
      container.addEventListener("click", onClick);
      container.addEventListener("submit", onSubmit);
      void consumeMagicLinkFromUrl();
    }
  };
}
