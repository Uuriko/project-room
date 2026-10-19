import { validId } from "../src/events.js";
import { parseShareInviteCode } from "../src/share-invite-code.js";

// Slice 3 (RC-2026-09-17-012) — mail sender seam for magic-link sign-in.
//
// The mailer is deliberately a seam, not an SMTP client: the Room ships
// unconfigured by default and says so honestly (mail_not_configured)
// instead of pretending a code was sent. Wiring a real provider is a
// deployment concern and must come from the operator's own credentials —
// this module never invents SMTP credentials or touches the network.
//
// The plaintext code is handed only to the injected `send` function (the
// mail provider's job); the store hashes codes at rest (slice 1). Codes
// are never returned in API responses.

export const MAIL_NOT_CONFIGURED_MESSAGE =
  "Email delivery is not configured on this Room; magic links are disabled until an operator configures a mail provider.";

export function magicLinkUnavailable() {
  return {
    status: "unavailable",
    reason: "mail_not_configured",
    message: MAIL_NOT_CONFIGURED_MESSAGE
  };
}

// Operator-facing description of a failed send, safe for logs: the provider's
// status and error text (e.g. "domain is not verified") with any email address,
// link or long token removed. Never carries the recipient, code or link.
export function describeMailFailure(error) {
  const text = String(error?.message ?? error ?? "unknown error")
    .replace(/[^\s<>"']+@[^\s<>"']+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
    .replace(/\s+/g, " ").trim();
  return text.slice(0, 240);
}

// Run one mail send; a failure is logged (redacted) and reported as false so
// callers can answer truthfully. Never throws.
export async function attemptMailDelivery(fn, kind, warn = console.warn) {
  try { await fn(); return true; }
  catch (error) { warn(`mail delivery failed (${kind}): ${describeMailFailure(error)}`); return false; }
}

// A provider refusal is permanent for this exact send: the provider rejected
// the request itself (a recipient domain it will not serve, a suppressed
// address) with a client-class status, so retrying the identical send can
// never succeed. A send implementation may mark a refusal directly with
// `recipientRefused: true` or code "mail_recipient_refused"; otherwise the
// provider's HTTP status decides via `providerStatus` (the Resend transport
// attaches it). NOT refusals: network errors and provider 5xx (an outage),
// 408/429 (timeout / throttling — the send may succeed later), and 401 (the
// operator's credential is broken, a platform-wide failure that must stay
// loud rather than be absorbed one request at a time).
export function isMailRecipientRefusal(error) {
  if (!error || typeof error !== "object") return false;
  if (error.recipientRefused === true || error.code === "mail_recipient_refused") return true;
  const status = error.providerStatus;
  return Number.isInteger(status) && status >= 400 && status < 500
    && status !== 401 && status !== 408 && status !== 429;
}

// Run one auth-request mail send (magic sign-in, password reset). These
// endpoints answer indistinguishably whether or not the address turns out
// deliverable, so a provider refusal is logged (redacted) and absorbed —
// the caller answers exactly as for a delivered send (#3529). Any other
// failure rethrows, so a transient provider failure still surfaces as a
// retryable error instead of being masked as "sent".
export async function attemptAuthMailDelivery(fn, kind, warn = console.warn) {
  try { await fn(); return true; }
  catch (error) {
    if (!isMailRecipientRefusal(error)) throw error;
    warn(`mail delivery refused (${kind}): ${describeMailFailure(error)}`);
    return false;
  }
}

// createMagicLinkMailer({ send, baseUrl }) -> mailer.
//
// send: async ({ to, code, expiresAt, baseUrl }) => void. When omitted the
// mailer reports mail_not_configured instead of delivering anything —
// honest non-delivery, never a fake send.
export function createMagicLinkMailer({ send = null, baseUrl = null } = {}) {
  const configured = typeof send === "function";
  return Object.freeze({
    isConfigured: () => configured,
    sendPasswordResetNotice: async ({ to } = {}) => {
      if (!configured) return { delivered: false, reason: "mail_not_configured" };
      if (typeof to !== "string" || !to) throw new Error("A notification recipient is required");
      await send({ to, purpose: "password-reset-complete", baseUrl });
      return { delivered: true };
    },
    sendMagicLink: async ({ to, code, expiresAt, returnTo, purpose = "signin" } = {}) => {
      if (!configured) return { delivered: false, reason: "mail_not_configured" };
      if (typeof to !== "string" || to.length === 0) throw new Error("sendMagicLink requires a recipient");
      if (purpose !== "signup-notice" && (typeof code !== "string" || code.length === 0)) {
        throw new Error("sendMagicLink requires a recipient and a code");
      }
      if (returnTo !== undefined && validateMagicReturnTo(returnTo) === null) throw new Error("Invalid magic-link return target");
      const link = buildMagicLinkUrl({ baseUrl, to, code, returnTo, purpose });
      await send({ to, code, expiresAt, baseUrl, ...(purpose === "signin" ? {} : { purpose }), ...(link ? { link } : {}), ...(returnTo === undefined ? {} : { returnTo }) });
      return { delivered: true };
    }
  });
}

// Keep email continuations inside the configured app. Invitation fragments
// carry membership capabilities; they never choose the origin or application path.
export function validateMagicReturnTo(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/")
    || value.startsWith("//") || /[\\\s\x00-\x1f\x7f]/.test(value)) return null;
  const url = new URL(value, "https://return.invalid");
  if (url.origin !== "https://return.invalid" || url.pathname !== "/" || !/^\/(?:[?#]|$)/.test(value)) return null;
  const seen = new Set();
  for (const [name, entry] of url.searchParams) {
    if (seen.has(name) || !(name === "room" && validId(entry) || name === "account" && entry === "1")) return null;
    seen.add(name);
  }
  if (url.hash) {
    const invitationPattern = "[A-Za-z0-9_-]{43}";
    const match = new RegExp(`^#(?:invite/${invitationPattern}|join/([^/]+)(?:/(work|message)/([^/]+))?)$`).exec(url.hash);
    if (!match && !(url.hash.startsWith("#code/") && parseShareInviteCode(url.hash.slice(6)))) return null;
    if (match?.[1] && !(new RegExp(`^${invitationPattern}$`).test(match[1]) || parseShareInviteCode(match[1]))) return null;
    if (match?.[3] && !validId(match[3])) return null;
  }
  return value;
}

// The `room` parameter of a return target is a landing hint the issuing
// side vouches for: it tells the app which room to open after sign-in.
// validateMagicReturnTo checks only its shape, so without this step a
// crafted sign-in request can name ANY room and the emailed link will
// land the recipient there — including rooms they do not belong to,
// with an invitation fragment riding along. Issuance therefore keeps
// the hint only for rooms the account behind the email actually
// belongs to (isRoomMember, resolved by the caller from the
// member_accounts binding) and silently drops it otherwise: the
// request answers exactly as before and the link simply lands on the
// app root, because any visible difference would turn the endpoint
// into an account/membership oracle. The `account` parameter and the
// fragment continuations (#invite/, #join/, #code/ — capabilities of
// their own) are preserved verbatim. A target that fails
// validateMagicReturnTo passes through untouched: shape refusal stays
// the caller's 422, exactly as before.
export function magicReturnToForAccount(returnTo, isRoomMember) {
  if (typeof returnTo !== "string" || typeof isRoomMember !== "function") return returnTo;
  if (validateMagicReturnTo(returnTo) === null) return returnTo;
  const url = new URL(returnTo, "https://return.invalid");
  const roomId = url.searchParams.get("room");
  if (!roomId || isRoomMember(roomId)) return returnTo;
  url.searchParams.delete("room");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildMagicLinkUrl({ baseUrl, to, code, returnTo, purpose = "signin" } = {}) {
  if (!["signin", "password-reset", "email-verify", "signup-notice"].includes(purpose)) throw new Error("Invalid email link purpose");
  if (returnTo !== undefined && validateMagicReturnTo(returnTo) === null) throw new Error("Invalid magic-link return target");
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  const target = new URL(returnTo ?? "/", "https://return.invalid");
  const trusted = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  trusted.search = target.search;
  trusted.hash = target.hash;
  if (purpose === "signup-notice") trusted.searchParams.set("signin", "1");
  else if (purpose === "email-verify") trusted.searchParams.set("verify", "email");
  else trusted.searchParams.set(purpose === "password-reset" ? "reset" : "magic", code);
  trusted.searchParams.set("email", to);
  return trusted.href;
}
