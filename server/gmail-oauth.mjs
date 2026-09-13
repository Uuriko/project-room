import { createHash, randomBytes } from 'node:crypto';

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_CALLBACK_PATH = '/api/inbox/connections/gmail/callback';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const profileEndpoint = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const digest = value => createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value);
const fail = code => { throw new GmailOAuthError(code); };

export class GmailOAuthError extends Error {
  constructor(code) { super(code); this.name = 'GmailOAuthError'; this.code = code; }
}

function binding(context) {
  if (!context || !opaque(context.accountId) || !opaque(context.sessionBinding)
    || !Number.isSafeInteger(context.authEpoch) || context.authEpoch < 0
    || !opaque(context.connectionId) || !Number.isSafeInteger(context.revision) || context.revision < 1)
    fail('gmail_session_required');
  return digest(JSON.stringify([context.accountId, context.sessionBinding, context.authEpoch, context.connectionId, context.revision]));
}

// Server-only boundary, not an HTTP handler. The host must authenticate and CSRF-check
// begin(), derive fresh context on every call, and keep returned credentials private.
// No token persistence, mailbox import, or sending is performed by this module.
export class GmailOAuth {
  #clientId; #clientSecret; #redirectUri; #fetch; #now; #pending = new Map();
  constructor({ clientId, clientSecret, redirectUri, fetchImpl = fetch, now = Date.now }) {
    let redirect;
    try { redirect = new URL(redirectUri); } catch { fail('gmail_configuration_invalid'); }
    if (!opaque(clientId) || !opaque(clientSecret) || redirect.pathname !== GMAIL_CALLBACK_PATH
      || redirect.search || redirect.hash || redirect.username || redirect.password
      || !(redirect.protocol === 'https:' || redirect.protocol === 'http:' && redirect.hostname === '127.0.0.1'))
      fail('gmail_configuration_invalid');
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri = redirect.href;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  begin({ context, mailbox }) {
    const bound = binding(context);
    if (typeof mailbox !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox) || mailbox.length > 254)
      fail('gmail_mailbox_required');
    for (const [key, entry] of this.#pending) {
      if (entry.expiresAt <= this.#now() || entry.bound === bound) this.#pending.delete(key);
    }
    if (this.#pending.size >= 100) fail('gmail_connection_busy');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + 10 * 60 * 1000;
    this.#pending.set(digest(state), { bound, verifier, mailbox: mailbox.toLowerCase(), expiresAt });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.#clientId, redirect_uri: this.#redirectUri, response_type: 'code',
      scope: GMAIL_READ_SCOPE, access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'false', login_hint: mailbox, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
    }).toString();
    return { authorizationUrl: url.href, expiresAt };
  }

  async #json(url, init) {
    try {
      const response = await this.#fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); fail('gmail_provider_rejected'); }
      if (!response.body) fail('gmail_provider_invalid');
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); fail('gmail_provider_invalid'); }
        chunks.push(Buffer.from(value));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('gmail_provider_invalid');
      return data;
    } catch (error) {
      if (error instanceof GmailOAuthError) throw error;
      // Never forward provider bodies, request headers, codes, or fetch error details.
      fail('gmail_provider_unavailable');
    }
  }

  async complete({ callbackUrl, getContext }) {
    let url;
    try { url = new URL(callbackUrl); } catch { fail('gmail_callback_invalid'); }
    const expected = new URL(this.#redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password)
      fail('gmail_callback_invalid');
    for (const key of ['state', 'code', 'error']) if (url.searchParams.getAll(key).length > 1) fail('gmail_callback_invalid');
    const state = url.searchParams.get('state');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) fail('gmail_state_invalid');
    const key = digest(state);
    const entry = this.#pending.get(key);
    if (!entry || entry.used || entry.expiresAt <= this.#now()) {
      if (entry?.expiresAt <= this.#now()) this.#pending.delete(key);
      fail('gmail_state_invalid');
    }
    const assertContext = async () => {
      if (binding(await getContext()) !== entry.bound) fail('gmail_session_changed');
      if (this.#pending.get(key) !== entry || entry.expiresAt <= this.#now()) fail('gmail_state_invalid');
    };
    await assertContext();
    // Consume before any network I/O. Failed exchanges require a fresh consent flow.
    if (entry.used) fail('gmail_state_invalid');
    entry.used = true;
    if (url.searchParams.has('error')) fail('gmail_consent_denied');
    const code = url.searchParams.get('code');
    if (!opaque(code)) fail('gmail_callback_invalid');
    const requestedAt = this.#now();
    const tokens = await this.#json(tokenEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.#clientId, client_secret: this.#clientSecret,
        code, code_verifier: entry.verifier, grant_type: 'authorization_code', redirect_uri: this.#redirectUri }).toString()
    });
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.trim().split(/\s+/) : [];
    if (scopes.length !== 1 || scopes[0] !== GMAIL_READ_SCOPE) fail('gmail_scope_mismatch');
    if (!opaque(tokens.access_token) || !opaque(tokens.refresh_token) || tokens.token_type?.toLowerCase() !== 'bearer'
      || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 1 || tokens.expires_in > 86400)
      fail('gmail_token_invalid');
    await assertContext();
    const profile = await this.#json(profileEndpoint, {
      method: 'GET', headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== entry.mailbox)
      fail('gmail_mailbox_mismatch');
    await assertContext();
    this.#pending.delete(key);
    return {
      mailbox: entry.mailbox, scope: GMAIL_READ_SCOPE,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: requestedAt + tokens.expires_in * 1000
    };
  }
}
