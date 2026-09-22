// Owner-only live Gmail operations. Private bodies never enter the operation journal.
import { createHash } from 'node:crypto';
import { ServiceError } from './store.mjs';
import { gmailHeader as header, projectGmailMessage as project, findGmailPart, attachmentBytes, gmailAttachmentLimit, gmailMimeBody } from './gmail-content.mjs';
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
const scope = 'https://www.googleapis.com/auth/gmail.modify';
const fail = (code, message, status = 422) => { throw new ServiceError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = v => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
const clean = v => typeof v === 'string' && v.length <= 4096 && !/[\r\n\0]/.test(v);
function addresses(value, required = false) {
  if (typeof value !== 'string' || value.length > 4096) fail('gmail_invalid_address', 'Enter email addresses separated by commas.');
  const list = value.split(',').map(v => v.trim()).filter(Boolean);
  if (list.length > 50 || required && !list.length || list.some(v => !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v))) fail('gmail_invalid_address', 'Enter plain email addresses separated by commas.');
  return list.join(', ');
}
export class GmailActions {
  constructor(mailbox) { this.mailbox = mailbox; this.store = mailbox.store; }
  async context(token, binding, write, mailboxId = null) {
    const m = this.mailbox, auth = m.auth(token, binding), record = m.record(auth, mailboxId);
    if (!record?.usable || record.reconnectRequired) fail('gmail_reconnect_required', 'Reconnect Gmail to continue.');
    if (write && !record.scopes?.includes(scope)) fail('gmail_write_permission_required', 'Reconnect Gmail to allow sending and organizing mail.');
    const revision = this.store.connections.connection(auth.account.id, record.connectionId).profile.revision;
    const check = () => {
      const next = m.auth(token, binding), latest = m.record(next, record.connectionId);
      if (next.account.id !== auth.account.id || next.sessionRevision !== auth.sessionRevision || !latest?.usable || latest.refreshToken !== record.refreshToken || this.store.connections.connection(auth.account.id, record.connectionId)?.profile.revision !== revision) fail('gmail_session_changed', 'Your Gmail connection changed.');
    };
    const tokens = await m.exchange({ refresh_token: record.refreshToken, grant_type: 'refresh_token' }); check();
    if (write && tokens.scope && !tokens.scope.split(/\s+/).includes(scope)) fail('gmail_write_permission_required', 'Reconnect Gmail to allow sending and organizing mail.');
    if (!tokens.access_token) fail('gmail_reconnect_required', 'Reconnect Gmail to continue.');
    const request = async (path, method = 'GET', body) => {
      check();
      const result = await m.json(base + path, { method, headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      check(); return result;
    };
    return { auth, record, check, request };
  }
  async attachment(c, message, partId) {
    const part = findGmailPart(message.payload, partId);
    if ((part.body.size ?? 0) > gmailAttachmentLimit) fail('gmail_attachment_too_large', 'This attachment exceeds 10 MiB.');
    let data = part.body.data;
    if (part.body.attachmentId) {
      if (typeof part.body.attachmentId !== 'string' || part.body.attachmentId.length > 2048) fail('gmail_invalid_attachment', 'Invalid attachment.');
      data = (await c.request('/messages/' + message.id + '/attachments/' + encodeURIComponent(part.body.attachmentId))).data;
    }
    return { name: part.filename || 'Attachment', type: part.mimeType || 'application/octet-stream', bytes: attachmentBytes({ data }) };
  }
  async hydrate(c, message) {
    let total = 0;
    const walk = async part => {
      if (!part) return;
      if (!part.filename && ['text/plain', 'text/html'].includes(part.mimeType) && part.body?.attachmentId && !part.body.data) {
        const file = await this.attachment(c, { id: message.id, payload: part }, '0');
        total += file.bytes.length;
        if (total > gmailAttachmentLimit) fail('gmail_attachment_too_large', 'Message text exceeds 10 MiB.');
        part.body.data = file.bytes.toString('base64url');
      }
      for (const child of part.parts ?? []) await walk(child);
    };
    await walk(message.payload); return message;
  }
  async reconcile(c, requestId, previous) {
    if (previous.state !== 'unknown' || !['send', 'save'].includes(previous.action) || previous.mailboxId !== c.record.connectionId || !previous.messageKey) return previous;
    try {
      const draft = previous.action === 'save', q = encodeURIComponent((draft ? '' : 'in:sent ') + 'rfc822msgid:' + previous.messageKey);
      const found = await c.request((draft ? '/drafts?' : '/messages?') + 'maxResults=10&q=' + q);
      const rows = (draft ? found.drafts : found.messages) ?? [];
      for (const row of rows) {
        if (!validId(row.id)) continue;
        const resource = await c.request((draft ? '/drafts/' : '/messages/') + row.id + '?format=metadata');
        const message = draft ? resource.message : resource;
        if (header(message, 'Message-ID') !== '<' + previous.messageKey + '>') continue;
        const result = { state: 'accepted', id: draft ? row.id : message.id, messageId: message.id };
        this.store.db.prepare('UPDATE gmail_operations SET result_json=? WHERE account_id=? AND request_id=?').run(JSON.stringify(result), c.auth.account.id, requestId);
        return result;
      }
    } catch { /* Missing evidence never authorizes a second send. */ }
    return previous;
  }
  async run(token, binding, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('gmail_invalid_action', 'Choose a Gmail action.');
    const { action } = input;
    const allowed = ['action', 'requestId', 'id', 'draftId', 'expectedMessageId', 'replyId', 'folder', 'query', 'pageToken', 'to', 'cc', 'bcc', 'subject', 'body', 'html', 'attachments', 'mailboxId', 'partId', 'threadId'];
    if (Object.keys(input).some(k => !allowed.includes(k))) fail('gmail_invalid_message', 'Unsupported Gmail message fields.');
    if (!['list', 'read', 'attachment', 'thread', 'save', 'draft-delete', 'send', 'archive', 'inbox', 'trash', 'untrash', 'read-mark', 'unread', 'star', 'unstar'].includes(action)) fail('gmail_invalid_action', 'Choose a Gmail action.');
    const write = !['list', 'read', 'attachment', 'thread'].includes(action);
    if (input.mailboxId != null && !validId(input.mailboxId)) fail('gmail_invalid_mailbox', 'Choose a connected Gmail account.');
    const c = await this.context(token, binding, write, input.mailboxId);
    if (action === 'thread') {
      if (!validId(input.threadId)) fail('gmail_invalid_message', 'Choose a conversation.');
      const thread = await c.request('/threads/' + input.threadId + '?format=full');
      const messages = []; for (const message of thread.messages ?? []) messages.push(project(await this.hydrate(c, message)));
      return { messages };
    }
    if (action === 'attachment') {
      if (!validId(input.id)) fail('gmail_invalid_message', 'Choose a message.');
      const message = await c.request('/messages/' + input.id + '?format=full');
      const attachment = await this.attachment(c, message, input.partId);
      return { attachment: { name: attachment.name, type: attachment.type, data: attachment.bytes.toString('base64url') } };
    }
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
      return { message: project(await this.hydrate(c, message), input.draftId ?? null) };
    }
    if (!validId(input.requestId)) fail('gmail_invalid_request', 'A request identifier is required.');
    const fingerprint = digest(JSON.stringify(input)), db = this.store.db, accountId = c.auth.account.id;
    const previous = db.prepare('SELECT * FROM gmail_operations WHERE account_id=? AND request_id=?').get(accountId, input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('gmail_request_conflict', 'This request was already used.');
      return this.reconcile(c, input.requestId, JSON.parse(previous.result_json));
    }
    let path, method = 'POST', data;
    const messageKey = digest(accountId + ':' + c.record.connectionId + ':' + input.requestId) + '@project-room.invalid';
    if (action === 'save' || action === 'send') {
      const to = addresses(input.to, action === 'send'), cc = addresses(input.cc ?? ''), bcc = addresses(input.bcc ?? '');
      if (input.html != null && (typeof input.html !== 'string' || input.html.length > 200000)) fail('gmail_invalid_message', 'Formatted message is too large.');
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
        const draftView = project(draft.message);
        if (draftView.attachments.length && !Array.isArray(input.attachments) || draftView.html && typeof input.html !== 'string') fail('gmail_attachment_review_required', 'Reopen the draft and review its formatting and attachments.');
        if (!draftView.editable) fail('gmail_draft_unsupported', 'This draft format cannot be edited.');
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
      const encodedSubject = Array.from(input.subject).reduce((chunks, ch) => { if (!chunks.length || Buffer.byteLength(chunks.at(-1) + ch) > 42) chunks.push(ch); else chunks[chunks.length - 1] += ch; return chunks; }, []).map(s => '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=').join('\r\n ');
      const foldAddresses = value => value.replaceAll(', ', ',\r\n ');
      const files = input.attachments ?? [];
      if (!Array.isArray(files) || files.length > 20) fail('gmail_invalid_attachment', 'Choose at most 20 attachments.');
      const attachments = []; let total = 0;
      const sourceMessages = new Map();
      for (const file of files) {
        let attachment;
        if (file && validId(file.messageId)) {
          if (!sourceMessages.has(file.messageId)) sourceMessages.set(file.messageId, await c.request('/messages/' + file.messageId + '?format=full'));
          attachment = await this.attachment(c, sourceMessages.get(file.messageId), file.partId);
        } else {
          if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255) fail('gmail_invalid_attachment', 'Attachment needs a filename.');
          attachment = { name: file.name, type: file.type, bytes: attachmentBytes(file) };
        }
        total += attachment.bytes.length;
        if (total > gmailAttachmentLimit) fail('gmail_attachment_too_large', 'Attachments must total 10 MiB or less.');
        attachments.push(attachment);
      }
      const raw = Buffer.from(`From: ${c.record.address}\r\nTo: ${foldAddresses(to)}\r\nCc: ${foldAddresses(cc)}\r\nBcc: ${foldAddresses(bcc)}\r\nSubject: ${encodedSubject}\r\nMessage-ID: <${messageKey}>\r\n${replyHeaders}MIME-Version: 1.0\r\n${gmailMimeBody(input.body, input.html, attachments)}`).toString('base64url');
      const message = { raw, ...(threadId ? { threadId } : {}) };
      path = action === 'save' ? '/drafts' + (input.draftId ? '/' + input.draftId : '') : input.draftId ? '/drafts/send' : '/messages/send';
      method = action === 'save' && input.draftId ? 'PUT' : 'POST';
      data = action === 'save' || input.draftId ? { ...(input.draftId ? { id: input.draftId } : {}), message } : message;
    } else if (action === 'draft-delete') {
      if (!validId(input.draftId)) fail('gmail_invalid_message', 'Choose a draft.');
      const draft = await c.request('/drafts/' + input.draftId + '?format=full');
      if (draft.message?.id !== input.expectedMessageId) fail('gmail_draft_changed', 'This draft changed in Gmail. Reopen it.');
      path = '/drafts/' + input.draftId; method = 'DELETE';
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
      db.prepare('INSERT INTO gmail_operations VALUES(?,?,?,?,?)').run(accountId, input.requestId, fingerprint, JSON.stringify({ state: 'unknown', action, mailboxId: c.record.connectionId, messageKey }), this.store.now());
      return null;
    });
    if (reserved) return reserved;
    let result;
    try {
      const response = await c.request(path, method, data);
      if (action === 'draft-delete') response.id = input.draftId;
      if (!validId(response.id)) throw new Error('Missing provider receipt');
      result = { state: 'accepted', id: response.id, messageId: response.message?.id ?? response.id };
    } catch { result = { state: 'unknown', action, mailboxId: c.record.connectionId, messageKey }; }
    // This row belongs to the original account even if the browser changed.
    db.prepare('UPDATE gmail_operations SET result_json=? WHERE account_id=? AND request_id=?').run(JSON.stringify(result), accountId, input.requestId);
    c.check(); return result;
  }
}
