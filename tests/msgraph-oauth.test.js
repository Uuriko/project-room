import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthorizeUrl,
  buildTokenExchangeRequest,
  parseTokenResponse,
  connectionRecord,
  scopesFor,
} from '../src/msgraph-oauth.mjs';

// Deterministic fake deps: no randomness, no real clock.
const fakeDeps = {
  random: (n) => 'a'.repeat(n * 2),
  clock: () => 1_700_000_000_000,
};

const baseArgs = {
  clientId: 'test-client-id',
  redirectUri: 'https://app.example.com/oauth/callback',
  scopes: ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/User.Read'],
};

test('authorize URL contains tenant, scopes, response params, and PKCE', () => {
  const url = buildAuthorizeUrl(
    { ...baseArgs, tenant: 'contoso.onmicrosoft.com', state: 'xyz', codeChallenge: 'challenge123' },
    fakeDeps,
  );
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
  assert.equal(u.searchParams.get('client_id'), 'test-client-id');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('response_mode'), 'query');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example.com/oauth/callback');
  assert.equal(
    u.searchParams.get('scope'),
    'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read',
  );
  assert.equal(u.searchParams.get('state'), 'xyz');
  assert.equal(u.searchParams.get('code_challenge'), 'challenge123');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

test('authorize URL omits PKCE params when no codeChallenge given', () => {
  const url = buildAuthorizeUrl({ ...baseArgs, state: 's1' }, fakeDeps);
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge'), null);
  assert.equal(u.searchParams.get('code_challenge_method'), null);
});

test('authorize URL generates state from injected random when not provided', () => {
  const url = buildAuthorizeUrl(baseArgs, fakeDeps);
  const u = new URL(url);
  assert.equal(u.searchParams.get('state'), 'a'.repeat(32));
});

test('authorize URL defaults tenant to common', () => {
  const url = buildAuthorizeUrl({ ...baseArgs, state: 's1' }, fakeDeps);
  assert.ok(url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'));
});

test('invalid redirectUri throws MSGRAPH_INVALID_REDIRECT', () => {
  assert.throws(
    () => buildAuthorizeUrl({ ...baseArgs, redirectUri: 'http://app.example.com/cb', state: 's' }, fakeDeps),
    (e) => e.code === 'MSGRAPH_INVALID_REDIRECT',
  );
  assert.throws(
    () => buildAuthorizeUrl({ ...baseArgs, redirectUri: 'not-a-url', state: 's' }, fakeDeps),
    (e) => e.code === 'MSGRAPH_INVALID_REDIRECT',
  );
});

test('http localhost redirectUri is allowed', () => {
  const url = buildAuthorizeUrl(
    { ...baseArgs, redirectUri: 'http://localhost:3000/callback', state: 's' },
    fakeDeps,
  );
  const u = new URL(url);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/callback');
});

test('empty scopes throws MSGRAPH_EMPTY_SCOPES', () => {
  assert.throws(
    () => buildAuthorizeUrl({ ...baseArgs, scopes: [], state: 's' }, fakeDeps),
    (e) => e.code === 'MSGRAPH_EMPTY_SCOPES',
  );
});

test('token exchange returns request shape without fetching', () => {
  const secretRef = { ref: 'vault://msgraph/client-secret' };
  const req = buildTokenExchangeRequest({
    clientId: 'test-client-id',
    redirectUri: 'https://app.example.com/oauth/callback',
    code: 'auth-code-1',
    codeVerifier: 'verifier-1',
    clientSecretRef: secretRef,
  });
  assert.equal(req.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(req.body.grant_type, 'authorization_code');
  assert.equal(req.body.code, 'auth-code-1');
  assert.equal(req.body.code_verifier, 'verifier-1');
  assert.equal(req.body.client_secret, secretRef, 'secret stays an opaque ref object');
  assert.ok(!('fetch' in req), 'no fetch execution in the shape');
});

test('token exchange without secret ref omits client_secret', () => {
  const req = buildTokenExchangeRequest({
    clientId: 'cid',
    redirectUri: 'https://app.example.com/oauth/callback',
    code: 'c',
    codeVerifier: 'v',
  });
  assert.ok(!('client_secret' in req.body));
});

test('token exchange rejects a raw-string secret', () => {
  assert.throws(
    () =>
      buildTokenExchangeRequest({
        clientId: 'cid',
        redirectUri: 'https://app.example.com/oauth/callback',
        code: 'c',
        codeVerifier: 'v',
        clientSecretRef: 'super-secret-plaintext',
      }),
    (e) => e.code === 'MSGRAPH_INVALID_SECRET_REF',
  );
});

test('parse computes expiresAt with fake clock and wraps tokens as opaque refs', () => {
  const rawAccess = 'EwD0A8l6BAAURSN/FHlDW5xN74tGM7G'+'sekret-token-value';
  const rawRefresh = 'refresh-token-plain-value';
  const out = parseTokenResponse(
    {
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'Mail.Read User.Read',
      access_token: rawAccess,
      refresh_token: rawRefresh,
    },
    fakeDeps,
  );
  assert.equal(out.expiresAt, new Date(1_700_000_000_000 + 3600 * 1000).toISOString());
  assert.deepEqual(out.scopesGranted, ['Mail.Read', 'User.Read']);
  assert.equal(out.tokenType, 'Bearer');
  assert.equal(out.accessTokenRef.kind, 'access_token');
  assert.ok(out.accessTokenRef.ref.startsWith('msgraph:'));
  assert.equal(out.refreshTokenRef.kind, 'refresh_token');
  // Opaque on serialization: raw values never appear in JSON.
  const json = JSON.stringify(out);
  assert.ok(!json.includes(rawAccess), 'raw access token must not serialize');
  assert.ok(!json.includes(rawRefresh), 'raw refresh token must not serialize');
});

test('bad token response throws MSGRAPH_BAD_TOKEN_RESPONSE', () => {
  assert.throws(() => parseTokenResponse({}, fakeDeps), (e) => e.code === 'MSGRAPH_BAD_TOKEN_RESPONSE');
  assert.throws(() => parseTokenResponse({ access_token: '' }, fakeDeps), (e) => e.code === 'MSGRAPH_BAD_TOKEN_RESPONSE');
  assert.throws(() => parseTokenResponse(null, fakeDeps), (e) => e.code === 'MSGRAPH_BAD_TOKEN_RESPONSE');
  assert.throws(
    () => parseTokenResponse({ error: 'invalid_grant', access_token: 'x' }, fakeDeps),
    (e) => e.code === 'MSGRAPH_TOKEN_ERROR',
  );
});

test('connection record shape carries only token metadata, never raw values', () => {
  const parsed = parseTokenResponse(
    {
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'Mail.Read',
      access_token: 'raw-access-value-123',
      refresh_token: 'raw-refresh-value-456',
    },
    fakeDeps,
  );
  const rec = connectionRecord(
    {
      accountId: 'user@contoso.com',
      tenant: 'contoso.onmicrosoft.com',
      scopesGranted: ['Mail.Read'],
      tokenMeta: { expiresAt: parsed.expiresAt, hasRefreshToken: parsed.refreshTokenRef !== null },
    },
    fakeDeps,
  );
  assert.equal(rec.provider, 'msgraph');
  assert.equal(rec.accountId, 'user@contoso.com');
  assert.equal(rec.status, 'connected');
  assert.deepEqual(rec.scopes, ['Mail.Read']);
  assert.equal(rec.connectedAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(rec.tokenMeta, { expiresAt: parsed.expiresAt, hasRefreshToken: true });
  const json = JSON.stringify(rec);
  assert.ok(!json.includes('raw-access-value-123'), 'record must not contain raw token values');
  assert.ok(!json.includes('raw-refresh-value-456'), 'record must not contain raw token values');
});

test('scopesFor maps purposes to Graph scope strings', () => {
  assert.deepEqual(scopesFor('mail.read'), ['https://graph.microsoft.com/Mail.Read']);
  assert.deepEqual(scopesFor('mail.send'), ['https://graph.microsoft.com/Mail.Send']);
  assert.deepEqual(scopesFor('calendars'), ['https://graph.microsoft.com/Calendars.ReadWrite']);
  assert.throws(() => scopesFor('nope'), (e) => e.code === 'MSGRAPH_UNKNOWN_PURPOSE');
});
