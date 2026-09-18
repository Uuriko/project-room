import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_START_PATH = '/api/auth/google/start';
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
export const GOOGLE_SCOPES = 'openid email profile';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const jwksEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const clientIdPattern = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

export class GoogleOAuthError extends Error {
  constructor(code) { super(code); this.name = 'GoogleOAuthError'; this.code = code; }
}
const fail = code => { throw new GoogleOAuthError(code); };

export function googleSubject(sub) {
  return typeof sub === 'string' && /^[1-9][0-9]{0,254}$/.test(sub);
}

// SameSite=Strict cookies set on the Google callback are stored, but a 302
// follow-up is still the cross-site navigation and will not send them.
// A same-origin HTML return lets the next load include the session.
export function googlePostLoginPage(href) {
  if (href !== '/?google=error' && href !== '/?account=1' && !/^\/\?room=[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(href)) fail('google_callback_invalid');
  const safe = href.replace(/&/g, '&amp;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Opening Project Room</title></head><body><p>Opening Room…</p><p><a href="${safe}">Continue</a></p></body></html>`;
}

export function googleConfig(env = {}, origin) {
  const clientId = env.ROOM_GOOGLE_CLIENT_ID;
  const clientSecret = env.ROOM_GOOGLE_CLIENT_SECRET;
  if ([clientId, clientSecret].every(value => value === undefined)) return null;
  const invalid = () => { throw new Error('Invalid Room Google authentication configuration'); };
  if (!clientIdPattern.test(clientId || '') || !opaque(clientSecret) || clientSecret.length > 256) invalid();
  let appUrl;
  try { appUrl = new URL(origin); } catch { invalid(); }
  if (appUrl.origin !== origin || !['http:', 'https:'].includes(appUrl.protocol)) invalid();
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname);
  if (!loopback && appUrl.protocol !== 'https:') invalid();
  const redirectUri = origin + GOOGLE_CALLBACK_PATH;
  return { clientId, clientSecret, redirectUri, issuer: GOOGLE_ISSUER };
}

function decodeJwtPart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) fail('google_token_invalid');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) fail('google_token_invalid');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('google_token_invalid'); }
}

export class GoogleSignIn {
  #clientId; #clientSecret; #redirectUri; #fetch; #now; #pending = new Map(); #keys = new Map(); #keysFetchedAt = 0;
  constructor({ clientId, clientSecret, redirectUri, fetchImpl = fetch, now = Date.now }) {
    let redirect;
    try { redirect = new URL(redirectUri); } catch { fail('google_configuration_invalid'); }
    if (!clientIdPattern.test(clientId || '') || !opaque(clientSecret) || redirect.pathname !== GOOGLE_CALLBACK_PATH
      || redirect.search || redirect.hash || redirect.username || redirect.password
      || !(redirect.protocol === 'https:' || redirect.protocol === 'http:' && redirect.hostname === '127.0.0.1'))
      fail('google_configuration_invalid');
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri = redirect.href;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  begin({ slotToken, expectedRevision }) {
    if (!tokenPattern.test(slotToken || '') || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      fail('google_session_required');
    for (const [key, entry] of this.#pending) {
      if (entry.expiresAt <= this.#now() || entry.slotToken === slotToken) this.#pending.delete(key);
    }
    if (this.#pending.size >= 100) fail('google_connection_busy');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + 10 * 60 * 1000;
    this.#pending.set(digest(state), { slotToken, expectedRevision, verifier, expiresAt });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.#clientId, redirect_uri: this.#redirectUri, response_type: 'code',
      scope: GOOGLE_SCOPES, access_type: 'online', prompt: 'select_account', include_granted_scopes: 'false',
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
    }).toString();
    return { authorizationUrl: url.href, expiresAt };
  }

  async #json(url, init) {
    try {
      const response = await this.#fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); fail('google_provider_rejected'); }
      if (!response.body) fail('google_provider_invalid');
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); fail('google_provider_invalid'); }
        chunks.push(Buffer.from(value));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('google_provider_invalid');
      return data;
    } catch (error) {
      if (error instanceof GoogleOAuthError) throw error;
      fail('google_provider_unavailable');
    }
  }

  async #key(kid) {
    if (typeof kid !== 'string' || !kid || kid.length > 256) fail('google_token_invalid');
    const cached = this.#keys.get(kid);
    if (cached && this.#now() - this.#keysFetchedAt < 60 * 60 * 1000) return cached;
    const document = await this.#json(jwksEndpoint, { method: 'GET' });
    if (!Array.isArray(document.keys) || document.keys.length > 16) fail('google_provider_invalid');
    this.#keys.clear();
    this.#keysFetchedAt = this.#now();
    for (const jwk of document.keys) {
      if (jwk?.kty !== 'RSA' || jwk.use && jwk.use !== 'sig' || jwk.alg && jwk.alg !== 'RS256'
        || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
      try {
        const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) continue;
        this.#keys.set(jwk.kid, key);
      } catch { continue; }
    }
    const next = this.#keys.get(kid);
    if (!next) fail('google_token_invalid');
    return next;
  }

  async verifyIdToken(idToken) {
    if (typeof idToken !== 'string' || idToken.length > 16384) fail('google_token_invalid');
    const parts = idToken.split('.');
    if (parts.length !== 3) fail('google_token_invalid');
    const header = decodeJwtPart(parts[0]);
    if (header?.alg !== 'RS256' || (header.typ && header.typ !== 'JWT') || header.crit !== undefined
      || header.jku !== undefined || header.jwk !== undefined) fail('google_token_invalid');
    const key = await this.#key(header.kid);
    if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url')))
      fail('google_token_invalid');
    const claims = decodeJwtPart(parts[1]);
    const seconds = Math.floor(this.#now() / 1000);
    const issuer = claims?.iss === 'accounts.google.com' ? GOOGLE_ISSUER : claims?.iss;
    const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    if (issuer !== GOOGLE_ISSUER || !audience.includes(this.#clientId) || !googleSubject(claims.sub)
      || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
      || claims.exp <= seconds || claims.iat > seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3600)
      fail('google_token_invalid');
    return { iss: GOOGLE_ISSUER, sub: claims.sub, exp: claims.exp, iat: claims.iat };
  }

  async complete({ callbackUrl }) {
    let url;
    try { url = new URL(callbackUrl); } catch { fail('google_callback_invalid'); }
    const expected = new URL(this.#redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password)
      fail('google_callback_invalid');
    for (const key of ['state', 'code', 'error']) if (url.searchParams.getAll(key).length > 1) fail('google_callback_invalid');
    const state = url.searchParams.get('state');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) fail('google_state_invalid');
    const key = digest(state);
    const entry = this.#pending.get(key);
    if (!entry || entry.used || entry.expiresAt <= this.#now()) {
      if (entry?.expiresAt <= this.#now()) this.#pending.delete(key);
      fail('google_state_invalid');
    }
    if (entry.used) fail('google_state_invalid');
    entry.used = true;
    if (url.searchParams.has('error')) fail('google_consent_denied');
    const code = url.searchParams.get('code');
    if (!opaque(code)) fail('google_callback_invalid');
    const tokens = await this.#json(tokenEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#clientId, client_secret: this.#clientSecret, code,
        code_verifier: entry.verifier, grant_type: 'authorization_code', redirect_uri: this.#redirectUri
      }).toString()
    });
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.trim().split(/\s+/) : [];
    if (!scopes.includes('openid')) fail('google_scope_mismatch');
    const claims = await this.verifyIdToken(tokens.id_token);
    this.#pending.delete(key);
    return { claims, idToken: tokens.id_token, slotToken: entry.slotToken, expectedRevision: entry.expectedRevision };
  }
}
