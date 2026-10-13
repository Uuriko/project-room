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

import { uiText } from "./strings.js";
import { formatSessionExpiry } from "./session-expiry.js";

export const JOIN_CODE_PATTERN = /^RM-[A-Z0-9]+$/;

// "/join/RM-ABC" or "/room/join/RM-ABC" (www door) -> the code, else null.
export function parseJoinCode(pathname) {
  const match = /^\/(?:room\/)?join\/([A-Za-z0-9_-]{1,64})\/?$/.exec(String(pathname ?? ""));
  const code = (match?.[1] ?? "").toUpperCase();
  return JOIN_CODE_PATTERN.test(code) ? code : null;
}

// A human is usually handed a bare code (or a whole link pasted from chat),
// not a tidy /join/<code> URL: accept the code, a full invite link, or a
// ?code= value, and normalize all of them to the canonical code.
export function parseInviteCodeInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const linkMatch = /\/(?:room\/)?join\/([A-Za-z0-9_-]{1,64})(?:[/?#\s]|$)/.exec(text);
  const candidate = (linkMatch?.[1] ?? text).toUpperCase();
  return JOIN_CODE_PATTERN.test(candidate) ? candidate : null;
}

// The code for this page load: the path wins; ?code= is the fallback so a
// link shared as /join?code=RM-… works too.
export function joinCodeFromLocation(locationLike) {
  const fromPath = parseJoinCode(locationLike?.pathname);
  if (fromPath) return fromPath;
  const params = new URLSearchParams(String(locationLike?.search ?? "").replace(/^\?/, ""));
  return parseInviteCodeInput(params.get("code"));
}

// Where the code-entry form sends the browser: the canonical code URL on
// the same door the visitor arrived through.
export function joinCodePath(code, pathname) {
  const door = String(pathname ?? "").startsWith("/room/") ? "/room" : "";
  return [door, "join", encodeURIComponent(code)].join("/");
}

// The room whose address this page was served at: /rooms/<id> (and its
// /room/ twin) serves this page in room mode (human-map §8.2 — the
// address is the join page).
export function joinRoomIdFromPath(pathname) {
  const match = /^\/(?:room\/)?rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(String(pathname ?? ""));
  return match?.[1] ?? null;
}

// The room named by a ?room= hand-off, shape-checked so the entry screen
// only ever echoes a plausible room id.
export function joinRoomHint(search) {
  const params = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  const room = params.get("room") ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(room) ? room : null;
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

// A next value is followed only when it is one relative path on this origin.
export function sameOriginRelativeNext(next, locationLike = globalThis.location) {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return null;
  const origin = String(locationLike?.origin ?? "");
  let resolved;
  try { resolved = new URL(next, origin || "http://localhost"); }
  catch { return null; }
  if (origin && resolved.origin !== origin) return null;
  if (resolved.username || resolved.password) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function joinNextHref(roomId, locationLike = globalThis.location) {
  const params = new URLSearchParams(String(locationLike?.search ?? "").replace(/^\?/, ""));
  return sameOriginRelativeNext(params.get("next"), locationLike) ?? roomEntryHref(roomId, locationLike);
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
  if ((code === "request_timeout" || code === "preview_timeout") && action === "join") {
    return { title: uiText("join.timedOut.title"), message: uiText("join.timedOut.message"), retry: true };
  }
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
      return { title: "Already joined", message: uiText("join.alreadyJoined"), retry: false };
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
  for (const id of ["join-loading", "join-enter", "join-consent", "join-success", "join-error"]) {
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

// Every apiFetch call is bounded by this deadline so a stalled network can
// never leave the page stuck — neither on the loader (#1608, preview) nor on
// the disabled "Joining…" button (#2979, redeem). Must stay below the join
// watchdog in join-watchdog.js (15s) so the module handles the timeout
// first when it is running. Exported for unit tests.
export const API_TIMEOUT_MS = 10_000;

export async function apiFetch(url, { method = "GET", data, timeoutMs = API_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        credentials: "same-origin",
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
        signal: controller.signal,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch {
      return { ok: false, status: 0, error: { code: controller.signal.aborted ? "request_timeout" : "network_error" } };
    }
    let body = null;
    try { body = await response.json(); } catch {
      if (controller.signal.aborted) return { ok: false, status: 0, error: { code: "request_timeout" } };
      /* non-JSON body */
    }
    if (!response.ok) return { ok: false, status: response.status, error: body?.error ?? { code: "request_failed" } };
    return { ok: true, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function renderConsent(preview) {
  const roomEl = $("join-room-title");
  if (roomEl) roomEl.textContent = preview.roomTitle || preview.roomId;
  const inviterEl = $("join-inviter");
  if (inviterEl) inviterEl.textContent = preview.inviterDisplayName ? `Invited by ${preview.inviterDisplayName}` : "";
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

// Retry starts a newer boot(); an older boot resolving late must not clobber
// it — without this, a timed-out first attempt firing after a retry would
// blank a screen the retry already rendered.
let bootSeq = 0;

// #3260: one requestId per invite code for this page session. If the join
// response is lost after the server committed, the retry replays the same
// redemption (duplicate: true) instead of dying on the burned code with
// the minted identity orphaned server-side.
let joinRequestId = null;
let joinRequestIdFor = null;
function requestIdForJoin(code) {
  if (joinRequestIdFor !== code) {
    joinRequestIdFor = code;
    joinRequestId = `join-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  }
  return joinRequestId;
}

// No code in the URL is not an error any more: a human holding a bare
// code gets the entry form (H-S3). The form navigates to the canonical
// /join/<code> URL, so the preview/consent flow below stays the only
// join path. Wired once-only, like the retry button.
function renderEnter() {
  const room = joinRoomIdFromPath(globalThis.location?.pathname) ?? joinRoomHint(globalThis.location?.search);
  const roomEl = $("join-enter-room");
  if (roomEl) {
    if (room) {
      const textEl = $("join-enter-room-text");
      if (textEl) textEl.textContent = `Room "${room}" — enter its invite code below, or if you're already a member:`;
      const openEl = $("join-enter-open");
      if (openEl) openEl.href = roomEntryHref(room);
      roomEl.hidden = false;
    } else roomEl.hidden = true;
  }
  const form = $("join-enter-form");
  if (form && !form.dataset.enterWired) {
    form.dataset.enterWired = "1";
    form.addEventListener("submit", event => {
      event.preventDefault();
      const statusEl = $("join-enter-status");
      const code = parseInviteCodeInput($("join-enter-code")?.value);
      if (!code) {
        if (statusEl) { statusEl.textContent = "That doesn't look like an invite code. Codes look like RM-XXXXXX — or paste the whole invite link."; statusEl.classList.add("visible"); }
        $("join-enter-code")?.focus();
        return;
      }
      globalThis.location.assign(joinCodePath(code, globalThis.location?.pathname));
    });
  }
  show("join-enter");
  $("join-enter-code")?.focus();
}

async function boot() {
  const seq = ++bootSeq;
  const code = joinCodeFromLocation(globalThis.location);
  // Register the retry button before any network call: when the preview
  // fetch fails, the user must still be able to retry (L-39). Once-only so
  // repeated retries don't stack duplicate boot() handlers.
  const retryEl = $("join-retry");
  if (retryEl && !retryEl.dataset.retryWired) {
    retryEl.dataset.retryWired = "1";
    retryEl.addEventListener("click", () => boot());
  }
  if (!code) {
    // #1608: a missing token is not a broken link — the entry form names
    // what's missing and gives the way forward, instead of a dead end.
    renderEnter();
    return;
  }
  const apiBase = serviceApiBase(globalThis.location?.pathname);
  // apiFetch bounds this with API_TIMEOUT_MS, so a stalled preview can
  // never leave the loader up forever (#1608).
  const preview = await apiFetch(`${apiBase}/agent-invites/preview?code=${encodeURIComponent(code)}`);
  if (seq !== bootSeq) return;
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
    const joined = await apiFetch(`${apiBase}/join`, { method: "POST", data: { displayName: name, inviteCode: code, requestId: requestIdForJoin(code) } });
    if (!joined.ok) {
      if (button) button.disabled = false;
      // A dead code stays dead: surface the reason instead of a retry loop.
      const mapped = joinErrorMessage({ status: joined.status, code: joined.error?.code, action: "join" });
      if (["invite_unavailable", "invite_revoked", "invite_expired", "invite_already_used", "invite_authority_changed"].includes(joined.error?.code)) fail(mapped);
      else if (statusEl) statusEl.textContent = mapped.message;
      return;
    }
    // roomToken is the honest name for the room-scoped credential; identitySecret is its deprecated alias.
    const { roomId, displayName, sessionExpiresAt } = joined.body ?? {};
    const identitySecret = joined.body?.roomToken ?? joined.body?.identitySecret;
    if (typeof identitySecret !== "string" || typeof roomId !== "string") {
      if (button) button.disabled = false;
      if (statusEl) statusEl.textContent = "The room answered oddly. Try again.";
      return;
    }
    show("join-success");
    const nameEl = $("join-success-name"), roomEl = $("join-success-room");
    if (nameEl) nameEl.textContent = displayName || name;
    if (roomEl) roomEl.textContent = preview.body.roomTitle || roomId;
    // The session cookie the response set expires at the server's genuine
    // session expiry — show the real date/time, never a guess.
    const expiryEl = $("join-session-expiry");
    const expiryText = formatSessionExpiry(sessionExpiresAt);
    if (expiryEl) {
      if (expiryText) { expiryEl.textContent = `This browser's session expires ${expiryText}.`; expiryEl.hidden = false; }
      else expiryEl.hidden = true;
    }
    const secretEl = $("join-secret");
    if (secretEl) secretEl.value = identitySecret;
    const openEl = $("join-open-room");
    if (openEl) openEl.href = joinNextHref(roomId);
  });

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
