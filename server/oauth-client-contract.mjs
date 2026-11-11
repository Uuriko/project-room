// Pure OAuth configuration contract; no stores, grants, tokens or network.
export class OAuthProviderError extends Error {
  constructor(code, message) { super(message); this.name = "OAuthProviderError"; this.code = code; }
}
const fail = (code, message) => { throw new OAuthProviderError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_request", message); };

export const OAUTH_SCOPES = Object.freeze([
  "rooms:read",
  "chat:read",
  "chat:write",
  "work:read",
  "work:write",
  "members:invite",
]);

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function validateOAuthClient({ clientId, name, redirectUris }) {
  check(typeof clientId === "string" && CLIENT_ID_PATTERN.test(clientId),
    "clientId must match [A-Za-z0-9_-]{1,64}");
  check(typeof name === "string" && name.length > 0 && name.length <= 80,
    "name must be a non-empty string up to 80 chars");
  check(Array.isArray(redirectUris) && redirectUris.length > 0,
    "redirectUris must be a non-empty array");
  for (const uri of redirectUris) {
    check(typeof uri === "string", "every redirectUri must be a string");
    let parsed;
    try { parsed = new URL(uri); } catch { fail("invalid_request", `redirectUri is not a URL: ${uri}`); }
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    check(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalhost),
      "redirectUri must be https (http allowed only for localhost)");
    check(!parsed.hash, "redirectUri must not contain a fragment");
  }
}
