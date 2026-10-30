import { ServiceError } from "../store.mjs";
import { inviteOAuthPage } from "../mcp-invite-oauth.mjs";

export function renderInviteOAuthPage(res, view, request) {
  res.setHeader("Cache-Control", "no-store");
  // Browser form POSTs need their same-origin Origin for strict CSRF checks.
  // no-referrer makes Chromium send Origin:null; external referrers stay hidden.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${new URL(request.redirectUri).origin}`);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  return res.end(inviteOAuthPage(view));
}
async function handleInviteConsent(ctx) {
  const { req, res, remoteAddress, inviteOAuth, rate, checkOrigin, readText, cookie, json } = ctx;
  if (!inviteOAuth) return json(res, 404, { error: "native_connection_unavailable" });
  rate(`oauth-invite-confirm:${remoteAddress}`, 30);
  checkOrigin(req, true);
  const text = await readText(req, 16384, () => new ServiceError(413, "too_large", "Request is too large"));
  const data = Object.fromEntries(new URLSearchParams(text));
  const nonce = typeof data.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(data.nonce) ? data.nonce : null;
  const cookieNonce = nonce ? cookie(req, `oauth_invite_${nonce.slice(0, 16)}`) : null;
  if (!nonce || cookieNonce !== nonce) return json(res, 403, { error: "csrf_denied" });
  try {
    if (data.decision === "allow") {
      const redirect = inviteOAuth.approve(nonce, data.invitation, data.display_name);
      res.writeHead(302, { Location: redirect, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return res.end();
    }
    const viewed = inviteOAuth.preview(nonce, data.invitation);
    return renderInviteOAuthPage(res, { nonce, ...viewed }, viewed.request);
  } catch (error) { return json(res, 400, { error: "invitation_connection_failed", error_description: error.message }); }
}
export const MCP_INVITE_OAUTH_ROUTES = [{
  id: "mcp.invite.consent", method: "POST", path: "/oauth/invite", auth: "none",
  capability: null, events: [], scope: "worker", handler: handleInviteConsent,
  parity: "exempt:human native plugin consent; agent uses the resulting scoped OAuth grant",
  schema: { response: { type: "object" } },
}];
