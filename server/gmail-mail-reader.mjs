import { emailConnection } from './email-envelope.mjs';
import { normalizeGmailEmail } from './gmail-email.mjs';
import { GMAIL_READ_SCOPE } from './gmail-oauth.mjs';

const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
const fail = code => { throw new GmailReadError(code); };
export class GmailReadError extends Error {
  constructor(code) { super(code); this.name = 'GmailReadError'; this.code = code; }
}
const resource = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const cursor = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_+\/=.-]{1,8192}$/.test(value);

// One bounded page per invocation. Host owns account auth, token refresh, scheduling,
// connection revocation and atomic import/cursor persistence. No send capability.
export class GmailMailReader {
  #connection; #epoch; #authorize; #fetch; #now;
  constructor({ connection, authEpoch, authorize, fetchImpl = fetch, now = Date.now }) {
    this.#connection = emailConnection(connection);
    if (connection.provider !== 'gmail' || !Number.isSafeInteger(authEpoch) || authEpoch < 0
      || typeof authorize !== 'function') fail('gmail_reader_configuration_invalid');
    this.#epoch = authEpoch; this.#authorize = authorize; this.#fetch = fetchImpl; this.#now = now;
  }
  async #grant() {
    let grant;
    try { grant = await this.#authorize(structuredClone(this.#connection)); }
    catch { fail('gmail_read_authorization_required'); }
    if (!grant || grant.accountId !== this.#connection.accountId || grant.connectionId !== this.#connection.id
      || grant.connectionRevision !== this.#connection.revision || grant.mailboxId !== this.#connection.mailboxId
      || grant.authEpoch !== this.#epoch || grant.scope !== GMAIL_READ_SCOPE
      || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.#now()
      || typeof grant.accessToken !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,8192}=*$/.test(grant.accessToken))
      fail('gmail_read_authorization_required');
    return grant;
  }
  async #get(url) {
    const grant = await this.#grant();
    try {
      const response = await this.#fetch(url, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        await response.body?.cancel();
        fail(response.status === 401 || response.status === 403 ? 'gmail_read_authorization_required'
          : response.status === 404 ? 'gmail_message_changed'
          : response.status === 429 || response.status >= 500 ? 'gmail_read_retry_later' : 'gmail_read_provider_rejected');
      }
      if (!response.body) fail('gmail_read_invalid_response');
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('gmail_read_response_limit'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('gmail_read_invalid_response');
      await this.#grant();
      return data;
    } catch (error) {
      if (error instanceof GmailReadError) throw error;
      fail('gmail_read_unavailable');
    }
  }
  async readPage({ labelId = 'INBOX', pageToken = null } = {}) {
    if (!resource(labelId) || !cursor(pageToken)) fail('gmail_read_invalid_request');
    const identity = await this.#get(`${base}/profile`);
    if (typeof identity.emailAddress !== 'string' || identity.emailAddress.toLowerCase() !== this.#connection.mailboxId.toLowerCase())
      fail('gmail_read_mailbox_mismatch');
    const url = new URL(`${base}/messages`);
    url.search = new URLSearchParams({ labelIds: labelId, maxResults: '25', includeSpamTrash: 'false',
      ...(pageToken === null ? {} : { pageToken }) }).toString();
    const page = await this.#get(url.href);
    const nextPageToken = page.nextPageToken ?? null;
    if (!cursor(nextPageToken) || nextPageToken !== null && nextPageToken === pageToken
      || !Array.isArray(page.messages ?? []) || (page.messages ?? []).length > 25) fail('gmail_read_invalid_page');
    const messages = page.messages ?? [];
    if (messages.some(message => !resource(message?.id)) || new Set(messages.map(message => message.id)).size !== messages.length)
      fail('gmail_read_invalid_page');
    const observations = [];
    for (const message of messages) {
      const hydrated = await this.#get(`${base}/messages/${message.id}?format=raw`);
      if (hydrated.id !== message.id) fail('gmail_read_message_mismatch');
      let envelope;
      try { envelope = await normalizeGmailEmail(this.#connection, hydrated, { labelId }); }
      catch { fail('gmail_read_message_unavailable'); }
      observations.push({ kind: 'message', envelope });
    }
    await this.#grant();
    // Never skip failed hydration and advance a cursor. The host adds source revision
    // preconditions and commits the whole page, or discards it on authority changes.
    return { connection: structuredClone(this.#connection), labelId, observations, nextPageToken, complete: nextPageToken === null };
  }
}
