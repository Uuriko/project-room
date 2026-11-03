import { randomBytes, createHash } from "node:crypto";
import { ServiceError } from "../store.mjs";
import { inviteOAuthPage, MCP_INVITE_RECOVERY, PUBLIC_LOBBY_PROOF_SCRIPT, EXISTING_SEAT_COPY_SCRIPT } from "../mcp-invite-oauth.mjs";

export function renderInviteOAuthPage(res, view, request) {
  res.setHeader("Cache-Control", "no-store");
  // Browser form POSTs need their same-origin Origin for strict CSRF checks.
  // no-referrer makes Chromium send Origin:null; external referrers stay hidden.
  res.setHeader("Referrer-Policy", "same-origin");
  const proofScriptHash = createHash('sha256').update(PUBLIC_LOBBY_PROOF_SCRIPT).digest('base64');
  const copyScriptHash = createHash('sha256').update(EXISTING_SEAT_COPY_SCRIPT).digest('base64');
  res.setHeader("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'sha256-${proofScriptHash}' 'sha256-${copyScriptHash}'; form-action 'self' ${new URL(request.redirectUri).origin}`);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  return res.end(inviteOAuthPage(view));
}
async function handleInviteConsent(ctx) {
  const { req, res, remoteAddress, inviteOAuth, oauthResource, rate, checkOrigin, readText, cookie, json } = ctx;
  if (!inviteOAuth) return json(res, 404, { error: "native_connection_unavailable" });
  rate(`oauth-invite-confirm:${remoteAddress}`, 30);
  checkOrigin(req, true);
  const text = await readText(req, 16384, () => new ServiceError(413, "too_large", "Request is too large"));
  const data = Object.fromEntries(new URLSearchParams(text));
  const nonce = typeof data.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(data.nonce) ? data.nonce : null;
  const cookieNonce = nonce ? cookie(req, `oauth_invite_${nonce.slice(0, 16)}`) : null;
  if (!nonce || cookieNonce !== nonce) return json(res, 403, { error: "csrf_denied" });
  try {
    if (data.decision === 'existing_start') {
      const reference = inviteOAuth.existingSeatProof().createHandoff(nonce);
      return renderInviteOAuthPage(res, { nonce, request: inviteOAuth.read(nonce).request, existingHandoff: reference, existingIssuer: new URL(oauthResource).origin }, inviteOAuth.read(nonce).request);
    }
    if (data.decision === 'existing_check') {
      const review = inviteOAuth.existingSeatProof().review(nonce), { request } = inviteOAuth.read(nonce);
      const clientName = inviteOAuth.provider.getClient(review.clientId)?.name ?? review.clientId;
      return renderInviteOAuthPage(res, { nonce, request, existingReview: { ...review, clientName } }, request);
    }
    if (data.decision === 'existing_allow') {
      const redirect = inviteOAuth.approveExisting(nonce);
      res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (data.decision === "allow" || data.decision === "allow_public" || data.decision === "deny") {
      const redirect = data.decision === "deny" ? inviteOAuth.cancel(nonce) : data.decision === "allow_public" ? inviteOAuth.approvePublic(nonce, data.display_name, remoteAddress, data.proof) : inviteOAuth.approve(nonce, data.invitation, data.display_name);
      res.writeHead(302, { Location: redirect, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return res.end();
    }
    const viewed = inviteOAuth.preview(nonce, data.invitation);
    return renderInviteOAuthPage(res, { nonce, ...viewed }, viewed.request);
  } catch (error) {
    if (data.decision === 'existing_check' && inviteOAuth.existingSeatProof().hasHandoff(nonce, data.reference)) {
      const { request } = inviteOAuth.read(nonce);
      return renderInviteOAuthPage(res, { nonce, request, existingHandoff: data.reference, existingIssuer: new URL(oauthResource).origin, existingWaiting: true }, request);
    }
    if (data.decision === 'allow_public' && error.code === 'proof_required' && error.detail?.proof) {
      const { request } = inviteOAuth.read(nonce);
      return renderInviteOAuthPage(res, { nonce, request, publicLobby: true, proofChallenge: error.detail.proof, displayName: data.display_name }, request);
    }
    const publicRecovery = "Reuse your saved host connection. Retry an interrupted first setup with the same agent name. No invitation is required for the public lobby. If an existing accountless seat lost every credential, self-service recovery is not available. Do not create a replacement seat automatically.";
    return json(res, 400, { error: "invitation_connection_failed",
      error_description: data.decision === "allow_public" ? error.message.replace(MCP_INVITE_RECOVERY, publicRecovery) : error.message,
      recovery: data.decision === "allow_public" ? publicRecovery : MCP_INVITE_RECOVERY });
  }
}
// Holder calls use only an identity bearer and a separate one-time handoff
// reference. This endpoint never accepts browser cookies as holder proof.
async function handleExistingSeatHolder(ctx) {
  const { req, res, inviteOAuth, bearer, body, json, rate, remoteAddress } = ctx;
  if (!inviteOAuth) return json(res, 404, { error: 'native_connection_unavailable' });
  rate(`oauth-existing-seat:${remoteAddress}`, 20);
  const data = await body(req), secret = bearer(req);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const proof = inviteOAuth.existingSeatProof();
    if (data.action === 'inspect') return json(res, 200, proof.inspect(data.reference, secret, data.roomId));
    if (data.action === 'approve') return json(res, 200, proof.approve(data.reference, secret, data.roomId, data.requestHash));
  } catch { return json(res, 403, { error: 'existing_seat_proof_unavailable' }); }
  return json(res, 400, { error: 'invalid_request' });
}
function authenticateExistingSeatHolder(ctx) {
  const secret = ctx.bearer(ctx.req);
  if (!ctx.store.identities.resolveGlobalIdentitySecret(secret)) ctx.reject(401, 'unauthenticated', 'Active agent identity required');
}
export const MCP_INVITE_OAUTH_ROUTES = [{
  id: "mcp.invite.consent", method: "POST", path: "/oauth/invite", auth: "none",
  capability: null, events: [], scope: "worker", handler: handleInviteConsent,
  parity: "exempt:human native plugin consent; agent uses the resulting scoped OAuth grant",
  schema: { response: { type: "object" } },
}, {
  id: 'mcp.invite.existing-holder', method: 'POST', path: '/oauth/existing-seat', auth: 'bearer',
  capability: null, events: [], scope: 'worker', handler: handleExistingSeatHolder, authenticate: authenticateExistingSeatHolder,
  parity: 'exempt:prototype identity-holder approval for a pending native OAuth request',
  schema: { response: { type: 'object' } },
}];

// Public client metadata registration shares the configured native OAuth
// callbacks. It never creates membership, sponsorship or a token grant.
async function handleMcpRegistration(ctx) {
  const {req,res,store,remoteAddress,rate,body,json,reject,oauthResource,mcpRedirects,oauthProvider,inviteOAuth}=ctx;
  if(!oauthResource)return reject(404,"not_found","Not found");
        rate(`oauth-register:${remoteAddress}`, 20);
        const data = await body(req);
        if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.length || data.redirect_uris.length > 5
          || data.redirect_uris.some(uri => typeof uri !== "string" || !mcpRedirects.has(uri))
          || data.token_endpoint_auth_method && data.token_endpoint_auth_method !== "none"
          || data.grant_types && (!Array.isArray(data.grant_types) || data.grant_types.some(type => !["authorization_code", "refresh_token"].includes(type)))
          || data.response_types && (!Array.isArray(data.response_types) || data.response_types.some(type => type !== "code")))
          return json(res, 400, {error:"invalid_client_metadata"});
        if (store.db.prepare("SELECT count(*) n FROM (SELECT 1 FROM oauth_provider_clients LIMIT 1025)").get().n >= 1024)
          return json(res, 503, {error:"temporarily_unavailable"});
        const name = data.client_name ?? "MCP connector";
        if (typeof name !== "string" || !name.trim() || name.length > 80)
          return json(res, 400, {error:"invalid_client_metadata"});
        const clientId = "mcp_dcr_" + randomBytes(18).toString("base64url");
        const client = {clientId,name,redirectUris:[...new Set(data.redirect_uris)]};
        oauthProvider.registerClient(client);
        inviteOAuth?.provider.registerClient(client);
        res.setHeader("Cache-Control", "no-store");
        return json(res, 201, {client_id:clientId,client_name:name,redirect_uris:client.redirectUris,
          token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]});
}
export const MCP_REGISTER_OAUTH_ROUTES = [{
  id: "mcp.oauth.register", method: "POST", path: "/oauth/register", auth: "none",
  capability: null, events: [], scope: "worker", handler: handleMcpRegistration,
  parity: "exempt:public OAuth client metadata registration; consent grants are separate",
  schema: { response: { type: "object" } },
}];
