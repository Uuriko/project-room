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

// Appearance follows the room palette. Dark is the default so a fresh
// session matches the rest of the product. "system" tracks the OS only
// after an explicit choice.
const THEME_KEY = "project-room-theme";
let systemQuery = null;

export function readThemePreference() {
  try {
    const value = globalThis.localStorage?.getItem(THEME_KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

function resolvedTheme(preference) {
  if (preference === "light") return "light";
  if (preference === "system") {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  }
  return "dark";
}

export function applyTheme(preference) {
  const mode = resolvedTheme(preference);
  const root = globalThis.document?.documentElement;
  if (!root) return mode;
  if (mode === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
  if (root.style) root.style.colorScheme = mode;
  return mode;
}

function onSystemTheme() {
  if (readThemePreference() === "system") applyTheme("system");
}

function bindSystemTheme(preference) {
  systemQuery?.removeEventListener?.("change", onSystemTheme);
  systemQuery = null;
  if (preference !== "system" || !globalThis.matchMedia) return;
  systemQuery = globalThis.matchMedia("(prefers-color-scheme: light)");
  systemQuery.addEventListener?.("change", onSystemTheme);
}

export function applyStoredTheme() {
  const preference = readThemePreference();
  bindSystemTheme(preference);
  return applyTheme(preference);
}

export function storeTheme(preference) {
  const next = preference === "light" || preference === "system" ? preference : "dark";
  try { globalThis.localStorage?.setItem(THEME_KEY, next); } catch { /* private mode */ }
  bindSystemTheme(next);
  return applyTheme(next);
}

// Room Settings is a flat list in index.html (that file is owned by another
// PR). Group the existing controls into the same sections as account settings
// without removing them, so Results-only mode and the settings opener still
// find each panel by id.
export function organizeRoomSettings(dialog, doc = globalThis.document) {
  if (!dialog || dialog.dataset?.settingsGrouped === "true" || !doc?.createElement) return;
  const groups = [
    ["Room", ["create-room-details", "room-about"], "The room’s name, purpose, and instructions."],
    ["Agents & connections", ["room-permissions", "room-tools"], "Who can assign agents, and the room’s suggestions."],
    ["Billing / plan", ["usage-panel", "spend-panel"], "Usage is what agents reported. Spend is this room’s allowance, not a subscription."],
    ["Advanced", ["advanced-room-tools", "record-panel", "room-health"], "Landing, referrals, history, and owner-only health."]
  ];
  const results = dialog.querySelector("#results-panel");
  for (const [label, ids, hint] of groups) {
    const nodes = ids.map(id => dialog.querySelector(`#${id}`)).filter(Boolean);
    if (!nodes.length) continue;
    const section = doc.createElement("section");
    section.className = "settings-group";
    const titleId = `settings-group-${label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`;
    section.setAttribute("aria-labelledby", titleId);
    const heading = doc.createElement("h3");
    heading.className = "settings-group-title";
    heading.id = titleId;
    heading.textContent = label;
    const note = doc.createElement("p");
    note.className = "form-hint";
    note.textContent = hint;
    section.append(heading, note, ...nodes);
    dialog.insertBefore(section, results);
  }
  dialog.dataset.settingsGrouped = "true";
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
    ? `<a class="button" href="/api/auth/google/link/start">Connect Google</a><p class="form-hint">Links this Google account to your Project Room account.</p>`
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

// QA2 finding P2-11. Colors are the design tokens in src/design-tokens.js
// (--red, --panel), already applied as CSS variables. No new stylesheet.
const DESTRUCTIVE_BUTTON = "color:var(--red);background:var(--panel);border:1px solid var(--red)";

export const ACCOUNT_DELETED_MESSAGE = "Your account was deleted.";

export function accountDeletedLandingMessage(search = "") {
  const params = new URLSearchParams(String(search).replace(/^\?/, ""));
  return params.get("account-deleted") === "1" ? ACCOUNT_DELETED_MESSAGE : "";
}

function deletionSectionHtml() {
  return `<h3>Delete account</h3>`
    + `<p class="form-hint">Permanently delete this account. Personal rooms you solely own are archived and their messages and files are purged. A shared room needs another owner first.</p>`
    + `<button type="button" class="button" data-action="delete-account" style="${DESTRUCTIVE_BUTTON}">Delete account</button>`
    + `<dialog data-deletion-dialog aria-labelledby="delete-account-title" aria-describedby="delete-account-summary">`
    + `<h3 id="delete-account-title">Delete account</h3>`
    + `<div id="delete-account-summary" class="form-hint" data-deletion-summary style="white-space:pre-wrap">Loading what deletion will remove…</div>`
    + `<div data-deletion-blocked hidden></div>`
    + `<form data-form="delete-account" class="settings-form" hidden>`
    + `<label>Type your account email to confirm <input type="email" name="confirmEmail" autocomplete="off" spellcheck="false" required></label>`
    + `<button type="submit" class="button" disabled style="${DESTRUCTIVE_BUTTON}">Delete account</button>`
    + `</form>`
    + `<button type="button" class="button" data-action="delete-account-cancel">Cancel</button>`
    + `</dialog>`;
}

function mailSectionHtml(providers) {
  return `<h3>Email sign-in</h3>`
    + (providers?.mail?.configured
      ? `<p class="form-hint">Email sign-in codes are available from the sign-in screen.</p>`
      : `<p class="form-hint">Email delivery isn\u2019t configured on this Room, so magic links are unavailable.</p>`);
}

function section(id, title, body) {
  return `<section class="settings-section" aria-labelledby="${id}"><h3 id="${id}">${title}</h3>${body}</section>`;
}

function appearanceHtml() {
  const selected = readThemePreference();
  const option = (value, label) => `<label><input type="radio" name="theme" value="${value}"${selected === value ? " checked" : ""}> ${label}</label>`;
  return `<fieldset class="settings-appearance"><legend>Appearance</legend>${option("dark", "Dark")}${option("light", "Light")}${option("system", "Match system")}</fieldset>`;
}

function profileSectionHtml(methods) {
  const emails = [...new Set(methods.map(method => method.email).filter(Boolean))];
  const identity = emails.length
    ? `<ul class="settings-identity">${emails.map(email => `<li>${escapeHtml(email)}</li>`).join("")}</ul>`
    : `<p class="settings-empty">No email on this account yet. Add a sign-in method under Advanced.</p>`;
  return section("settings-profile-title", "Profile", identity + appearanceHtml());
}

function emailVerificationHtml(emailVerification, providers) {
  const unverified = emailVerification?.status === "unverified";
  const reset = emailVerification?.passwordResetRequired === true;
  const mailOff = providers?.mail?.configured === false;
  const verify = unverified
    ? `<form data-form="email-verify" class="settings-form" autocomplete="off">`
      + `<p class="form-hint">${mailOff ? "Email delivery isn’t configured, so this account stays unverified." : "Enter the 6-digit code from your email to verify this address."}</p>`
      + (mailOff ? "" : `<label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" required minlength="6" maxlength="6"></label><button type="submit" class="button">Verify email</button>`)
      + `</form>`
    : "";
  const banner = reset
    ? `<p class="form-hint" role="status">Choose a new password. The previous password on this account is no longer active.</p>`
    : "";
  return verify + banner;
}

export function settingsHtml({ methods = [], providers = null, emailVerification = null } = {}) {
  const rows = methods.map(methodRowHtml).join("");
  const methodsBody = methods.length > 0
    ? `<ul class="settings-methods">${rows}</ul><p class="form-hint">Keep at least one active method \u2014 the last one can\u2019t be disabled or removed.</p>`
    : `<p class="settings-empty">No sign-in methods are linked yet.</p>`;
  return `<div class="account-settings">`
    + `<p class="form-hint" role="status" data-settings-status hidden></p>`
    + emailVerificationHtml(emailVerification, providers)
    + profileSectionHtml(methods)
    + section("settings-notifications-title", "Notifications",
      `<p class="settings-empty">Nothing to configure here yet. Room notifications stay in Catch up.</p>`)
    + section("settings-agents-title", "Agents &amp; connections", oauthSectionHtml(providers) + mailSectionHtml(providers))
    + section("settings-billing-title", "Billing / plan",
      `<p class="settings-empty">No plan is billed from account settings. A room\u2019s spend allowance is under Settings, in Billing / plan.</p>`)
    + section("settings-advanced-title", "Advanced",
      `<h3>Linked sign-in methods</h3>${methodsBody}`
      + passwordSectionHtml(methods)
      + passkeySectionHtml()
      + recoverySectionHtml(methods)
      + deletionSectionHtml())
    + `</div>`;
}

// --- Wired behavior ---
export function createAccountSettingsUI({ accountClient, credentials = null, onAccountDeleted = null } = {}) {
  if (!accountClient) throw new Error("accountClient is required");
  const webauthn = () => credentials ?? globalThis.navigator?.credentials ?? null;
  let container = null, state = { methods: [], providers: null }, deletionToken = null;

  const accountEmails = () => [...new Set(state.methods
    .map(method => typeof method.email === "string" ? method.email.trim().toLowerCase() : "")
    .filter(Boolean))];

  const deletionDialog = () => container?.querySelector("[data-deletion-dialog]") ?? null;

  const syncDeleteConfirm = () => {
    const form = container?.querySelector('form[data-form="delete-account"]');
    const input = form?.elements?.confirmEmail;
    const submit = form?.querySelector('button[type="submit"]');
    if (!input || !submit) return;
    const typed = input.value.trim().toLowerCase();
    submit.disabled = !deletionToken || !accountEmails().includes(typed);
  };

  const focusables = dialog => [...dialog.querySelectorAll("button, input, a[href], select, textarea")]
    .filter(element => !element.disabled && !element.closest("[hidden]") && element.getClientRects().length);

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
    if (form.dataset.form === "email-verify") {
      status("Checking code…");
      try {
        await accountClient.request("/api/auth/email/verify", { method: "POST", session, data: { code: String(fields.code ?? "").trim() } });
        form.reset(); await refresh(); status("Email verified.");
      } catch (error) { status(error?.message || "Could not verify that code."); }
      return;
    }
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

  const openDeletion = async () => {
    const dialog = deletionDialog();
    if (!dialog) return;
    deletionToken = null;
    const summary = dialog.querySelector("[data-deletion-summary]");
    const blocked = dialog.querySelector("[data-deletion-blocked]");
    const form = dialog.querySelector('form[data-form="delete-account"]');
    summary.textContent = "Loading what deletion will remove…";
    blocked.hidden = true;
    blocked.replaceChildren();
    form.hidden = true;
    syncDeleteConfirm();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("[data-action='delete-account-cancel']")?.focus();
    try {
      const session = accountClient.currentSession("planning account deletion", { authenticated: true });
      const planned = await accountClient.request("/api/account/deletion/plan", { session });
      deletionToken = typeof planned.confirmationToken === "string" ? planned.confirmationToken : null;
      summary.textContent = planned.summary?.text || "Review the deletion plan before continuing.";
      const rooms = planned.plan?.rooms?.blocked ?? [];
      const emails = accountEmails();
      if (rooms.length) {
        blocked.hidden = false;
        const doc = globalThis.document;
        blocked.replaceChildren(...rooms.map(room => {
          const item = doc.createElement("p");
          item.textContent = `Transfer ownership before deleting: ${room.title || room.id} (${room.id}).`;
          return item;
        }));
        form.hidden = true;
      } else if (!emails.length) {
        blocked.hidden = false;
        const item = globalThis.document.createElement("p");
        item.textContent = "Add an email sign-in method before deleting this account. Deletion asks you to type that email.";
        blocked.append(item);
        form.hidden = true;
      } else {
        form.hidden = false;
        form.reset();
        syncDeleteConfirm();
        form.elements.confirmEmail?.focus();
      }
    } catch (error) {
      summary.textContent = error?.message || "Could not load the deletion plan.";
    }
  };

  const submitDeletion = async form => {
    const typed = String(new FormData(form).get("confirmEmail") ?? "").trim().toLowerCase();
    if (!deletionToken || !accountEmails().includes(typed)) { syncDeleteConfirm(); return; }
    const session = accountClient.currentSession("deleting this account", { authenticated: true });
    status("Deleting account…");
    try {
      await accountClient.request("/api/account/delete", { method: "POST", session, data: { confirmationToken: deletionToken } });
      deletionToken = null;
      if (onAccountDeleted) await onAccountDeleted();
      else globalThis.location?.assign("/?account-deleted=1");
    } catch (error) {
      const summary = deletionDialog()?.querySelector("[data-deletion-summary]");
      if (summary) summary.textContent = error?.message || "Could not delete the account.";
      status(error?.message || "Could not delete the account.");
    }
  };

  const onClick = event => {
    const button = event.target?.closest?.("[data-action]");
    if (!button || !container?.contains(button)) return;
    const { action, id } = button.dataset;
    if (action === "delete-account") return openDeletion();
    if (action === "delete-account-cancel") { deletionDialog()?.close(); return; }
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
    if (form.dataset.form === "delete-account") return submitDeletion(form);
    submitPasswordForm(form);
  };

  const onInput = event => {
    if (event.target?.name === "confirmEmail" && container?.contains(event.target)) syncDeleteConfirm();
  };

  const onKeyDown = event => {
    const dialog = deletionDialog();
    if (!dialog?.open || event.key !== "Tab") return;
    const controls = focusables(dialog);
    const first = controls[0], last = controls.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  const onChange = event => {
    const input = event.target;
    if (!input || input.name !== "theme" || !container?.contains(input)) return;
    storeTheme(input.value);
  };

  const mount = next => {
    if (container) {
      container.removeEventListener("click", onClick);
      container.removeEventListener("submit", onSubmit);
      container.removeEventListener("change", onChange);
      container.removeEventListener("input", onInput);
      container.removeEventListener("keydown", onKeyDown);
    }
    container = next;
    container.addEventListener("click", onClick);
    container.addEventListener("submit", onSubmit);
    container.addEventListener("change", onChange);
    container.addEventListener("input", onInput);
    container.addEventListener("keydown", onKeyDown);
    return refresh();
  };

  return { mount, refresh, html: () => settingsHtml(state) };
}
