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
      if (typeof to !== "string" || to.length === 0 || typeof code !== "string" || code.length === 0) {
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

export function buildMagicLinkUrl({ baseUrl, to, code, returnTo, purpose = "signin" } = {}) {
  if (!["signin", "password-reset"].includes(purpose)) throw new Error("Invalid email link purpose");
  if (returnTo !== undefined && validateMagicReturnTo(returnTo) === null) throw new Error("Invalid magic-link return target");
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  const target = new URL(returnTo ?? "/", "https://return.invalid");
  const trusted = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  trusted.search = target.search;
  trusted.hash = target.hash;
  trusted.searchParams.set(purpose === "password-reset" ? "reset" : "magic", code);
  trusted.searchParams.set("email", to);
  return trusted.href;
}
