// Microsoft Graph OAuth connection flow — pure logic, no network, no secrets in code.
// All randomness and time come from an injected `deps` param:
//   deps.random(n) -> hex string of n bytes (for opaque token ref ids / generated state)
//   deps.clock()    -> current time in milliseconds (like Date.now())
//
// Token values are never stored as plaintext by this module. parseTokenResponse()
// wraps raw token values in opaque ref objects whose `value` is non-enumerable, so
// JSON.stringify / naive persistence of records can never capture the raw value.

const AUTHORITY = 'https://login.microsoftonline.com';

const SCOPE_MAP = {
  'mail.read': ['https://graph.microsoft.com/Mail.Read'],
  'mail.send': ['https://graph.microsoft.com/Mail.Send'],
  'calendars': ['https://graph.microsoft.com/Calendars.ReadWrite'],
  'profile': ['https://graph.microsoft.com/User.Read'],
  'files': ['https://graph.microsoft.com/Files.ReadWrite'],
};

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function defaultDeps() {
  return {
    random: (n) => {
      // Fallback only when the caller did not inject a PRNG; not used in tests.
      let s = '';
      const hex = '0123456789abcdef';
      for (let i = 0; i < n * 2; i += 1) s += hex[Math.floor(Math.random() * 16)];
      return s;
    },
    clock: () => Date.now(),
  };
}

function resolveDeps(deps) {
  const d = defaultDeps();
  if (deps) {
    if (deps.random) d.random = deps.random;
    if (deps.clock) d.clock = deps.clock;
  }
  return d;
}

function requireNonEmptyString(value, code, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw err(code, `${label} must be a non-empty string`);
  }
  return value.trim();
}

function isLocalhostRedirect(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function validateRedirectUri(redirectUri) {
  requireNonEmptyString(redirectUri, 'MSGRAPH_INVALID_REDIRECT', 'redirectUri');
  let u;
  try {
    u = new URL(redirectUri);
  } catch {
    throw err('MSGRAPH_INVALID_REDIRECT', 'redirectUri must be a valid absolute URL');
  }
  if (u.protocol === 'https:' || isLocalhostRedirect(redirectUri)) return u.toString();
  throw err(
    'MSGRAPH_INVALID_REDIRECT',
    'redirectUri must use https (http is allowed only for localhost)',
  );
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw err('MSGRAPH_EMPTY_SCOPES', 'scopes must be a non-empty array of scope strings');
  }
  for (const s of scopes) {
    requireNonEmptyString(s, 'MSGRAPH_EMPTY_SCOPES', 'each scope');
  }
  return [...scopes];
}

function validateTenant(tenant) {
  requireNonEmptyString(tenant, 'MSGRAPH_INVALID_TENANT', 'tenant');
  // Keep the tenant segment path-safe: GUID, domain, or 'common'/'organizations'/'consumers'.
  if (!/^[a-zA-Z0-9._-]+$/.test(tenant)) {
    throw err('MSGRAPH_INVALID_TENANT', 'tenant contains characters not allowed in the URL path');
  }
  return tenant;
}

/**
 * Build the Microsoft identity platform v2.0 authorize URL.
 * PKCE params are included only when `codeChallenge` is provided.
 */
export function buildAuthorizeUrl(
  { clientId, redirectUri, scopes, tenant = 'common', state, codeChallenge },
  deps,
) {
  const { random } = resolveDeps(deps);
  requireNonEmptyString(clientId, 'MSGRAPH_INVALID_CLIENT_ID', 'clientId');
  validateRedirectUri(redirectUri);
  validateTenant(tenant);
  const scopeList = validateScopes(scopes);

  if (codeChallenge !== undefined) {
    requireNonEmptyString(codeChallenge, 'MSGRAPH_INVALID_CODE_CHALLENGE', 'codeChallenge');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: scopeList.join(' '),
  });
  const resolvedState = state !== undefined ? state : random(16);
  params.set('state', resolvedState);
  if (codeChallenge !== undefined) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${AUTHORITY}/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Build the token-exchange POST request SHAPE. Never executes fetch.
 * The client secret is accepted only as an opaque ref (e.g. { ref: 'vault://…' });
 * raw secret values are never embedded or logged here.
 */
export function buildTokenExchangeRequest(
  { clientId, redirectUri, code, codeVerifier, clientSecretRef, tenant = 'common' },
) {
  requireNonEmptyString(clientId, 'MSGRAPH_INVALID_CLIENT_ID', 'clientId');
  validateRedirectUri(redirectUri);
  validateTenant(tenant);
  requireNonEmptyString(code, 'MSGRAPH_INVALID_CODE', 'code');
  requireNonEmptyString(codeVerifier, 'MSGRAPH_INVALID_VERIFIER', 'codeVerifier');

  const body = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (clientSecretRef !== undefined) {
    if (typeof clientSecretRef !== 'object' || clientSecretRef === null) {
      throw err('MSGRAPH_INVALID_SECRET_REF', 'clientSecretRef must be an opaque ref object');
    }
    body.client_secret = clientSecretRef;
  }
  return {
    url: `${AUTHORITY}/${tenant}/oauth2/v2.0/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
}

/**
 * Wrap a raw token value in an opaque ref. The value is non-enumerable so it
 * never leaks into JSON.stringify / logs of records holding the ref; the ref id
 * is what storage layers persist, and they look the value up from the vault.
 */
function opaqueRef(kind, value, random) {
  const ref = { kind, ref: `msgraph:${random(8)}` };
  Object.defineProperty(ref, 'value', { value, enumerable: false, writable: false });
  return ref;
}

/**
 * Normalize a token-endpoint JSON response. expiresAt is computed from
 * expires_in using the injected clock (milliseconds).
 */
export function parseTokenResponse(json, deps) {
  const { random, clock } = resolveDeps(deps);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw err('MSGRAPH_BAD_TOKEN_RESPONSE', 'token response must be a JSON object');
  }
  if (typeof json.access_token !== 'string' || json.access_token === '') {
    throw err('MSGRAPH_BAD_TOKEN_RESPONSE', 'token response is missing access_token');
  }
  if (json.error) {
    throw err(
      'MSGRAPH_TOKEN_ERROR',
      `token endpoint error: ${json.error}${json.error_description ? ` — ${json.error_description}` : ''}`,
    );
  }
  const expiresIn = Number(json.expires_in);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn >= 0
      ? new Date(clock() + expiresIn * 1000).toISOString()
      : null;
  const scopeString = typeof json.scope === 'string' ? json.scope : '';
  return {
    accessTokenRef: opaqueRef('access_token', json.access_token, random),
    refreshTokenRef:
      typeof json.refresh_token === 'string' && json.refresh_token !== ''
        ? opaqueRef('refresh_token', json.refresh_token, random)
        : null,
    expiresAt,
    scopesGranted: scopeString.split(' ').filter(Boolean),
    tokenType: typeof json.token_type === 'string' && json.token_type !== '' ? json.token_type : 'Bearer',
  };
}

/**
 * Build the storage shape for a connected Microsoft Graph account.
 * Token VALUES never appear in the record — only metadata and opaque refs.
 */
export function connectionRecord(
  { accountId, tenant = 'common', scopesGranted = [], connectedAt, tokenMeta },
  deps,
) {
  const { clock } = resolveDeps(deps);
  requireNonEmptyString(accountId, 'MSGRAPH_INVALID_ACCOUNT', 'accountId');
  validateTenant(tenant);
  if (!Array.isArray(scopesGranted)) {
    throw err('MSGRAPH_EMPTY_SCOPES', 'scopesGranted must be an array');
  }
  const meta = tokenMeta && typeof tokenMeta === 'object' ? tokenMeta : {};
  return {
    provider: 'msgraph',
    accountId,
    tenant,
    scopes: [...scopesGranted],
    status: 'connected',
    connectedAt: connectedAt || new Date(clock()).toISOString(),
    tokenMeta: {
      expiresAt: meta.expiresAt ?? null,
      hasRefreshToken: meta.hasRefreshToken === true,
    },
  };
}

/** Map a purpose label to Microsoft Graph scope strings. */
export function scopesFor(purpose) {
  requireNonEmptyString(purpose, 'MSGRAPH_UNKNOWN_PURPOSE', 'purpose');
  const scopes = SCOPE_MAP[purpose];
  if (!scopes) {
    throw err(
      'MSGRAPH_UNKNOWN_PURPOSE',
      `unknown purpose "${purpose}"; known: ${Object.keys(SCOPE_MAP).join(', ')}`,
    );
  }
  return [...scopes];
}
