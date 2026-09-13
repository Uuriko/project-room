import PostalMime from 'postal-mime';
import { createEmailEnvelope, emailConnection, emailInput, emailOpaqueId, requireEmail, emailAddress } from './email-envelope.mjs';

export const gmailRawLimit = 1024 * 1024;
const address = value => emailAddress({ name: value?.name ?? '', address: value?.address });
const addresses = values => (values ?? []).flatMap(value => value.group ? value.group.map(address) : [address(value)]);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// format=RAW observation supplied by a trusted, mailbox-bound reader. Never fetches,
// renders HTML, persists attachment bytes, or claims to have scanned attachments.
export async function normalizeGmailEmail(connectionValue, message, { labelId = 'INBOX' } = {}) {
  emailInput({ connectionValue, message });
  const connection = emailConnection(connectionValue);
  requireEmail(connection.provider === 'gmail', 'invalid_email_connection');
  emailOpaqueId(labelId);
  requireEmail(Array.isArray(message?.labelIds) && message.labelIds.includes(labelId), 'gmail_label_changed');
  requireEmail(typeof message.raw === 'string' && message.raw.length > 0 && message.raw.length <= Math.ceil(gmailRawLimit * 4 / 3) + 4
    && /^[A-Za-z0-9_-]+={0,2}$/.test(message.raw), 'gmail_raw_required');
  const raw = Buffer.from(message.raw, 'base64url');
  requireEmail(raw.length <= gmailRawLimit && raw.toString('base64url') === message.raw.replace(/=+$/, ''), 'gmail_raw_invalid');
  requireEmail(typeof message.internalDate === 'string' && /^\d{1,16}$/.test(message.internalDate)
    && Number.isSafeInteger(Number(message.internalDate)) && Number.isFinite(new Date(Number(message.internalDate)).getTime()), 'gmail_date_invalid');
  let parsed;
  try {
    parsed = await PostalMime.parse(raw, { maxNestingDepth: 30, maxHeadersSize: 65536,
      maxRfc822NestingDepth: 0, forceRfc822Attachments: true });
  } catch { requireEmail(false, 'gmail_mime_invalid'); }
  finally { raw.fill(0); }
  for (const name of ['from', 'sender', 'subject', 'message-id', 'date'])
    requireEmail(parsed.headers.filter(header => header.key === name).length <= 1, 'gmail_ambiguous_header');
  const items = parsed.attachments.map((item, index) => ({
    id: `mime-${index}`, kind: item.mimeType === 'message/rfc822' ? 'item' : 'file',
    name: item.filename ?? '', contentType: item.mimeType, size: item.content.byteLength,
    inline: item.disposition === 'inline' || item.related === true, contentId: item.contentId ?? null
  }));
  // Byte content must never cross into the room/email contract, even for inline parts.
  for (const item of parsed.attachments) if (item.content instanceof ArrayBuffer) new Uint8Array(item.content).fill(0);
  const headers = name => parsed.headers.filter(header => header.key === name).map(header => header.value);
  return createEmailEnvelope({ connection,
    message: {
      id: message.id, revision: message.historyId, threadId: message.threadId,
      internetMessageId: parsed.messageId ?? null, folderId: labelId,
      subject: parsed.subject ?? '', sentAt: validDate(parsed.date), receivedAt: new Date(Number(message.internalDate)).toISOString(),
      from: address(parsed.from), sender: address(parsed.sender ?? parsed.from), replyTo: addresses(parsed.replyTo),
      to: addresses(parsed.to), cc: addresses(parsed.cc), bcc: addresses(parsed.bcc),
      isDraft: message.labelIds.includes('DRAFT'), isRead: !message.labelIds.includes('UNREAD')
    },
    body: typeof parsed.text === 'string' ? { format: 'text', content: parsed.text } : { format: 'html', content: parsed.html ?? '' },
    replyHeaders: { state: 'complete', inReplyTo: headers('in-reply-to'), references: headers('references') },
    attachments: { state: 'complete', hint: items.some(item => !item.inline), items }
  });
}
