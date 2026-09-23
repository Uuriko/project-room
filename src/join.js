// Public agent-invite join page: consent screen + self-serve join.
// The page is unauthenticated and stateless. It previews the invite
// (GET /api/agent-invites/preview), collects a display name, then mints
// the identity and redeems the invite in one call (POST /api/join).
// The one-time identity secret is shown once on the success screen —
// browser sessions are human-only by design, so the secret is the
// credential the new member saves.
//
// Pure helpers are exported for unit tests; the DOM boot below runs only
// in a browser.

export const JOIN_CODE_PATTERN = /^RM-[A-Z0-9]+$/;

// "/join/RM-ABC" or "/room/join/RM-ABC" (www door) -> the code, else null.
export function parseJoinCode(pathname) {
  const match = /^\/(?:room\/)?join\/([A-Za-z0-9_-]{1,64})\/?$/.exec(String(pathname ?? ""));
  const code = (match?.[1] ?? "").toUpperCase();
  return JOIN_CODE_PATTERN.test(code) ? code : null;
}

// API base for this page's fetches: the www door serves the room under /room.
export function serviceApiBase(pathname) {
  return String(pathname ?? "").startsWith("/room/") ? "/room/api" : "/api";
}

// The app entry a joined member opens next (same door they joined through).
export function roomEntryHref(roomId, locationLike = globalThis.location) {
  const origin = String(locationLike?.origin ?? "").replace(/\/$/, "");
  const door = String(locationLike?.pathname ?? "").startsWith("/room/") ? "/room" : "";
  return `${origin}${door}/#room/${encodeURIComponent(roomId)}`;
}

export const PERMISSION_LABELS = Object.freeze({
  steer: "Steer work (claim and direct tasks)",
  accept_work: "Accept work",
  complete_work: "Complete work",
  verify: "Verify others' work",
  write_external: "Post outside the room",
  manage_members: "Manage members",
  decide: "Room decisions",
  invite_member: "Invite members",
  manage_claims: "Manage claims",
});

export function permissionLabel(permission) {
  return PERMISSION_LABELS[permission] ?? String(permission).replaceAll("_", " ");
}

export function formatInviteExpiry(expiresAt, nowMs = Date.now()) {
  const ms = Number(expiresAt) - Number(nowMs);
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "in less than a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

// Maps a failed preview/join call to a message with a next step.
// Every branch names what happened and what to do — no dead ends.
export function joinErrorMessage({ status, code, action = "join" } = {}) {
  const again = "Check your connection and try again.";
  if (status === 0) return { title: "Couldn't reach the room", message: again, retry: true };
  switch (code) {
    case "invite_unavailable":
      return { title: "Invite not found", message: "This invite link is invalid, already used, or expired. Ask the inviter for a fresh link.", retry: false };
    case "invite_revoked":
      return { title: "Invite revoked", message: "The room owner revoked this invite. Ask them for a new link.", retry: false };
    case "invite_expired":
      return { title: "Invite expired", message: "This invite link expired. Ask the inviter for a fresh link.", retry: false };
    case "invite_already_used":
      return { title: "Invite already used", message: "This invite link was already redeemed. Each link works once — ask the inviter for a new one.", retry: false };
    case "invite_authority_changed":
      return { title: "Invite no longer valid", message: "The inviter's permissions changed, so this link stopped working. Ask them for a new invite.", retry: false };
    case "identity_already_linked":
      return { title: "Already joined", message: "This identity already joined the room. Reuse its saved connection instead of joining again.", retry: false };
    case "pilot_limit":
      return { title: "Room is full", message: "The room reached its member limit. Ask the room owner for help.", retry: false };
    case "invalid_invite_name":
    case "invalid_join":
      return { title: "Check the name", message: "Enter a name of 1–80 characters to join.", retry: true };
    case "rate_limited":
      return { title: "Too many tries", message: "Slow down and try again in a minute.", retry: true };
    default:
      break;
  }
  if (status === 404) return { title: "Invite not found", message: "This invite link is invalid, already used, or expired. Ask the inviter for a fresh link.", retry: false };
  if (status === 410) return { title: "Invite no longer valid", message: "This invite link expired or was revoked. Ask the inviter for a fresh link.", retry: false };
  if (status === 409) return { title: "Invite already used", message: "This invite link was already redeemed. Each link works once — ask the inviter for a new one.", retry: false };
  if (status === 422) return { title: action === "preview" ? "Invite link problem" : "Check the name", message: action === "preview" ? "This invite link doesn't look right. Ask the inviter for a fresh link." : "Enter a name of 1–80 characters to join.", retry: action !== "preview" };
  if (status === 429) return { title: "Too many tries", message: "Slow down and try again in a minute.", retry: true };
  if (status >= 500) return { title: "Room hiccup", message: `The room had trouble (${status}). ${again}`, retry: true };
  return { title: "Couldn't join", message: again, retry: true };
}

export function validateJoinName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || value.length > 80) return null;
  return value;
}

// --- Browser boot ---------------------------------------------------------

function $(id) { return document.getElementById(id); }

function show(section) {
  for (const id of ["join-loading", "join-consent", "join-success", "join-error"]) {
    const el = $(id);
    if (el) el.hidden = id !== section;
  }
}

function fail({ title, message, retry }) {
  show("join-error");
  const titleEl = $("join-error-title"), messageEl = $("join-error-message"), retryEl = $("join-retry");
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (retryEl) retryEl.hidden = !retry;
}

async function apiFetch(url, { method = "GET", data } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch {
    return { ok: false, status: 0, error: { code: "network_error" } };
  }
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON body */ }
  if (!response.ok) return { ok: false, status: response.status, error: body?.error ?? { code: "request_failed" } };
  return { ok: true, status: response.status, body };
}

function renderConsent(preview) {
  const roomEl = $("join-room-title");
  if (roomEl) roomEl.textContent = preview.roomTitle || preview.roomId;
  const profileEl = $("join-profile");
  if (profileEl) profileEl.textContent = preview.profile === "custom" ? "Custom access" : `Access: ${preview.profile}`;
  const list = $("join-permissions");
  if (list) {
    list.textContent = "";
    for (const permission of preview.permissions ?? []) {
      const item = document.createElement("li");
      item.textContent = permissionLabel(permission);
      list.appendChild(item);
    }
  }
  const expiryEl = $("join-expiry");
  if (expiryEl) expiryEl.textContent = `Invite expires ${formatInviteExpiry(preview.expiresAt)}`;
  show("join-consent");
  $("join-name")?.focus();
}

async function boot() {
  const code = parseJoinCode(globalThis.location?.pathname);
  if (!code) {
    fail({ title: "Invite link problem", message: "This invite link doesn't look right — it should end with /join/RM-…. Ask the inviter for a fresh link.", retry: false });
    return;
  }
  const apiBase = serviceApiBase(globalThis.location?.pathname);
  const preview = await apiFetch(`${apiBase}/agent-invites/preview?code=${encodeURIComponent(code)}`);
  if (!preview.ok) {
    fail(joinErrorMessage({ status: preview.status, code: preview.error?.code, action: "preview" }));
    return;
  }
  renderConsent(preview.body);

  const form = $("join-form");
  form?.addEventListener("submit", async event => {
    event.preventDefault();
    const name = validateJoinName($("join-name")?.value);
    const statusEl = $("join-status");
    if (!name) {
      if (statusEl) { statusEl.textContent = "Enter a name of 1–80 characters."; statusEl.classList.add("visible"); }
      $("join-name")?.focus();
      return;
    }
    const button = $("join-submit");
    if (button) button.disabled = true;
    if (statusEl) { statusEl.textContent = "Joining…"; statusEl.classList.add("visible"); }
    // One call mints the identity and redeems the invite atomically.
    // /room/api/* is rewritten to /api/* on the www door, so this works on both.
    const joined = await apiFetch(`${apiBase}/join`, { method: "POST", data: { displayName: name, inviteCode: code } });
    if (!joined.ok) {
      if (button) button.disabled = false;
      // A dead code stays dead: surface the reason instead of a retry loop.
      const mapped = joinErrorMessage({ status: joined.status, code: joined.error?.code, action: "join" });
      if (["invite_unavailable", "invite_revoked", "invite_expired", "invite_already_used", "invite_authority_changed"].includes(joined.error?.code)) fail(mapped);
      else if (statusEl) statusEl.textContent = mapped.message;
      return;
    }
    const { identitySecret, roomId, displayName } = joined.body ?? {};
    if (typeof identitySecret !== "string" || typeof roomId !== "string") {
      if (button) button.disabled = false;
      if (statusEl) statusEl.textContent = "The room answered oddly. Try again.";
      return;
    }
    show("join-success");
    const nameEl = $("join-success-name"), roomEl = $("join-success-room");
    if (nameEl) nameEl.textContent = displayName || name;
    if (roomEl) roomEl.textContent = preview.body.roomTitle || roomId;
    const secretEl = $("join-secret");
    if (secretEl) secretEl.value = identitySecret;
    const openEl = $("join-open-room");
    if (openEl) openEl.href = roomEntryHref(roomId);
  });

  $("join-retry")?.addEventListener("click", () => boot());
  $("join-copy-secret")?.addEventListener("click", async () => {
    const secretEl = $("join-secret");
    const statusEl = $("join-copy-status");
    try {
      const write = navigator.clipboard?.writeText?.(secretEl?.value ?? "");
      if (!write) throw new Error("clipboard");
      await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard")), 1500))]);
      if (statusEl) { statusEl.textContent = "Copied. Save it somewhere safe."; statusEl.classList.add("visible"); }
    } catch {
      secretEl?.select?.();
      if (statusEl) { statusEl.textContent = "Select the key and copy it manually."; statusEl.classList.add("visible"); }
    }
  });
}

if (typeof document !== "undefined" && typeof globalThis.location !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void boot(); });
  else void boot();
}
