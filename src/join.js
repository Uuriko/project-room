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
  // M-03: the join POST's own timeout (status 0, like a network failure)
  // names what happened — the room answered the preview, the redeem stalled.
  if (code === "join_timeout") return { title: "The join timed out", message: "Check your connection and try again.", retry: true };
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

// M-03 (mobile invite-redeem): the join POST was unbounded — a stalled
// network left "Joining…" on screen forever with the submit button disabled
// and no watchdog covering that state (the preview fetch is bounded at
// PREVIEW_TIMEOUT_MS; the loader watchdog only watches the loading card).
// 15s matches the page watchdog's ceiling.
export const JOIN_TIMEOUT_MS = 15_000;

// M-03: the Enter-key double-submit guard. Disabling the submit button does
// not stop an Enter-key submit on the name input from re-firing the handler
// while the first POST is still in flight; the second redeem dies with
// invite_already_used. tryBegin() returns false while a submit is in flight.
export function createSubmitGuard() {
  let inFlight = false;
  return {
    tryBegin() { if (inFlight) return false; inFlight = true; return true; },
    release() { inFlight = false; },
  };
}

// M-03: the consent screen auto-focused the name input on every device. On
// touch, the soft keyboard pops up over the invite details (room, inviter,
// permissions, expiry) before the human reads them — focus only where a
// hardware keyboard exists.
export function shouldAutofocusName(matchMediaFn = globalThis.matchMedia) {
  try { return Boolean(matchMediaFn?.("(pointer: fine)")?.matches); }
  catch { return false; }
}

// M-03: a bare invite code ("RM-XXXX" texted without the link) was a dead
// end — /join with no code said "ask a room owner for an invite link" with
// nowhere to paste the code. The no-invite error screen carries a code
// entry form that navigates here.
export function codeEntryHref(code, locationLike = globalThis.location) {
  const upper = String(code ?? "").trim().toUpperCase();
  if (!JOIN_CODE_PATTERN.test(upper)) return null;
  const origin = String(locationLike?.origin ?? "").replace(/\/$/, "");
  const door = String(locationLike?.pathname ?? "").startsWith("/room/") ? "/room" : "";
  return `${origin}${door}/join/${upper}`;
}

function show(section) {
  for (const id of ["join-loading", "join-consent", "join-success", "join-error"]) {
    const el = $(id);
    if (el) el.hidden = id !== section;
  }
}

function fail({ title, message, retry, codeEntry = false }) {
  show("join-error");
  const titleEl = $("join-error-title"), messageEl = $("join-error-message"), retryEl = $("join-retry");
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (retryEl) retryEl.hidden = !retry;
  // M-03: the no-invite screens (missing or malformed code in the address
  // bar) offer the code entry — everywhere else the link is the problem,
  // not a missing code.
  const codeForm = $("join-code-form");
  if (codeForm) codeForm.hidden = !codeEntry;
}

export async function apiFetch(url, { method = "GET", data, timeoutMs = 0, fetchFn } = {}) {
  let response;
  try {
    const pending = (fetchFn ?? ((...args) => fetch(...args)))(url, {
      method,
      credentials: "same-origin",
      headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    response = timeoutMs > 0
      ? await Promise.race([
          pending,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
        ])
      : await pending;
  } catch (err) {
    const code = err instanceof Error && err.message === "timeout" ? "join_timeout" : "network_error";
    return { ok: false, status: 0, error: { code } };
  }
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON body */ }
  if (!response.ok) return { ok: false, status: response.status, error: body?.error ?? { code: "request_failed" } };
  return { ok: true, status: response.status, body };
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
  // M-03: touch keyboards stay down until the human taps the field, so the
  // consent details stay readable. See shouldAutofocusName.
  if (shouldAutofocusName()) $("join-name")?.focus();
}

// The preview fetch has no server-side deadline; bound it so a stalled
// network can never leave the loader up forever (#1608). Must stay below
// the inline watchdog in join.html (15s) so the module handles the timeout
// first when it is running.
const PREVIEW_TIMEOUT_MS = 10_000;

// Retry starts a newer boot(); an older boot resolving late must not clobber
// it — without this, a timed-out first attempt firing after a retry would
// blank a screen the retry already rendered.
let bootSeq = 0;

async function boot() {
  const seq = ++bootSeq;
  const code = parseJoinCode(globalThis.location?.pathname);
  // Register the retry button before any network call: when the preview
  // fetch fails, the user must still be able to retry (L-39). Once-only so
  // repeated retries don't stack duplicate boot() handlers.
  const retryEl = $("join-retry");
  if (retryEl && !retryEl.dataset.retryWired) {
    retryEl.dataset.retryWired = "1";
    retryEl.addEventListener("click", () => boot());
  }
  // M-03: the bare-code entry (a code texted without the link). Once-only so
  // repeated boots don't stack duplicate handlers. Navigates to /join/<CODE>
  // through the same door the page was served from.
  const codeForm = $("join-code-form");
  if (codeForm && !codeForm.dataset.codeWired) {
    codeForm.dataset.codeWired = "1";
    codeForm.addEventListener("submit", event => {
      event.preventDefault();
      const input = $("join-code-input");
      const statusEl = $("join-code-status");
      const href = codeEntryHref(input?.value);
      if (!href) {
        if (statusEl) { statusEl.textContent = "That doesn't look like an invite code — codes look like RM-XXXX."; statusEl.classList.add("visible"); }
        input?.focus();
        return;
      }
      globalThis.location.href = href;
    });
  }
  if (!code) {
    // #1608: a missing token is not a broken link — name what's missing and
    // the two ways forward, instead of leaving the loader up. M-03 adds the
    // code entry: a bare "RM-XXXX" texted without the link gets a redeem
    // path instead of a dead end.
    fail({ title: "No invite found", message: "Ask a room owner for an invite link, or sign in and request access.", retry: false, codeEntry: true });
    return;
  }
  const apiBase = serviceApiBase(globalThis.location?.pathname);
  const preview = await Promise.race([
    apiFetch(`${apiBase}/agent-invites/preview?code=${encodeURIComponent(code)}`),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, status: 0, error: { code: "preview_timeout" } }), PREVIEW_TIMEOUT_MS)),
  ]);
  if (seq !== bootSeq) return;
  if (!preview.ok) {
    const mapped = joinErrorMessage({ status: preview.status, code: preview.error?.code, action: "preview" });
    // M-03: when the link itself is the problem (bad/used/expired code), the
    // code entry gives the human a redeem path for a fresh code.
    const linkShapeProblem = ["invite_unavailable", "invite_revoked", "invite_expired", "invite_already_used"].includes(preview.error?.code)
      || preview.status === 422 || preview.status === 404 || preview.status === 410;
    fail({ ...mapped, codeEntry: linkShapeProblem });
    return;
  }
  renderConsent(preview.body);

  const form = $("join-form");
  // M-03: button.disabled does not stop an Enter-key submit on the name
  // input — the guard drops the re-fire while a redeem is in flight.
  const submitGuard = createSubmitGuard();
  form?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!submitGuard.tryBegin()) return;
    try {
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
      // M-03: bounded — a stalled POST used to hang on "Joining…" forever
      // with the button disabled. On timeout the button re-enables and the
      // status line offers the retry (joinErrorMessage maps join_timeout).
      const joined = await apiFetch(`${apiBase}/join`, { method: "POST", data: { displayName: name, inviteCode: code }, timeoutMs: JOIN_TIMEOUT_MS });
      if (!joined.ok) {
        if (button) button.disabled = false;
        // A dead code stays dead: surface the reason instead of a retry loop.
        // M-03: the code entry stays available — a replacement code often
        // arrives as bare text, and this is where the human pastes it.
        const mapped = joinErrorMessage({ status: joined.status, code: joined.error?.code, action: "join" });
        if (["invite_unavailable", "invite_revoked", "invite_expired", "invite_already_used", "invite_authority_changed"].includes(joined.error?.code)) fail({ ...mapped, codeEntry: true });
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
    } finally {
      submitGuard.release();
    }
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
