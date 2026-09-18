// Account settings UI (slice 7, RC-2026-09-17-016).
//
// Renders the linked sign-in methods for the authenticated account and the
// controls to add, disable, enable, or remove them. The module is
// framework-free: `settingsHtml` produces escaped HTML strings (unit
// tested), and `createAccountSettingsUI` wires the strings to the server
// through an AccountClient with event delegation.
//
// Pure helpers exported for tests:
//   escapeHtml, methodLabel, methodDetail, formatMethodDate,
//   base64urlToBytes, bytesToBase64url, toRegistrationPublicKey,
//   toRegistrationResponse, settingsHtml

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

export function methodLabel(method) {
  if (method?.type === "oauth") {
    const provider = String(method.provider ?? "");
    if (provider.toLowerCase() === "github") return "GitHub";
    return provider ? `Continue with ${provider[0].toUpperCase()}${provider.slice(1)}` : "OAuth";
  }
  return {
    password: "Password",
    magic: "Email magic link",
    passkey: "Passkey",
    "recovery-code-set": "Recovery codes"
  }[method?.type] ?? String(method?.label ?? method?.type ?? "Sign-in method");
}

export function methodDetail(method) {
  if (!method) return "";
  if (method.email) return String(method.email);
  if (method.type === "oauth" && method.provider) return `Connected ${method.provider} account`;
  if (method.type === "recovery-code-set") return "Single-use backup codes";
  return "";
}

export function formatMethodDate(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return "never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// --- WebAuthn ceremony helpers (base64url <-> bytes) ---
export function base64urlToBytes(encoded) {
  const text = String(encoded ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/=]*$/.test(padded)) throw new Error("Invalid base64url value");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const decodeId = value => {
  try { return base64urlToBytes(value).buffer; }
  catch { return new TextEncoder().encode(String(value ?? "")).buffer; }
};

// Convert the server's registration options into the
// navigator.credentials.create({ publicKey }) shape.
export function toRegistrationPublicKey(options) {
  const source = options ?? {};
  return {
    ...source,
    challenge: decodeId(source.challenge),
    user: { ...(source.user ?? {}), id: decodeId(source.user?.id) },
    excludeCredentials: (source.excludeCredentials ?? []).map(credential => ({ ...credential, id: decodeId(credential?.id) }))
  };
}

// Convert a PublicKeyCredential into the register/finish request payload.
export function toRegistrationResponse(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
      attestationObject: bytesToBase64url(credential.response.attestationObject)
    }
  };
}

// --- HTML rendering ---
function methodRowHtml(method) {
  const id = escapeHtml(method.id);
  const detail = methodDetail(method);
  const state = method.disabled ? " <span class=\"settings-disabled\">disabled</span>" : "";
  const toggle = method.disabled
    ? `<button type="button" class="text-button" data-action="enable" data-id="${id}">Enable</button>`
    : `<button type="button" class="text-button" data-action="disable" data-id="${id}">Disable</button>`;
  return `<li class="settings-method" data-method-id="${id}">`
    + `<div><strong>${escapeHtml(methodLabel(method))}</strong>${state}`
    + (detail ? ` <span class="form-hint">${escapeHtml(detail)}</span>` : "") + "</div>"
    + `<div class="form-hint">Added ${escapeHtml(formatMethodDate(method.createdAt))} · Last used ${escapeHtml(formatMethodDate(method.lastUsedAt))}</div>`
    + `<div class="settings-method-actions">${toggle} <button type="button" class="text-button" data-action="remove" data-id="${id}">Remove</button></div>`
    + "</li>";
}

function passwordSectionHtml(methods) {
  const hasPassword = methods.some(method => method.type === "password");
  if (hasPassword) {
    return `<h3>Password</h3><form data-form="password-change" class="settings-form" autocomplete="off">`
      + `<label>Current password <input type="password" name="currentPassword" autocomplete="current-password" required></label>`
      + `<label>New password <input type="password" name="newPassword" autocomplete="new-password" required minlength="10"></label>`
      + `<button type="submit" class="button">Change password</button>`
      + `<p class="form-hint">Passwords are 10–256 characters.</p></form>`;
  }
  return `<h3>Password</h3><form data-form="password-set" class="settings-form" autocomplete="off">`
    + `<label>New password <input type="password" name="password" autocomplete="new-password" required minlength="10"></label>`
    + `<label>Confirm password <input type="password" name="confirmPassword" autocomplete="new-password" required minlength="10"></label>`
    + `<button type="submit" class="button">Set a password</button>`
    + `<p class="form-hint">Passwords are 10–256 characters.</p></form>`;
}

function oauthSectionHtml(providers) {
  const github = providers?.github?.configured
    ? `<a class="button" href="/api/auth/github/link/start">Connect GitHub</a><p class="form-hint">Links this GitHub account to your Project Room account.</p>`
    : `<p class="form-hint">GitHub sign-in isn\u2019t configured on this Room.</p>`;
  const google = providers?.google?.configured
    ? `<a class="button" href="/api/auth/google/start">Sign in with Google</a><p class="form-hint">This signs you into the account linked to that Google identity.</p>`
    : `<p class="form-hint">Google sign-in isn\u2019t configured on this Room.</p>`;
  return `<h3>Connected accounts</h3>${github}${google}`;
}

function passkeySectionHtml() {
  const supported = typeof globalThis.PublicKeyCredential !== "undefined";
  return `<h3>Passkeys</h3>`
    + (supported
      ? `<button type="button" class="button" data-action="passkey-add">Add a passkey</button><p class="form-hint">Uses this device\u2019s built-in authenticator.</p>`
      : `<p class="form-hint">This browser doesn\u2019t support passkeys.</p>`);
}

function recoverySectionHtml(methods) {
  const configured = methods.some(method => method.type === "recovery-code-set" && !method.disabled);
  return `<h3>Recovery codes</h3>`
    + (configured
      ? `<p class="form-hint">Recovery codes are set up. Generating a new set invalidates the old one.</p>`
      : `<p class="form-hint">Single-use backup codes for when your other methods are unavailable.</p>`)
    + `<button type="button" class="button" data-action="recovery-generate">${configured ? "Generate new codes" : "Generate recovery codes"}</button>`
    + `<div data-recovery-codes hidden></div>`;
}

function mailSectionHtml(providers) {
  return `<h3>Email sign-in</h3>`
    + (providers?.mail?.configured
      ? `<p class="form-hint">Email sign-in codes are available from the sign-in screen.</p>`
      : `<p class="form-hint">Email delivery isn\u2019t configured on this Room, so magic links are unavailable.</p>`);
}

export function settingsHtml({ methods = [], providers = null } = {}) {
  const rows = methods.map(methodRowHtml).join("");
  return `<div class="account-settings">`
    + `<p class="form-hint" role="status" data-settings-status hidden></p>`
    + `<h3>Linked sign-in methods</h3>`
    + (methods.length > 0
      ? `<ul class="settings-methods">${rows}</ul><p class="form-hint">Keep at least one active method \u2014 the last one can\u2019t be disabled or removed.</p>`
      : `<p class="form-hint">No sign-in methods are linked yet.</p>`)
    + `<h3>Add a sign-in method</h3>`
    + passwordSectionHtml(methods)
    + passkeySectionHtml()
    + oauthSectionHtml(providers)
    + recoverySectionHtml(methods)
    + mailSectionHtml(providers)
    + `</div>`;
}

// --- Wired behavior ---
export function createAccountSettingsUI({ accountClient, credentials = null } = {}) {
  if (!accountClient) throw new Error("accountClient is required");
  const webauthn = () => credentials ?? globalThis.navigator?.credentials ?? null;
  let container = null, state = { methods: [], providers: null };

  const status = message => {
    const node = container?.querySelector("[data-settings-status]");
    if (!node) return;
    node.hidden = !message;
    node.textContent = message ?? "";
  };

  const paint = () => {
    if (!container) return;
    container.innerHTML = settingsHtml(state);
  };

  const refresh = async () => {
    const session = accountClient.currentSession("managing sign-in methods", { authenticated: true });
    status("Loading sign-in methods\u2026");
    try {
      const data = await accountClient.request("/api/auth/methods", { session });
      state = { methods: Array.isArray(data.methods) ? data.methods : [], providers: data.providers ?? null };
      paint();
      status("");
    } catch (error) {
      paint();
      status(error?.message || "Could not load sign-in methods.");
    }
  };

  const mutate = async (path, id, confirmMessage) => {
    if (confirmMessage && !globalThis.confirm(confirmMessage)) return;
    const session = accountClient.currentSession("managing sign-in methods", { authenticated: true });
    status("Working\u2026");
    try {
      await accountClient.request(path, { method: "POST", session, data: { id } });
      await refresh();
    } catch (error) {
      status(error?.message || "That didn\u2019t work; try again.");
    }
  };

  const addPasskey = async () => {
    const creds = webauthn();
    if (!creds?.create) { status("This browser doesn\u2019t support passkeys."); return; }
    const session = accountClient.currentSession("registering a passkey", { authenticated: true });
    status("Waiting for your authenticator\u2026");
    try {
      const options = await accountClient.request("/api/auth/passkey/register/options", { method: "POST", session, data: {} });
      const credential = await creds.create({ publicKey: toRegistrationPublicKey(options) });
      await accountClient.request("/api/auth/passkey/register/finish", { method: "POST", session,
        data: { challengeId: options.challengeId, response: toRegistrationResponse(credential) } });
      await refresh();
      status("Passkey added.");
    } catch (error) {
      status(error?.name === "NotAllowedError" ? "Passkey registration was cancelled." : (error?.message || "Passkey registration failed."));
    }
  };

  const generateRecoveryCodes = async (hasExisting) => {
    if (hasExisting && !globalThis.confirm("Generating a new set invalidates your current recovery codes. Continue?")) return;
    const session = accountClient.currentSession("generating recovery codes", { authenticated: true });
    status("Generating\u2026");
    try {
      const data = await accountClient.request("/api/auth/recovery-codes/generate", { method: "POST", session, data: {} });
      await refresh();
      const slot = container?.querySelector("[data-recovery-codes]");
      if (slot) {
        slot.hidden = false;
        slot.innerHTML = `<p><strong>Save these now \u2014 they are shown once and each works a single time.</strong></p>`
          + `<ol>${(data.codes ?? []).map(code => `<li><code>${escapeHtml(code)}</code></li>`).join("")}</ol>`
          + `<p class="form-hint">${escapeHtml(data.warning ?? "")}</p>`;
      }
      status("");
    } catch (error) {
      status(error?.message || "Could not generate recovery codes.");
    }
  };

  const submitPasswordForm = async form => {
    const fields = Object.fromEntries(new FormData(form).entries());
    const session = accountClient.currentSession("updating the password", { authenticated: true });
    if (form.dataset.form === "password-set") {
      if (fields.password !== fields.confirmPassword) { status("The passwords don\u2019t match."); return; }
      status("Setting password\u2026");
      try {
        await accountClient.request("/api/auth/password/set", { method: "POST", session, data: { password: String(fields.password ?? "") } });
        form.reset(); await refresh(); status("Password set.");
      } catch (error) { status(error?.message || "Could not set the password."); }
      return;
    }
    status("Changing password\u2026");
    try {
      await accountClient.request("/api/auth/password/change", { method: "POST", session,
        data: { currentPassword: String(fields.currentPassword ?? ""), newPassword: String(fields.newPassword ?? "") } });
      form.reset(); await refresh(); status("Password changed.");
    } catch (error) { status(error?.message || "Could not change the password."); }
  };

  const onClick = event => {
    const button = event.target?.closest?.("[data-action]");
    if (!button || !container?.contains(button)) return;
    const { action, id } = button.dataset;
    if (action === "disable") return mutate("/api/auth/methods/disable", id);
    if (action === "enable") return mutate("/api/auth/methods/enable", id);
    if (action === "remove") return mutate("/api/auth/methods/remove", id, "Remove this sign-in method? You\u2019ll sign in with your remaining methods.");
    if (action === "passkey-add") return addPasskey();
    if (action === "recovery-generate") {
      return generateRecoveryCodes(state.methods.some(method => method.type === "recovery-code-set" && !method.disabled));
    }
  };

  const onSubmit = event => {
    const form = event.target?.closest?.("form[data-form]");
    if (!form || !container?.contains(form)) return;
    event.preventDefault();
    submitPasswordForm(form);
  };

  const mount = next => {
    if (container) { container.removeEventListener("click", onClick); container.removeEventListener("submit", onSubmit); }
    container = next;
    container.addEventListener("click", onClick);
    container.addEventListener("submit", onSubmit);
    return refresh();
  };

  return { mount, refresh, html: () => settingsHtml(state) };
}
