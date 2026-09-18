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
    sendMagicLink: async ({ to, code, expiresAt } = {}) => {
      if (!configured) return { delivered: false, reason: "mail_not_configured" };
      if (typeof to !== "string" || to.length === 0 || typeof code !== "string" || code.length === 0) {
        throw new Error("sendMagicLink requires a recipient and a code");
      }
      await send({ to, code, expiresAt, baseUrl });
      return { delivered: true };
    }
  });
}
