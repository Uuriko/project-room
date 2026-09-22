// Gmail mailbox access is separate from Google account sign-in. Credentials
// and pending browser sessions are encrypted at rest and never projected.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { ServiceError } from './store.mjs';
import { normalizeGmailMessage } from './channel-adapters/gmail.mjs';
export const GMAIL_CALLBACK = '/api/auth/gmail/callback';
const scope = 'https://www.googleapis.com/auth/gmail.modify';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const apiUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (code, status = 422) => { throw new ServiceError(status, code, 'Gmail could not complete this request. Try connecting again.'); };
export const gmailSchema = `
CREATE TABLE IF NOT EXISTS account_setup (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE IF NOT EXISTS gmail_mailboxes (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 auth_epoch INTEGER NOT NULL, encrypted TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gmail_operations (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), at INTEGER NOT NULL, PRIMARY KEY(account_id,request_id)
);
CREATE TABLE IF NOT EXISTS gmail_pending (
 state_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, encrypted TEXT NOT NULL
);`;
export function gmailConfig(env = {}, origin, google = null) {
  if (env.ROOM_GMAIL_ENABLED !== '1') return null;
  if (!google || !/^[a-f0-9]{64}$/i.test(env.ROOM_GMAIL_TOKEN_KEY ?? '')) throw new Error('Gmail requires Google OAuth and a 32-byte ROOM_GMAIL_TOKEN_KEY');
  return { clientId: google.clientId, clientSecret: google.clientSecret, redirectUri: origin + GMAIL_CALLBACK, tokenKey: env.ROOM_GMAIL_TOKEN_KEY };
}
export class GmailMailbox {
  constructor(store, config) { this.store = store; this.config = config; this.fetch = (...args) => (config.fetchImpl ?? fetch)(...args); }
  seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(this.config.tokenKey, 'hex'), iv);
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  unseal(value, context) {
    try {
      const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.tokenKey, 'hex'), data.subarray(0, 12));
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(data.subarray(-16));
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString());
    } catch { fail('gmail_reconnect_required'); }
  }
  auth(token, binding) { return this.store.inbox.auth(token, binding); }
  record(auth) {
    const row = this.store.db.prepare('SELECT * FROM gmail_mailboxes WHERE account_id=?').get(auth.account.id);
    if (!row) return null;
    const data = this.unseal(row.encrypted, auth.account.id);
    const connection = this.store.connections.connection(auth.account.id, data.connectionId);
    return { ...data, usable: row.auth_epoch === auth.account.authEpoch && connection?.state === 'active' && connection.authEpoch === auth.account.authEpoch };
  }
  status(auth) {
    const data = this.record(auth);
    return data ? { state: data.usable && !data.reconnectRequired ? 'connected' : 'reconnect_required', canWrite: data.scopes?.includes(scope) === true, address: data.address, syncedAt: data.syncedAt ?? null } : { state: 'disconnected', address: null, syncedAt: null };
  }
  begin(token, binding) {
    const auth = this.auth(token, binding), state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const key = hash(state), expires = this.store.now() + 600000;
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM gmail_pending WHERE expires_at<=? OR account_id=?').run(this.store.now(), auth.account.id);
      if (this.store.db.prepare('SELECT count(*) n FROM gmail_pending').get().n >= 100) fail('gmail_busy', 429);
      this.store.db.prepare('INSERT INTO gmail_pending VALUES(?,?,?,?)').run(key, auth.account.id, expires,
        this.seal({ token, binding, verifier, revision: auth.sessionRevision, epoch: auth.account.authEpoch }, key));
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope,
      access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return url.href;
  }
  async json(url, init = {}) {
    let response;
    try { response = await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { fail('gmail_unavailable', 502); }
    if (!response.ok) { await response.body?.cancel(); fail([400, 401, 403].includes(response.status) ? 'gmail_reconnect_required' : 'gmail_unavailable', 502); }
    const reader = response.body?.getReader(); if (!reader) fail('gmail_invalid_response', 502);
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); fail('gmail_message_too_large'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('gmail_invalid_response', 502); }
  }
  exchange(fields) {
    return this.json(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...fields }).toString() });
  }
  async complete(url, browserState) {
    const expected = new URL(this.config.redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash) fail('gmail_invalid_callback');
    for (const name of ['state', 'code', 'error']) if (url.searchParams.getAll(name).length > 1) fail('gmail_invalid_callback');
    const state = url.searchParams.get('state'); if (!/^[\w-]{43}$/.test(state ?? '')) fail('gmail_invalid_callback');
    if (typeof browserState !== 'string' || browserState !== state) fail('gmail_browser_changed');
    const key = hash(state);
    const row = this.store.transaction(() => {
      const r = this.store.db.prepare('SELECT * FROM gmail_pending WHERE state_hash=?').get(key);
      this.store.db.prepare('UPDATE gmail_pending SET expires_at=0 WHERE state_hash=?').run(key); return r;
    });
    if (!row || row.expires_at <= this.store.now()) fail('gmail_expired');
    if (url.searchParams.has('error')) fail('gmail_consent_denied');
    const pending = this.unseal(row.encrypted, key);
    const check = () => {
      if (row.expires_at <= this.store.now() || !this.store.db.prepare('SELECT 1 FROM gmail_pending WHERE state_hash=?').get(key)) fail('gmail_session_changed');
      const auth = this.auth(pending.token, pending.binding);
      if (auth.account.id !== row.account_id || auth.account.authEpoch !== pending.epoch || auth.sessionRevision !== pending.revision) fail('gmail_session_changed');
      return auth;
    };
    check();
    const code = url.searchParams.get('code'); if (!code || code.length > 8192) fail('gmail_invalid_callback');
    const tokens = await this.exchange({ code, code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: this.config.redirectUri });
    if (!String(tokens.scope ?? '').split(/\s+/).includes(scope) || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || typeof tokens.access_token !== 'string') fail('gmail_permissions_required');
    const profile = await this.json(apiUrl + '/profile', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const address = profile.emailAddress;
    if (typeof address !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) fail('gmail_invalid_response');
    this.store.transaction(() => {
      const auth = check(), prior = this.record(auth);
      // One mailbox per account for the first release. Reconnect cannot silently switch it.
      if (prior && prior.address !== address) fail('gmail_mailbox_changed');
      const connectionId = 'gmail-' + hash(address).slice(0, 24);
      const existing = this.store.connections.connection(auth.account.id, connectionId);
      this.store.connections.apply(pending.token, { action: 'connection.configure', requestId: randomUUID(), connectionId, expectedRevision: existing?.profile.revision ?? 0,
        profile: { accountId: auth.account.id, id: connectionId, revision: (existing?.profile.revision ?? 0) + 1, provider: 'gmail-api', mailboxId: address,
          identity: { address, name: '' }, aliases: [] } }, pending.binding);
      this.save(auth, { address, connectionId, refreshToken: tokens.refresh_token, scopes: tokens.scope.split(/\s+/), syncedAt: null });
      this.store.db.prepare('DELETE FROM gmail_pending WHERE state_hash=?').run(key);
    });
    return { token: pending.token, binding: pending.binding };
  }
  save(auth, data) {
    this.store.db.prepare('INSERT INTO gmail_mailboxes VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET auth_epoch=excluded.auth_epoch,encrypted=excluded.encrypted')
      .run(auth.account.id, auth.account.authEpoch, this.seal(data, auth.account.id));
  }
  async sync(token, binding) {
    const auth = this.auth(token, binding), record = this.record(auth);
    if (!record?.usable) fail('gmail_reconnect_required');
    const c = this.store.connections.connection(auth.account.id, record.connectionId);
    let tokens;
    try { tokens = await this.exchange({ refresh_token: record.refreshToken, grant_type: 'refresh_token' }); }
    catch (error) {
      if (error.code === 'gmail_reconnect_required') this.store.transaction(() => {
        const current = this.auth(token, binding), latest = this.record(current);
        if (latest?.refreshToken === record.refreshToken && latest.usable) this.save(current, { ...latest, usable: undefined, reconnectRequired: true });
      });
      throw error;
    }
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) fail('gmail_reconnect_required');
    const headers = { Authorization: 'Bearer ' + tokens.access_token };
    const list = await this.json(apiUrl + '/messages?labelIds=INBOX&maxResults=25', { headers });
    if (list.messages !== undefined && (!Array.isArray(list.messages) || list.messages.length > 25)) fail('gmail_invalid_response');
    const observations = [];
    for (const message of list.messages ?? []) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(message.id ?? '')) fail('gmail_invalid_response');
      const hydrated = await this.json(apiUrl + '/messages/' + message.id + '?format=full', { headers });
      if (hydrated.id !== message.id) fail('gmail_invalid_response');
      if (!hydrated.labelIds?.includes('INBOX')) continue;
      const envelope = normalizeGmailMessage(c.profile, hydrated);
      observations.push({ kind: 'message', envelope });
    }
    return this.store.transaction(() => {
      const current = this.auth(token, binding), latest = this.record(current);
      if (!latest?.usable || latest.refreshToken !== record.refreshToken || current.account.authEpoch !== auth.account.authEpoch) fail('gmail_session_changed');
      for (const item of observations) item.expectedSourceRevision = this.store.db.prepare('SELECT revision FROM private_inbox_sources WHERE account_id=? AND id=?').get(auth.account.id, item.envelope.sourceId)?.revision ?? 0;
      const state = this.store.connections.state(token, record.connectionId, 'INBOX', binding);
      this.store.connections.apply(token, { action: 'page.apply', requestId: randomUUID(), connectionId: record.connectionId, connectionRevision: c.profile.revision,
        folderId: 'INBOX', expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: 'gmail-recent:' + randomUUID(), complete: true, reset: true, observations }, binding);
      this.save(current, { ...record, usable: undefined, syncedAt: new Date(this.store.now()).toISOString() });
      return observations.length;
    });
  }
  disconnect(token, binding) {
    this.store.transaction(() => {
      const auth = this.auth(token, binding), record = this.record(auth);
      if (record) {
        const c = this.store.connections.connection(auth.account.id, record.connectionId);
        if (c && c.state !== 'disconnected') this.store.connections.apply(token, { action: 'connection.disconnect', requestId: randomUUID(), connectionId: record.connectionId, expectedRevision: c.profile.revision }, binding);
      }
      this.store.db.prepare('DELETE FROM gmail_mailboxes WHERE account_id=?').run(auth.account.id);
      this.store.db.prepare('DELETE FROM gmail_pending WHERE account_id=?').run(auth.account.id);
    });
  }
}
