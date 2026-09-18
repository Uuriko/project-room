// HTTP routes for the Lane D agent plug-in surface (server/agent-plugin-store.mjs).
//
// Mutating routes authenticate the caller's agent identity: the pri_ identity
// secret travels in the Authorization header (never a JSON body), resolved
// with the existing AgentIdentities verifier — the same precedent as
// /api/agent-rooms. The public directory document, single public cards and
// the derived plug-in manifest are unauthenticated.
//
// Secrets are shown exactly once (at issue, rotate, and server-generated
// webhook-secret subscribe); list outputs never include them. Pure-module
// validation errors surface as 422 (404 for unknown/not-found codes);
// cross-identity access reads as 404, never an oracle.
//
// Mounted from server/http.mjs via createAgentPluginRoutes, which receives
// the server's local helpers. handleAgentPluginRoutes returns true when it
// served the request, false so http.mjs can fall through to other routes.
import { validatePluginManifest, WELL_KNOWN_PATH } from "./agent-plugin-manifest.mjs";
import { AgentPluginError } from "./agent-plugin-store.mjs";

const KEY_ACTION_ROUTE = /^\/api\/agent-keys\/(rak_[A-Za-z0-9_-]{1,64})\/(rotate|revoke)$/;
const SUBSCRIPTION_ROUTE = /^\/api\/agent-webhooks\/([A-Za-z0-9_-]{1,64})$/;
const CARD_ROUTE = /^\/api\/agent-directory\/cards\/([A-Za-z0-9_-]{1,120})$/;
const PUBLIC_CARD_ROUTE = /^\/api\/agents\/directory\/([a-z][a-z0-9-]{0,119})$/;

export function createAgentPluginRoutes({ store, json, reject, body, rate, bearer, exact, pathId, origin }) {
  // Coded pure-module errors -> HTTP: unknown/not-found reads as 404,
  // validation as 422. Ownership errors come from the sub-store as
  // AgentPluginError with their own status.
  const translate = handler => async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof AgentPluginError) reject(error.status, error.code, error.message);
      if (error && (error.name === "ApiKeyError" || error.name === "DirectoryError"
        || error.name === "WebhookSubscriptionError" || error.name === "ManifestError")) {
        reject(error.code === "directory_not_found" ? 404 : 422, error.code, error.message);
      }
      throw error;
    }
  };

  // pri_ identity secret (Authorization header only) -> { identityId, displayName }.
  const identityAuth = req => {
    const secret = bearer(req);
    if (!secret || !secret.startsWith("pri_")) reject(401, "unauthenticated", "Agent identity secret required");
    const resolved = store.identities.resolveGlobalIdentitySecret(secret);
    if (!resolved) reject(401, "unauthenticated", "Unknown agent identity");
    return resolved;
  };

  // The https origin the derived documents (manifest, directory) are built
  // for: the configured deployment origin when it is https, else the
  // request Host served over https (loopback/dev instances).
  const serviceOrigin = req => {
    if (typeof origin === "string" && origin.startsWith("https://")) return origin;
    const host = req.headers.host;
    if (typeof host === "string" && host.length > 0 && host.length <= 253) return `https://${host}`;
    reject(503, "plugin_origin_unavailable", "The service has no HTTPS origin to describe itself with");
  };

  // ---- Scoped API keys ----

  const issueKey = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-key-issue:${remoteAddress}`, 20);
    const auth = identityAuth(req);
    const data = await body(req);
    const shape = data && (exact(data, ["scopes"]) || exact(data, ["scopes", "label"])
      || exact(data, ["scopes", "expiresAt"]) || exact(data, ["scopes", "label", "expiresAt"]));
    if (!shape) reject(422, "invalid_api_key_request", "scopes, with optional label and expiresAt, are the accepted fields");
    if (!Array.isArray(data.scopes) || data.scopes.length === 0 || !data.scopes.every(s => typeof s === "string"))
      reject(422, "invalid_api_key_request", "scopes must be a non-empty string array");
    if (data.label !== undefined && typeof data.label !== "string")
      reject(422, "invalid_api_key_request", "label must be a string when given");
    if (data.expiresAt !== undefined && !(Number.isInteger(data.expiresAt) && data.expiresAt > 0))
      reject(422, "invalid_api_key_request", "expiresAt must be a positive integer ms epoch when given");
    const issued = store.agentPlugin.issueApiKey({
      identityId: auth.identityId,
      scopes: data.scopes,
      expiresAt: data.expiresAt ?? null,
      label: data.label ?? null,
    });
    return json(res, 201, issued);
  });

  const listKeys = translate(async (req, res) => {
    const auth = identityAuth(req);
    rate(`agent-keys-read:${auth.identityId}`, 120);
    return json(res, 200, { keys: store.agentPlugin.listApiKeys(auth.identityId) });
  });

  const keyAction = translate(async (req, res, { remoteAddress, keyId, action }) => {
    rate(`agent-key-${action}:${remoteAddress}`, 20);
    const auth = identityAuth(req);
    const result = action === "rotate"
      ? store.agentPlugin.rotateApiKey({ identityId: auth.identityId, keyId })
      : store.agentPlugin.revokeApiKey({ identityId: auth.identityId, keyId });
    return json(res, 200, result);
  });

  // ---- Agent directory ----

  const publishCard = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-directory-publish:${remoteAddress}`, 20);
    const auth = identityAuth(req);
    const data = await body(req);
    if (!data || !(exact(data, ["agentId", "card"]) || exact(data, ["agentId", "card", "visibility"])))
      reject(422, "invalid_card", "agentId, card, and optional visibility are the accepted fields");
    const doc = store.agentPlugin.publishCard({
      identityId: auth.identityId,
      agentId: data.agentId,
      card: data.card,
      visibility: data.visibility ?? "public",
    });
    return json(res, 201, doc);
  });

  const withdrawCard = translate(async (req, res, { remoteAddress, agentId }) => {
    rate(`agent-directory-withdraw:${remoteAddress}`, 20);
    const auth = identityAuth(req);
    return json(res, 200, store.agentPlugin.withdrawCard({ identityId: auth.identityId, agentId }));
  });

  const publicDirectory = translate(async (req, res, { url }) => {
    const doc = store.agentPlugin.publicDirectoryDocument({
      serviceOrigin: serviceOrigin(req),
      query: url.searchParams.get("q") ?? "",
      capability: url.searchParams.get("capability"),
    });
    return json(res, 200, doc);
  });

  const publicCard = translate(async (req, res, { agentId }) =>
    json(res, 200, store.agentPlugin.publicCard(agentId)));

  // ---- Plug-in manifest (derived; also at the module's well-known path) ----

  const manifest = translate(async (req, res) => {
    const doc = store.agentPlugin.pluginManifest(serviceOrigin(req));
    validatePluginManifest(doc);
    return json(res, 200, doc);
  });

  // ---- Per-agent webhook subscriptions ----

  const listWebhooks = translate(async (req, res) => {
    const auth = identityAuth(req);
    rate(`agent-webhooks-read:${auth.identityId}`, 120);
    return json(res, 200, { subscriptions: store.agentPlugin.listWebhooks(auth.identityId) });
  });

  const subscribeWebhook = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-webhook-subscribe:${remoteAddress}`, 20);
    const auth = identityAuth(req);
    const data = await body(req);
    if (!data || !(exact(data, ["url", "events"]) || exact(data, ["url", "events", "secret"])))
      reject(422, "invalid_subscription_request", "url, events, and optional secret are the accepted fields");
    if (!Array.isArray(data.events) || data.events.length === 0 || !data.events.every(e => typeof e === "string"))
      reject(422, "invalid_subscription_request", "events must be a non-empty string array");
    if (data.secret !== undefined && data.secret !== null && typeof data.secret !== "string")
      reject(422, "invalid_subscription_request", "secret must be a string when given");
    const { subscription, secretShownOnce } = store.agentPlugin.subscribeWebhook({
      identityId: auth.identityId,
      url: data.url,
      events: data.events,
      secret: data.secret ?? null,
    });
    // A server-generated signing secret is shown exactly once here; a
    // caller-supplied one is never echoed back.
    return json(res, 201, secretShownOnce ? { ...subscription, secret: secretShownOnce } : subscription);
  });

  const unsubscribeWebhook = translate(async (req, res, { remoteAddress, subscriptionId }) => {
    rate(`agent-webhook-unsubscribe:${remoteAddress}`, 20);
    const auth = identityAuth(req);
    return json(res, 200, store.agentPlugin.unsubscribeWebhook({ identityId: auth.identityId, subscriptionId }));
  });

  return async function handleAgentPluginRoutes(req, res, { url, remoteAddress }) {
    const pathname = url.pathname, method = req.method;
    if (pathname === "/api/agent-keys" && method === "POST") { await issueKey(req, res, { remoteAddress }); return true; }
    if (pathname === "/api/agent-keys" && method === "GET") { await listKeys(req, res); return true; }
    const keyActionMatch = method === "POST" ? KEY_ACTION_ROUTE.exec(pathname) : null;
    if (keyActionMatch) { await keyAction(req, res, { remoteAddress, keyId: keyActionMatch[1], action: keyActionMatch[2] }); return true; }
    if (pathname === "/api/agent-directory/cards" && method === "POST") { await publishCard(req, res, { remoteAddress }); return true; }
    if (pathname === "/api/agent-directory" && method === "GET") { await publicDirectory(req, res, { url }); return true; }
    if (pathname === "/api/agents/directory" && method === "GET") { await publicDirectory(req, res, { url }); return true; }
    const cardMatch = method === "DELETE" ? CARD_ROUTE.exec(pathname) : null;
    if (cardMatch) { await withdrawCard(req, res, { remoteAddress, agentId: cardMatch[1] }); return true; }
    const publicCardMatch = method === "GET" ? PUBLIC_CARD_ROUTE.exec(pathname) : null;
    if (publicCardMatch) { await publicCard(req, res, { agentId: publicCardMatch[1] }); return true; }
    if ((pathname === "/api/agent-manifest" || pathname === WELL_KNOWN_PATH) && method === "GET") { await manifest(req, res); return true; }
    if (pathname === "/api/agent-webhooks" && method === "GET") { await listWebhooks(req, res); return true; }
    if (pathname === "/api/agent-webhooks" && method === "POST") { await subscribeWebhook(req, res, { remoteAddress }); return true; }
    const subMatch = method === "DELETE" ? SUBSCRIPTION_ROUTE.exec(pathname) : null;
    if (subMatch) { await unsubscribeWebhook(req, res, { remoteAddress, subscriptionId: subMatch[1] }); return true; }
    return false;
  };
}
