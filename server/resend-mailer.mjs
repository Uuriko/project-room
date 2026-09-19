// Resend mail sender for magic-link sign-in codes.
//
// Plugs into the magic-link mailer seam (server/magic-links.mjs): the Room
// ships unconfigured by default, and this module provides the operator's
// real delivery path when RESEND_API_KEY is present. No SMTP, no invented
// credentials — the key comes from the operator's environment only.
//
// Usage:
//   import { resendMagicLinkSend } from "./resend-mailer.mjs";
//   import { createMagicLinkMailer } from "./magic-links.mjs";
//   const send = resendMagicLinkSend({ apiKey, from, fetchFn });
//   const mailer = send ? createMagicLinkMailer({ send, baseUrl: origin }) : createMagicLinkMailer();

const RESEND_API_URL = "https://api.resend.com/emails";

const isNonEmptyString = value => typeof value === "string" && value.length > 0;

// Build the magic-link send function for createMagicLinkMailer.
// Returns null when no API key is configured (mailer stays unconfigured).
export function resendMagicLinkSend({ apiKey, from, fetchFn = fetch } = {}) {
  if (!isNonEmptyString(apiKey) || !isNonEmptyString(from)) return null;
  return async ({ to, code, expiresAt, baseUrl } = {}) => {
    if (!isNonEmptyString(to) || !isNonEmptyString(code)) {
      throw new Error("resendMagicLinkSend requires a recipient and a code");
    }
    const minutes = typeof expiresAt === "number"
      ? Math.max(1, Math.round((expiresAt - Date.now()) / 60000))
      : 15;
    // One-tap sign-in link: the app auto-redeems ?magic=<code>&email=<addr>
    // on load. The code stays single-use with a 15-minute expiry, and the
    // plaintext code remains in the body as a fallback for clients that
    // don't render links.
    const link = isNonEmptyString(baseUrl)
      ? `${baseUrl.replace(/\/+$/, "")}/?magic=${encodeURIComponent(code)}&email=${encodeURIComponent(to)}`
      : null;
    const subject = "Your Project Room sign-in link";
    const text = link
      ? `Sign in to Project Room:\n\n${link}\n\n` +
        `This link expires in ${minutes} minutes and works once. ` +
        `If the button doesn't work, enter this code instead: ${code}\n\n` +
        `If you didn't request this, you can ignore this email.`
      : `Your Project Room sign-in code is: ${code}\n\n` +
        `It expires in ${minutes} minutes. If you didn't request this, you can ignore this email.`;
    const html = link
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">Sign in to Project Room</a></p>` +
        `<p>This link expires in ${minutes} minutes and works once. If the button doesn't work, enter this code instead:</p>` +
        `<p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${escapeHtml(code)}</p>` +
        `<p>If you didn't request this, you can ignore this email.</p>`
      : `<p>Your Project Room sign-in code is:</p>` +
        `<p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${escapeHtml(code)}</p>` +
        `<p>It expires in ${minutes} minutes. If you didn't request this, you can ignore this email.</p>`;
    let response;
    try {
      response = await fetchFn(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ from, to, subject, text, html })
      });
    } catch (error) {
      throw new Error(`magic link email failed to send: ${error?.message ?? error}`);
    }
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`magic link email failed to send (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Resolve the magic-link mailer from the environment. Returns null when
// RESEND_API_KEY is absent so callers fall back to the unconfigured seam.
// ROOM_MAGIC_FROM sets the From address (defaults to a noreply sender).
export function magicLinkMailerFromEnv(env = process.env, { fetchFn = fetch } = {}) {
  const apiKey = env.RESEND_API_KEY;
  if (!isNonEmptyString(apiKey)) return null;
  const from = isNonEmptyString(env.ROOM_MAGIC_FROM) ? env.ROOM_MAGIC_FROM : "Project Room <noreply@trydemigod.com>";
  return resendMagicLinkSend({ apiKey, from, fetchFn });
}
