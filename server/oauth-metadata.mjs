// Discovery uses configured public facts only; issuing grants remains durable.
import { OAUTH_SCOPES, validateOAuthClient } from "./oauth-client-contract.mjs";

export function mcpOAuthResourceMetadata(resource, issuer) {
  for (const value of [resource, issuer]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.href !== value && url.origin !== value))
      throw new TypeError('Exact HTTPS resource and issuer required');
  }
  return Object.freeze({ resource, authorization_servers: [issuer],
    bearer_methods_supported: ['header'], scopes_supported: [...OAUTH_SCOPES] });
}

export function oauthAuthorizationServerMetadata(issuer, oauthResource) {
  return {
    issuer,
    authorization_endpoint: issuer + "/oauth/authorize",
    authorization_response_iss_parameter_supported: true,
    token_endpoint: issuer + "/oauth/token",
    revocation_endpoint: issuer + "/oauth/revoke",
    ...(oauthResource ? {registration_endpoint: issuer + "/oauth/register"} : {}),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...OAUTH_SCOPES],
    token_endpoint_auth_methods_supported: ["none"], // public clients with PKCE
  };
}

export function configuredMcpOAuthResource(origin, clients) {
  // Same static registrations accepted by the durable provider. Never infer
  // discovery support from an incoming Host or from a provider name.
  if (!Array.isArray(clients)) throw new TypeError("Configured OAuth clients must be an array");
  const seen = new Map();
  for (const client of clients) {
    validateOAuthClient(client);
    const prior = seen.get(client.clientId);
    if (prior && (prior.name !== client.name || JSON.stringify(prior.redirectUris) !== JSON.stringify(client.redirectUris)))
      throw new TypeError("Conflicting configured OAuth clients");
    seen.set(client.clientId, client);
  }
  const resource = clients.length ? new URL("/mcp", origin).href : null;
  if (resource) mcpOAuthResourceMetadata(resource, origin);
  return resource;
}
