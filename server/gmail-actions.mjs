// Owner-only live Gmail operations. Private bodies never enter the operation journal.
import { createHash } from 'node:crypto';
import { ServiceError } from './store.mjs';
import { htmlToText } from './mime-message.mjs';
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
const scope = 'https://www.googleapis.com/auth/gmail.modify';
const fail = (code, message, status = 422) => { throw new ServiceError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = v => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
const header = (message, name) => message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const clean = v => typeof v === 'string' && v.length <= 4096 && !/[\r\n\0]/.test(v);
function addresses(value, required = false) {
  if (typeof value !== 'string' || value.length > 4096) fail('gmail_invalid_address', 'Enter email addresses separated by commas.');
  const list = value.split(',').map(v => v.trim()).filter(Boolean);
  if (list.length > 50 || required && !list.length || list.some(v => !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v))) fail('gmail_invalid_address', 'Enter plain email addresses separated by commas.');
  return list.join(', ');
}
function parts(payload, result = { text: [], html: [], attachments: [] }) {
  if (!payload) return result;
  if (payload.filename || payload.body?.attachmentId) result.attachments.push({ name: payload.filename || 'Attachment', size: payload.body?.size ?? 0 });
  else if (payload.body?.data && ['text/plain', 'text/html'].includes(payload.mimeType)) result[payload.mimeType === 'text/plain' ? 'text' : 'html'].push(Buffer.from(payload.body.data, 'base64url').toString('utf8'));
  for (const p of payload.parts ?? []) parts(p, result);
  return result;
}
function project(message, draftId = null) {
  const p = parts(message.payload);
  return { id: message.id, threadId: message.threadId, draftId, from: header(message, 'From'), to: header(message, 'To'), cc: header(message, 'Cc'), bcc: header(message, 'Bcc'), subject: header(message, 'Subject'), date: header(message, 'Date'), labels: message.labelIds ?? [], snippet: message.snippet ?? '',
    body: p.text.length ? p.text.join('\n\n') : htmlToText(p.html.join('\n')), attachments: p.attachments,
    editable: p.attachments.length === 0 && p.html.length === 0 && p.text.length === 1 };
}
export class GmailActions {
  constructor(mailbox) { this.mailbox = mailbox; this.store = mailbox.store; }
  async context(token, binding, write) {
    const m = this.mailbox, auth = m.auth(token, binding), record = m.record(auth);
    if (!record?.usable || record.reconnectRequired) fail('gmail_reconnect_required', 'Reconnect Gmail to continue.');
    if (write && !record.scopes?.includes(scope)) fail('gmail_write_permission_required', 'Reconnect Gmail to allow sending and organizing mail.');
    const check = () => {
      const next = m.auth(token, binding), latest = m.record(next);
      if (next.account.id !== auth.account.id || next.sessionRevision !== auth.sessionRevision || !latest?.usable || latest.refreshToken !== record.refreshToken) fail('gmail_session_changed', 'Your Gmail connection changed.');
    };
    const tokens = await m.exchange({ refresh_token: record.refreshToken, grant_type: 'refresh_token' }); check();
    if (!tokens.access_token) fail('gmail_reconnect_required', 'Reconnect Gmail to continue.');
    const request = async (path, method = 'GET', body) => {
      check();
      const result = await m.json(base + path, { method, headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      check(); return result;
    };
    return { auth, record, check, request };
  }
  async run(token, binding, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('gmail_invalid_action', 'Choose a Gmail action.');
    const { action } = input;
    if (!['list', 'read', 'save', 'send', 'archive', 'inbox', 'trash', 'untrash', 'read-mark', 'unread', 'star', 'unstar'].includes(action)) fail('gmail_invalid_action', 'Choose a Gmail action.');
    const write = !['list', 'read'].includes(action);
    const c = await this.context(token, binding, write);
    if (action === 'list') {
      const folders = { inbox: 'INBOX', sent: 'SENT', starred: 'STARRED', trash: 'TRASH', all: null, drafts: 'DRAFT' };
      if (!Object.hasOwn(folders, input.folder) || typeof input.query !== 'string' || input.query.length > 500 || input.pageToken != null && (typeof input.pageToken !== 'string' || input.pageToken.length > 2048)) fail('gmail_invalid_query', 'Choose a folder and search.');
      const q = new URLSearchParams({ maxResults: '25' });
      if (input.query) q.set('q', input.query);
      if (input.pageToken) q.set('pageToken', input.pageToken);
      if (folders[input.folder] && input.folder !== 'drafts') q.set('labelIds', folders[input.folder]);
      if (input.folder === 'trash') q.set('includeSpamTrash', 'true');
      const draft = input.folder === 'drafts', list = await c.request((draft ? '/drafts?' : '/messages?') + q);
      const entries = (draft ? list.drafts : list.messages) ?? [];
      if (!Array.isArray(entries) || entries.length > 25) fail('gmail_invalid_response', 'Gmail returned an invalid page.', 502);
      const messages = [];
      for (const row of entries) {
        if (!validId(row.id)) fail('gmail_invalid_response', 'Gmail returned an invalid message.', 502);
        const data = await c.request((draft ? '/drafts/' : '/messages/') + row.id + '?format=metadata');
        const message = draft ? data.message : data;
        if (!message || !validId(message.id)) fail('gmail_invalid_response', 'Gmail returned an invalid message.', 502);
        messages.push(project(message, draft ? row.id : null));
      }
      return { messages, nextPageToken: list.nextPageToken ?? null };
    }
    if (action === 'read') {
      if (!validId(input.id) || input.draftId != null && !validId(input.draftId)) fail('gmail_invalid_message', 'Choose a message.');
      const data = await c.request(input.draftId ? '/drafts/' + input.draftId + '?format=full' : '/messages/' + input.id + '?format=full');
      const message = input.draftId ? data.message : data;
      return { message: project(message, input.draftId ?? null) };
    }
    if (!validId(input.requestId)) fail('gmail_invalid_request', 'A request identifier is required.');
    const fingerprint = digest(JSON.stringify(input)), db = this.store.db, accountId = c.auth.account.id;
    const previous = db.prepare('SELECT * FROM gmail_operations WHERE account_id=? AND request_id=?').get(accountId, input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('gmail_request_conflict', 'This request was already used.');
      return JSON.parse(previous.result_json);
    }
    let path, method = 'POST', data;
    if (action === 'save' || action === 'send') {
      const to = addresses(input.to, action === 'send'), cc = addresses(input.cc ?? ''), bcc = addresses(input.bcc ?? '');
      if (!clean(input.subject) || typeof input.body !== 'string' || input.body.length > 100000 || !input.body.isWellFormed()) fail('gmail_invalid_message', 'Use a subject and message under 100,000 characters.');
      if (input.draftId != null && !validId(input.draftId) || input.replyId != null && !validId(input.replyId)) fail('gmail_invalid_message', 'Choose a valid draft or reply.');
      let threadId, replyHeaders = '';
      if (input.replyId) {
        const original = await c.request('/messages/' + input.replyId + '?format=metadata');
        const messageId = header(original, 'Message-ID'), references = header(original, 'References');
        if (!clean(messageId) || !/^<[^<>\s]+>$/.test(messageId) || !clean(references)) fail('gmail_invalid_reply', 'This message cannot be threaded safely.');
        threadId = original.threadId;
        if (input.subject.replace(/^re:\s*/i, '') !== header(original, 'Subject').replace(/^re:\s*/i, '')) fail('gmail_invalid_reply', 'Keep the original subject when replying.');
        replyHeaders = `In-Reply-To: ${messageId}\r\nReferences: ${references ? references + ' ' : ''}${messageId}\r\n`;
      }
      if (input.draftId) {
        const draft = await c.request('/drafts/' + input.draftId + '?format=full');
        if (draft.message?.id !== input.expectedMessageId) fail('gmail_draft_changed', 'This draft changed in Gmail. Reopen it before editing.');
        if (!project(draft.message).editable) fail('gmail_draft_unsupported', 'Edit this formatted draft or its attachments in Gmail.');
        // Preserve threading when reopening a provider draft.
        if (!input.replyId) {
          const inReplyTo = header(draft.message, 'In-Reply-To'), refs = header(draft.message, 'References');
          if (inReplyTo) {
            if (!clean(inReplyTo) || !clean(refs)) fail('gmail_invalid_reply', 'Invalid reply headers.');
            threadId = draft.message.threadId;
            replyHeaders = `In-Reply-To: ${inReplyTo}\r\nReferences: ${refs}\r\n`;
          }
        }
      }
      const raw = Buffer.from(`From: ${c.record.address}\r\nTo: ${to}\r\nCc: ${cc}\r\nBcc: ${bcc}\r\nSubject: =?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=\r\nMessage-ID: <${digest(accountId + ':' + input.requestId)}@project-room.invalid>\r\n${replyHeaders}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(input.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''}\r\n`).toString('base64url');
      const message = { raw, ...(threadId ? { threadId } : {}) };
      path = action === 'save' ? '/drafts' + (input.draftId ? '/' + input.draftId : '') : input.draftId ? '/drafts/send' : '/messages/send';
      method = action === 'save' && input.draftId ? 'PUT' : 'POST';
      data = action === 'save' || input.draftId ? { ...(input.draftId ? { id: input.draftId } : {}), message } : message;
    } else {
      if (!validId(input.id)) fail('gmail_invalid_message', 'Choose a message.');
      const labels = { archive: [[], ['INBOX']], inbox: [['INBOX'], []], 'read-mark': [[], ['UNREAD']], unread: [['UNREAD'], []], star: [['STARRED'], []], unstar: [[], ['STARRED']] };
      path = '/messages/' + input.id + (action === 'trash' || action === 'untrash' ? '/' + action : '/modify');
      if (labels[action]) data = { addLabelIds: labels[action][0], removeLabelIds: labels[action][1] };
    }
    c.check();
    // Reserve before the external side effect. A crash/timeout stays unknown;
    // replay never repeats the provider request, including after a restart.
    const reserved = this.store.transaction(() => {
      const existing = db.prepare('SELECT * FROM gmail_operations WHERE account_id=? AND request_id=?').get(accountId, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('gmail_request_conflict', 'This request was already used.');
        return JSON.parse(existing.result_json);
      }
      db.prepare('INSERT INTO gmail_operations VALUES(?,?,?,?,?)').run(accountId, input.requestId, fingerprint, JSON.stringify({ state: 'unknown' }), this.store.now());
      return null;
    });
    if (reserved) return reserved;
    let result;
    try {
      const response = await c.request(path, method, data);
      if (!validId(response.id)) throw new Error('Missing provider receipt');
      result = { state: 'accepted', id: response.id, messageId: response.message?.id ?? response.id };
    } catch { result = { state: 'unknown' }; }
    // This row belongs to the original account even if the browser changed.
    db.prepare('UPDATE gmail_operations SET result_json=? WHERE account_id=? AND request_id=?').run(JSON.stringify(result), accountId, input.requestId);
    c.check(); return result;
  }
}
