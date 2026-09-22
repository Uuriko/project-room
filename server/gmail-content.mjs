import sanitizeHtml from './vendor/gmail-html-sanitizer.mjs';
import { randomBytes } from 'node:crypto';
import { ServiceError } from './store.mjs';
import { htmlToText } from './mime-message.mjs';
export const gmailAttachmentLimit = 10 * 1024 * 1024;
const fail = (code, message) => { throw new ServiceError(422, code, message); };
export const safeGmailHtml = value => sanitizeHtml(value, {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'div', 'sub', 'sup'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] }, allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  enforceHtmlBoundary: true
});
export const gmailHeader = (m, name) => m.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
export function gmailParts(payload, result = { text: [], html: [], attachments: [] }, path = '0') {
  if (!payload) return result;
  if (payload.filename || payload.body?.attachmentId && !['text/plain', 'text/html'].includes(payload.mimeType)) result.attachments.push({ name: payload.filename || 'Attachment', size: payload.body?.size ?? 0, type: payload.mimeType || 'application/octet-stream', partId: path });
  else if (payload.body?.data && ['text/plain', 'text/html'].includes(payload.mimeType)) result[payload.mimeType === 'text/plain' ? 'text' : 'html'].push(Buffer.from(payload.body.data, 'base64url').toString('utf8'));
  for (let i = 0; i < (payload.parts?.length ?? 0); i++) gmailParts(payload.parts[i], result, path + '.' + i);
  return result;
}
export function projectGmailMessage(message, draftId = null) {
  const p = gmailParts(message.payload), html = safeGmailHtml(p.html.join('\n'));
  return { id: message.id, threadId: message.threadId, draftId, from: gmailHeader(message, 'From'), replyTo: gmailHeader(message, 'Reply-To'), to: gmailHeader(message, 'To'), cc: gmailHeader(message, 'Cc'), bcc: gmailHeader(message, 'Bcc'), subject: gmailHeader(message, 'Subject'), date: gmailHeader(message, 'Date'), labels: message.labelIds ?? [], snippet: message.snippet ?? '',
    body: p.text.length ? p.text.join('\n\n') : htmlToText(html), html, attachments: p.attachments,
    editable: p.text.length + p.html.length > 0 || p.attachments.length > 0 };
}
export function findGmailPart(payload, id) {
  if (typeof id !== 'string' || !/^0(?:\.\d{1,3}){0,20}$/.test(id)) fail('gmail_invalid_attachment', 'Choose an attachment from this message.');
  let part = payload;
  for (const index of id.split('.').slice(1)) part = part?.parts?.[Number(index)];
  if (!part || !part.body || !(part.filename || part.body.attachmentId)) fail('gmail_invalid_attachment', 'Attachment is unavailable.');
  return part;
}
export function attachmentBytes(value) {
  if (!value || typeof value.data !== 'string' || value.data.length > Math.ceil(gmailAttachmentLimit * 4 / 3) + 4 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value.data)) fail('gmail_invalid_attachment', 'Attachment data is invalid or exceeds 10 MiB.');
  const bytes = Buffer.from(value.data, 'base64url');
  if (bytes.length > gmailAttachmentLimit) fail('gmail_attachment_too_large', 'Attachments must total 10 MiB or less.');
  return bytes;
}
const b64 = bytes => Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
export function gmailMimeBody(body, html, attachments) {
  const text = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body.replace(/\r?\n/g, '\r\n'))}\r\n`;
  const boundary = () => 'room_' + randomBytes(18).toString('hex');
  const multipart = (type, parts) => { const id = boundary(); return `Content-Type: multipart/${type}; boundary="${id}"\r\n\r\n` + parts.map(p => `--${id}\r\n${p}`).join('') + `--${id}--\r\n`; };
  let content = html ? multipart('alternative', [text, `Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(safeGmailHtml(html))}\r\n`]) : text;
  if (attachments.length) content = multipart('mixed', [content, ...attachments.map(a => {
    const filename = encodeURIComponent(a.name.replace(/[\r\n\0/\\]/g, '_')).replaceAll("'", '%27');
    const type = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(a.type ?? '') ? a.type : 'application/octet-stream';
    return `Content-Type: ${type}\r\nContent-Disposition: attachment; filename*=UTF-8''${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.bytes)}\r\n`;
  })]);
  return content;
}
