// Read-only Microsoft Graph boundary. No token storage, HTTP routes, sends or
// persistence. The host supplies fresh, account-bound authorization per request.
import { emailConnection, emailOpaqueId, emailDigest } from './email-envelope.mjs';
import { normalizeGraphEmail, graphFolderChanges } from './graph-email.mjs';

const ORIGIN = 'https://graph.microsoft.com';
const MAX_BYTES = 2 * 1024 * 1024;
const fields = 'id,changeKey,conversationId,internetMessageId,parentFolderId,subject,sentDateTime,receivedDateTime,from,sender,replyTo,toRecipients,ccRecipients,bccRecipients,isDraft,isRead,body,internetMessageHeaders,hasAttachments';
export class GraphMailError extends Error {
  constructor(code, retryAfterSeconds = null) {
    super(code); this.name = 'GraphMailError'; this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const fail = code => { throw new GraphMailError(code); };
const segment = value => {
  emailOpaqueId(value);
  if (value === '.' || value === '..') fail('invalid_graph_resource');
  return encodeURIComponent(value);
};
function cursorUrl(value, path) {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/.test(value)) fail('invalid_graph_cursor');
  let url;
  try { url = new URL(value); } catch { fail('invalid_graph_cursor'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname !== path)
    fail('invalid_graph_cursor');
  return url.href;
}
async function jsonBounded(response) {
  if (!response.body) fail('invalid_graph_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); fail('graph_response_limit'); }
      chunks.push(value);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('invalid_graph_response'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('invalid_graph_response');
    return result;
  } finally { reader.releaseLock(); }
}

export class GraphMailReader {
  #connection; #authorize; #fetch; #now;
  constructor({ connection, authorize, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.#connection = emailConnection(connection);
    if (typeof authorize !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function')
      throw new TypeError('Authorization, fetch and clock functions are required');
    this.#authorize = authorize; this.#fetch = fetchImpl; this.#now = now;
  }
  async #request(url) {
    // Callback must authenticate the current local account and check that the
    // connection is active before returning a short-lived token. Never log it.
    let grant;
    try { grant = await this.#authorize(structuredClone(this.#connection)); }
    catch { fail('graph_authorization_required'); }
    if (!grant || grant.accountId !== this.#connection.accountId || grant.connectionId !== this.#connection.id
      || grant.connectionRevision !== this.#connection.revision || grant.mailboxId !== this.#connection.mailboxId
      || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.#now()
      || typeof grant.accessToken !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(grant.accessToken))
      fail('graph_authorization_required');
    try {
      const response = await this.#fetch(url, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json',
          Prefer: 'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=25' },
        signal: AbortSignal.timeout(15000) });
      if (response.status === 401 || response.status === 403) fail('graph_authorization_required');
      if (response.status === 410) fail('graph_resync_required');
      if (response.status === 404) fail('graph_resource_unavailable');
      if (response.status === 429 || response.status === 503) {
        const value = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(value ?? '') ? Math.min(Number(value), 86400) : null;
        throw new GraphMailError('graph_retry_later', seconds);
      }
      if (response.status !== 200) fail('graph_request_failed');
      return await jsonBounded(response);
    } catch (error) {
      if (error instanceof GraphMailError) throw error;
      // Provider bodies, cursor URLs, tokens and fetch error causes are private.
      fail('graph_request_failed');
    }
  }
  async #identity() {
    const identity = await this.#request(`${ORIGIN}/v1.0/me?$select=id`);
    if (identity.id !== this.#connection.mailboxId) fail('graph_mailbox_mismatch');
  }
  async #message(messageId) {
    const value = await this.#request(`${ORIGIN}/v1.0/me/messages/${segment(messageId)}?$select=${fields}`);
    if (value.id !== messageId) fail('graph_message_mismatch');
    try {
      // Attachments remain explicitly not_loaded; this client does not fetch
      // attachment bytes, remote HTML assets, or URLs embedded in messages.
      return normalizeGraphEmail(this.#connection, value, { idType: 'immutable' });
    } catch { fail('graph_message_unsupported'); }
  }
  async readMessage(messageId) {
    segment(messageId); await this.#identity();
    return this.#message(messageId);
  }
  async readFolderPage(folderId, cursor = null) {
    const path = `/v1.0/me/mailFolders/${segment(folderId)}/messages/delta`;
    const url = cursor === null ? `${ORIGIN}${path}?$select=id` : cursorUrl(cursor, path);
    await this.#identity();
    const page = await this.#request(url);
    let delta;
    try { delta = graphFolderChanges(this.#connection, folderId, page, { idType: 'immutable' }); }
    catch { fail('invalid_graph_response'); }
    cursorUrl(delta.cursor, path); // Validate before hydration or caller persistence.
    if (delta.changes.length > 25) fail('graph_page_limit');
    const messages = [];
    for (const change of delta.changes) {
      if (change.action === 'hydrate') messages.push(await this.#message(change.messageId));
    }
    // This is a read batch, NOT a committed sync checkpoint. The host must commit
    // all observations and the cursor atomically and recheck account authority.
    return { ...delta, messages, batchVersion: emailDigest({ delta, messages }) };
  }
}
