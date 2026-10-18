import { uiText } from './strings.js';
// Email sign-in uses a delivered single-use link. The account cookie stays
// HttpOnly; authentication writes use the current browser slot and CSRF token.
import { escapeHtml, base64urlToBytes, bytesToBase64url } from "./account-settings-ui.js";

export function toAuthenticationPublicKey(options) {
  const { challengeId: _challengeId, ...publicKey } = options;
  return { ...publicKey, challenge: base64urlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(credential => ({ ...credential, id: base64urlToBytes(credential.id) })) };
}

export function toAuthenticationResponse(credential) {
  return { id: credential.id, rawId: bytesToBase64url(credential.rawId), type: credential.type,
    response: { clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
      authenticatorData: bytesToBase64url(credential.response.authenticatorData),
      signature: bytesToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle == null ? null : bytesToBase64url(credential.response.userHandle) } };
}

// Shared by startup routing and redemption so malformed reset links do not
// reserve the invitation journey. This classifies input; it never consumes it.
export function classifyAuthLink(params) {
  const hasReset = params.has("reset"), hasMagic = params.has("magic");
  if (!hasReset && !hasMagic && !params.has("email")) return { kind: "none" };
  // Signup mail carries no proof: the verification email (?verify=email) and
  // the already-registered notice (?signin=1) only open the app. They are not
  // broken sign-in links, so they must not report one.
  if (!hasReset && !hasMagic) {
    const email = (params.get("email") || "").trim();
    const one = (name, value) => params.getAll(name).length === 1 && params.get(name) === value;
    const notice = one("signin", "1") && !params.has("verify") ? "signin"
      : one("verify", "email") && !params.has("signin") ? "verify" : null;
    if (notice && params.getAll("email").length === 1 && email) return { kind: "notice", notice, email };
  }
  const proof = (params.get(hasReset ? "reset" : "magic") || "").trim();
  const email = (params.get("email") || "").trim();
  if (hasReset === hasMagic || params.getAll(hasReset ? "reset" : "magic").length !== 1
    || params.getAll("email").length !== 1 || !proof || !email) return { kind: "invalid" };
  return { kind: hasReset ? "reset" : "magic", proof, email };
}

export function createAuthSigninUI({ accountClient, ensureAccountSession, onSignedIn, onMagicLinkFailure, onBusyChange, beforeSignIn, onSignInUncertain, onMagicLinkRequest, onAccountSwitch, onPasswordResetComplete, onViewChange, onBack, credentials, loadSigninOptions, onProviderCapabilities }) {
  let container = null, welcome = false, mountedBefore = false;
  let emailMethod = "password", passwordMode = "login", passwordEmail = "";
  // Front-door batch B-1 (#3771): the typed password survives a
  // Log-in <-> Create-account mode switch. render() rebuilds the form, so
  // the value is kept here and restored into the fresh input — the switch
  // used to clear it silently (17 chars -> 0) while keeping the email.
  let preservedPassword = "";
  let magicPhase = "request", magicEmail = "", busy = false;
  let resetPhase = "request", resetEmail = "", resetCode = "";
  let magicManualCode = false, pendingLink = null, pendingTerms = null, statusText = "", statusError = false;
  // Whether this deployment can actually send sign-in email, learned from
  // the public /api/auth/signin-options feed at mount. Defaults to true
  // (fail-open to the historical behavior, whose submit-time honesty stays
  // as backstop) until the feed positively reports mail unconfigured —
  // only then are the email-link offers hidden (§8.1: never offer a
  // sign-in method the deployment cannot serve).
  let mailConfigured = true;
  const surface = () => container;
  const statusNode = () => surface()?.querySelector("[data-signin-status]") ?? null;
  function setStatus(text, error = false) {
    statusText = text; statusError = error;
    // A fresh sign-in outcome supersedes the stale panel-level notice left by
    // sign-out (e.g. "Session ended; private drafts were cleared."): one alert
    // at a time, so two red role=alert errors never show together.
    if (text) {
      const panelNotice = globalThis.document?.getElementById?.("auth-error");
      if (panelNotice && panelNotice !== statusNode() && panelNotice.textContent) panelNotice.textContent = "";
    }
    const node = statusNode();
    if (node) { node.textContent = text; node.classList.toggle("visible", Boolean(text)); node.classList.toggle("error", Boolean(text) && error); }
  }
  async function authedSession() {
    await ensureAccountSession();
    return accountClient.currentSession("signing in");
  }
  // Learn the deployment's sign-in capabilities once at mount, through
  // the host-injected loader (kept off accountClient.request so request
  // accounting in hosts/tests is untouched). Only a positive "mail not
  // configured" answer changes anything; a missing loader or any failure
  // (offline, older server) leaves the historical behavior in place.
  async function loadSigninCapabilities() {
    if (typeof loadSigninOptions !== "function") return;
    try {
      const options = await loadSigninOptions();
      if (options?.providers?.mail?.configured === false) {
        mailConfigured = false;
        if (emailMethod === "magic" && !pendingLink) { emailMethod = "password"; passwordMode = "login"; }
        render();
      }
      // The OAuth anchors are static HTML outside this component; the host
      // owns them. Hand it the same feed answer so an OAuth provider this
      // deployment cannot serve (its start route answers 503) is never
      // offered (§8.1, same rule as mail above). Fires only on a successful
      // load — a missing loader or any failure leaves the anchors as-is.
      if (options?.providers) onProviderCapabilities?.(options.providers);
    } catch { /* fail open — see the mailConfigured note above */ }
  }
  const api = (session, path, data) => accountClient.request(path, { method: "POST", session, data });
  const mutationApi = async (session, path, data, validate) => {
    const generation = accountClient.generation;
    const owns = () => accountClient.owns(generation, session);
    try {
      const view = await api(session, path, data);
      if (!owns()) throw Object.assign(new Error(uiText("signin.copy.001")), { status: 409, code: "auth_view_changed" });
      if (!validate(view)) {
        throw new Error(uiText("signin.copy.002"));
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
    if (welcome) return "welcome";
    if (pendingLink) return "account-switch";
    if (emailMethod === "forgot") return "forgot";
    if (emailMethod === "reset") return `reset-${resetPhase}`;
    // The merged form is the only email entry (#3341): a magic state in
    // its request phase reports as the password view it renders.
    if (emailMethod === "magic") return magicPhase === "sent" ? "magic-sent" : `password-${passwordMode}`;
    return `password-${passwordMode}`;
  }
  function showView(view) {
    if (busy || pendingTerms) return false;
    const valid = ["welcome", "password-login", "password-signup", "forgot", "reset-request", "reset-sent", "reset-form", "magic-request", "magic-sent", "account-switch"];
    if (!valid.includes(view)) return false;
    // "magic-request" is a retired view name (#3341 merge); stored
    // history entries and older hosts still ask for it — it lands on
    // the merged form.
    if (view === "magic-request") view = "password-login";
    // An unconfigured-mail deployment has no magic views to show.
    if (view.startsWith("magic-") && !mailConfigured) view = "password-login";
    if (view === "account-switch") { if (!pendingLink) return false; }
    else {
      pendingLink = null;
      if (view === "welcome") { emailMethod = "password"; passwordMode = "login"; }
      else if (view.startsWith("password-")) { emailMethod = "password"; passwordMode = view.slice(9); }
      else if (view.startsWith("reset-")) { emailMethod = "reset"; resetPhase = view.slice(6); }
      else if (view.startsWith("magic-")) { emailMethod = "magic"; magicPhase = view.slice(6); }
      else emailMethod = "forgot";
    }
    welcome = view === "welcome";
    setStatus(""); render(); focusView(); return true;
  }
  function focusView() {
    const node = surface();
    const selectors = ['[name="email"]', '[name="newPassword"]', '[data-reset-password]', 'button:not([data-signin-back]):not(:disabled)'];
    const candidates = node ? selectors.flatMap(selector => [...node.querySelectorAll(selector)]) : [];
    const target = candidates.find(element => !element.closest("[hidden]") && element.getClientRects().length > 0);
    target?.focus();
  }
  function back() { if (busy) return false; resetCode = ""; return showView("password-login"); }
  const failureText = error => error?.message || uiText("signin.copy.003");
  function panelHtml() {
    if (pendingTerms) return uiText("signin.copy.005", { fragmentA: busy ? "disabled" : "" });
    if (welcome) return uiText("signin.copy.004");
    if (pendingLink) return uiText("signin.copy.006", { fragmentA: busy ? "disabled" : "" });
    // #3341 (one-email-field merge): there is no separate magic-request
    // view anymore — the password form IS the email form. emailMethod
    // "magic" survives only in its sent phase (a link/code is on its
    // way); any other magic state renders the merged form below.
    const method = emailMethod === "magic" && magicPhase !== "sent" ? "password" : emailMethod;
    if (method === "forgot") {
      const passkeySupported = Boolean(credentials?.get || (globalThis.PublicKeyCredential && globalThis.navigator?.credentials?.get));
      return uiText("signin.copy.007") + (mailConfigured ? uiText("signin.magic.action") : "") + (passkeySupported ? uiText("signin.passkey.action") : "");
    }
    if (method === "reset") {
      if (resetPhase === "sent") return uiText("signin.copy.008", { fragmentA: escapeHtml(resetEmail) });
      if (resetPhase === "form") return uiText("signin.copy.009", { fragmentA: busy ? "disabled" : "" });
      const passkeySupported = Boolean(credentials?.get || (globalThis.PublicKeyCredential && globalThis.navigator?.credentials?.get));
      return uiText("signin.copy.010", { fragmentA: escapeHtml(resetEmail || passwordEmail), fragmentB: busy ? "disabled" : "" }) + (mailConfigured ? uiText("signin.magic.instead") : "") + (passkeySupported ? uiText("signin.passkey.action") : "");
    }
    if (method === "password") {
      const signup = passwordMode === "signup";
      // The merged form: in login mode the password is optional whenever
      // this deployment can email a sign-in link instead — the input
      // carries `required` only for signup, or when mail is
      // unconfigured and a password is the only way in. Recovery options
      // explain the email-link path when someone needs it.
      return uiText("signin.copy.011", { fragmentA: escapeHtml(passwordEmail), fragmentB: signup ? "new-password" : "current-password", fragmentC: signup ? 'required minlength="10"' : (mailConfigured ? "" : "required"), fragmentE: busy ? "disabled" : "", fragmentF: busy ? (signup ? "Creating account…" : "Logging in…") : (signup ? "Create account" : "Log in"), fragmentG: signup ? "login" : "signup", fragmentH: signup ? "Log in" : "Create account", fragmentI: signup ? "" : uiText("signin.login-options") });
    }
    return uiText("signin.copy.012", { fragmentA: escapeHtml(magicEmail), fragmentB: magicManualCode ? uiText("signin.copy.013", { fragmentA: busy ? "disabled" : "" }) : "", fragmentC: magicManualCode ? "Hide code" : uiText("signin.copy.014") });
  }
  function render() {
    if (mountedBefore && !container) return;
    const node = surface();
    const view = currentView();
    const hideBack = view === "welcome" || view === "terms" || view.startsWith("password-");
    if (node) node.innerHTML = ["", hideBack ? "" : `<button type="button" class="text-button" data-signin-back ${busy ? "disabled" : ""}>Back</button>`, "<div data-signin-panel>", panelHtml(), "</div><p class=\"status form-status\" role=\"alert\" data-signin-status></p>"].join('');
    if (node) {
      node.setAttribute("aria-busy", String(busy));
      for (const control of node.querySelectorAll("input, button")) control.disabled = busy;
    }
    setStatus(statusText, statusError);
    onViewChange?.(currentView());
  }
  const paintBusySurface = render;
  async function finish(view) {
    const session = view?.session ?? view;
    if (!session?.authenticated || !session?.account) throw new Error(uiText("signin.copy.016"));
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
  // Ask the server to email a sign-in link/code for this address (the
  // merged form's blank-password path, #3341). The endpoint answers
  // uniformly whether or not the address has an account, so nothing
  // leaks about which addresses are registered. Returns true when the
  // sent view should show; on the honest "unavailable" answer it sets
  // the status itself and returns false.
  async function requestEmailLink(session, email) {
    const returnTo = onMagicLinkRequest?.();
    const reply = await api(session, "/api/auth/magic/request", { email, ...(returnTo ? { returnTo } : {}) });
    if (reply?.status === "unavailable") { setStatus(reply.message || uiText("signin.copy.030"), true); return false; }
    if (reply?.status !== "sent") throw new Error(uiText("signin.copy.031"));
    emailMethod = "magic"; magicEmail = email; magicPhase = "sent"; magicManualCode = false;
    return true;
  }
  const onClick = async event => {
    if (busy) return;
    if (event.target?.closest?.("[data-passkey-signin]")) {
      const provider = credentials ?? globalThis.navigator?.credentials;
      if (!provider?.get || await beforeSignIn?.() === false) return;
      const email = surface()?.querySelector('[name="email"]')?.value?.trim();
      if (email) passwordEmail = email;
      await withBusy(async () => {
        try {
          const session = await authedSession();
          const generation = accountClient.generation;
          const options = await api(session, "/api/auth/passkey/authenticate/options", {});
          const credential = await provider.get({ publicKey: toAuthenticationPublicKey(options) });
          if (!credential) throw Object.assign(new Error(), { name: "NotAllowedError" });
          if (!accountClient.owns(generation, session)) throw new Error(uiText("signin.copy.001"));
          const view = await authApi(session, "/api/auth/passkey/authenticate/finish", {
            challengeId: options.challengeId, response: toAuthenticationResponse(credential), sessionRevision: session.sessionRevision
          });
          await finish(view);
        } catch (error) {
          if (error?.name === "NotAllowedError") throw new Error(uiText("signin.passkey.cancelled"));
          throw error;
        }
      });
      return;
    }
    const visibility = event.target?.closest?.("[data-password-visibility]");
    if (visibility) {
      const input = surface()?.querySelector('[name="password"]');
      if (!input) return;
      const shown = input.type === "password";
      input.type = shown ? "text" : "password";
      visibility.setAttribute("aria-label", shown ? "Hide password" : "Show password");
      visibility.setAttribute("aria-pressed", String(shown));
      return;
    }
    if (event.target?.closest?.("[data-signin-back]")) { if (onBack?.() !== false) { if (currentView().startsWith("password-")) showView("welcome"); else back(); } return; }
    if (event.target?.closest?.("[data-forgot-password]")) {
      const email = surface()?.querySelector('[name="email"]')?.value?.trim();
      if (email) passwordEmail = magicEmail = resetEmail = email;
      showView("reset-request"); return;
    }
    const recovery = event.target?.closest?.("[data-recovery-option]");
    if (recovery) {
      const email = surface()?.querySelector('[name="email"]')?.value?.trim();
      if (email) passwordEmail = magicEmail = resetEmail = email;
      // The "email me a link" recovery option lands on the merged form
      // (#3341): submitting it with a blank password sends the link.
      showView(recovery.dataset.recoveryOption === "reset" ? "reset-request" : "password-login"); return;
    }
    const method = event.target?.closest?.("[data-email-method]");
    const mode = event.target?.closest?.("[data-password-mode]");
    if (method || mode) {
      welcome = false;
      const currentEmail = surface()?.querySelector('[name="email"]')?.value;
      if (currentEmail) { magicEmail = currentEmail; passwordEmail = currentEmail; }
      const currentPassword = surface()?.querySelector('[name="password"]')?.value;
      if (typeof currentPassword === "string") preservedPassword = currentPassword;
      // One merged email form (#3341): every method/mode switch lands
      // on it; the mode switch still chooses login vs signup.
      emailMethod = "password";
      if (mode) passwordMode = mode.dataset.passwordMode === "signup" ? "signup" : "login";
      pendingLink = null; magicPhase = "request"; setStatus(""); render();
      // B-1: restore the password captured at this switch — and only here.
      // A submit repaint (e.g. after a rejected password) must never
      // repaint it; preservation is a mode-switch behavior, not a render
      // behavior.
      const switchedPassword = surface()?.querySelector('[name="password"]');
      if (switchedPassword && preservedPassword) switchedPassword.value = preservedPassword;
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
        if (!ended) throw new Error(uiText("signin.copy.017"));
        await onSignInUncertain?.();
        if (accountClient.session?.authenticated) throw new Error(uiText("signin.copy.018"));
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
      if (!resetCode) { setStatus(uiText("signin.copy.019"), true); return; }
      if (fields.newPassword?.length < 10 || fields.newPassword?.length > 256) { setStatus(uiText("signin.copy.020"), true); return; }
      if (fields.newPassword !== fields.confirmPassword) { setStatus(uiText("signin.copy.021"), true); return; }
      if (await beforeSignIn?.() === false) return;
      await withBusy(async () => {
        const session = await authedSession(), generation = accountClient.generation;
        try {
          await mutationApi(session, "/api/auth/password/reset/consume", { email: resetEmail, code: resetCode, newPassword: fields.newPassword, sessionRevision: session.sessionRevision }, reply => reply?.status === "password_reset" && reply.signInRequired === true);
        } catch (error) {
          if (error.code === "reset_account_mismatch") pendingLink = { kind: "reset", email: resetEmail, code: resetCode };
          throw error;
        }
        if (!accountClient.invalidate(generation, session)) throw Object.assign(new Error(uiText("signin.copy.022")), { status: 409, code: "auth_view_changed" });
        resetCode = ""; passwordEmail = resetEmail; emailMethod = "password"; passwordMode = "login";
        await onPasswordResetComplete?.();
        setStatus(uiText("signin.copy.023"));
      }); return;
    }
    if (form.dataset.signinForm === "password") {
      const fields = Object.fromEntries([...form.querySelectorAll('input[name]')].map(input => [input.name, input.value]));
      passwordEmail = fields.email?.trim() ?? "";
      if (passwordMode === "signup" && (fields.password?.length < 10 || fields.password?.length > 256)) {
        setStatus(uiText("signin.copy.024"), true); return;
      }
      // Merged form (#3341): in login mode with mail configured, a blank
      // password is a link request, not a sign-in attempt — like the old
      // magic-request submit it does not consult beforeSignIn (asking
      // for a link signs nothing in and clears nothing; the host's gate
      // applies when a password is presented or a code/link redeemed).
      const linkRequest = passwordMode !== "signup" && !fields.password && mailConfigured;
      if (!linkRequest && await beforeSignIn?.() === false) return;
      await withBusy(async () => {
        const session = await authedSession();
        if (passwordMode === "signup") {
          // Signup also rotates the account cookie. Reconcile an uncertain
          // result and ignore obsolete replies just as password login does.
          const returnTo = onMagicLinkRequest?.();
          const reply = await mutationApi(session, "/api/auth/password/signup", { email: passwordEmail, password: fields.password, sessionRevision: session.sessionRevision, ...(returnTo ? { returnTo } : {}) },
            reply => {
              if (reply?.status !== "check_email" || typeof reply.mailConfigured !== "boolean") throw new Error(uiText("signin.copy.025"));
              return true;
            });
          const restored = await accountClient.restore();
          if (!restored) return; // A newer restoration owns the account now.
          if (restored?.authenticated) {
            await onSignedIn?.(restored);
            setStatus(reply.mailConfigured ? uiText("signin.copy.026") : uiText("signin.copy.027"));
          } else {
            // Unauthenticated after a uniform 202 means the email was already
            // registered. Never promise a sign-in link when mail is off.
            setStatus(reply.mailConfigured
              ? uiText("signin.copy.028")
              : uiText("signin.copy.029"));
          }
          return;
        }
        if (linkRequest) { await requestEmailLink(session, passwordEmail); return; }
        const view = await authApi(session, "/api/auth/password/login", { email: passwordEmail, password: fields.password, sessionRevision: session.sessionRevision });
        await finish(view);
      }); return;
    }
    if (form.dataset.signinForm === "magic-code") {
      const code = [...form.querySelectorAll('input[name]')].find(input => input.name === "code")?.value?.trim() ?? "";
      if (!magicManualCode || !code || await beforeSignIn?.() === false) return;
      await withBusy(() => redeem(magicEmail, code)); return;
    }
    if (form.dataset.signinForm !== "reset-request") return;
    const email = [...form.querySelectorAll('input[name]')].find(input => input.name === "email")?.value?.trim() ?? "";
    resetEmail = email;
    await withBusy(async () => {
      const session = await authedSession();
      const returnTo = onMagicLinkRequest?.();
      const reply = await api(session, "/api/auth/password/reset/request", { email, ...(returnTo ? { returnTo } : {}) });
      if (reply?.status === "unavailable") { setStatus(reply.message || uiText("signin.copy.030"), true); return; }
      if (reply?.status !== "sent") throw new Error(uiText("signin.copy.031"));
      resetPhase = "sent";
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
    if (link.kind === "notice" || link.kind === "invalid") { params.delete("signin"); params.delete("verify"); }
    const rest = params.toString();
    const clean = window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash;
    try { window.history.replaceState(null, "", clean); } catch { /* URL cleanup may be unavailable */ }
    if (link.kind === "notice") {
      // Open sign-in for the emailed address; nothing is redeemed.
      passwordEmail = link.email; emailMethod = "password"; passwordMode = "login";
      render();
      return;
    }
    if (link.kind === "invalid") {
      const message = uiText("signin.copy.032");
      // Mounting hosts finish wiring their other sign-in controls this turn.
      await Promise.resolve();
      onMagicLinkFailure?.(message);
      setStatus(uiText("signin.copy.033", { fragmentA: message }), true);
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
    setStatus(uiText("signin.copy.034"));
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
    // B-1 (#3771): a refused submit names its field instead of silence.
    node.addEventListener("invalid", event => {
      const field = event.target;
      if (field?.name === "password" && passwordMode === "signup") setStatus(uiText("signin.copy.024"), true);
      else if (field?.name === "email") setStatus(uiText("signin.copy.036"), true);
      else if (field?.name) setStatus(uiText("signin.copy.037"), true);
    }, true);
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
    showWelcome() { return showView("welcome"); },
    showPassword(mode = "login") { return showView(mode === "signup" ? "password-signup" : "password-login"); },
    showMagic() {
      // #3341: there is no separate magic view to open — the merged
      // form is the email entry (a blank password asks for the link).
      // Kept as the hosts' "open email sign-in" entry point; coercion
      // for unconfigured mail is now simply what the form is.
      if (busy) return false;
      return showView("password-login");
    },
    openEmail(mode = "magic", panel) {
      if (busy) return false;
      if (panel && container && !panel.contains?.(container)) panel.prepend?.(container);
      if (panel) panel.hidden = false;
      // The mode argument is retained for host compatibility; both
      // modes open the one merged form (#3341).
      emailMethod = "password";
      render(); return true;
    },
    closeEmail() { return back(); },
    clear() {
      resetCode = ""; resetEmail = ""; resetPhase = "request"; magicPhase = "request"; magicEmail = ""; magicManualCode = false; pendingLink = null; pendingTerms = null; statusText = ""; passwordEmail = ""; passwordMode = "login"; emailMethod = "password"; busy = false;
      onBusyChange?.(false);
      render();
    },
    unmount() {
      container?.removeEventListener("click", onClick);
      container?.removeEventListener("submit", onSubmit);
      container = null;
    },
    mount(target) {
      container = target; mountedBefore = true; render(); bind(container);
      void loadSigninCapabilities();
      return consumeMagicLinkFromUrl();
    }
  };
}
