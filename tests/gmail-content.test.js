// Focused unit tests for server/gmail-content.mjs (added wave1000 guild-15:
// the module had no direct test file; mutation M4 survived 16 tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailParts, projectGmailMessage, findGmailPart, attachmentBytes, gmailAttachmentLimit } from '../server/gmail-content.mjs';

test('gmailParts classifies filename/attachmentId parts as attachments, inline text as text (M4)', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('hello').toString('base64url') } },
    { filename: 'notes.txt', mimeType: 'text/plain', body: { attachmentId: 'att-1', size: 100 } },
    { mimeType: 'application/pdf', body: { attachmentId: 'att-2', size: 200 } },
  ]};
  const r = gmailParts(payload);
  assert.equal(r.text.length, 1);
  assert.deepEqual(r.attachments.map(a => a.name).sort(), ['Attachment', 'notes.txt']);
});

test('gmailParts: text part with only an attachmentId (no filename) is not an attachment (M4)', () => {
  // Pins the current contract: such parts are dropped from the projection.
  // (Whether dropping is ideal is a product question; the test pins behavior.)
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { attachmentId: 'att-1', size: 100 } },
  ]};
  const r = gmailParts(payload);
  assert.equal(r.text.length, 0);
  assert.equal(r.attachments.length, 0);
});

test('findGmailPart rejects malformed part ids and missing bodies', () => {
  const payload = { parts: [{ body: { attachmentId: 'a' } }] };
  assert.throws(() => findGmailPart(payload, '../0'), { code: 'gmail_invalid_attachment' });
  assert.throws(() => findGmailPart(payload, '0.999999'), { code: 'gmail_invalid_attachment' });
  assert.equal(findGmailPart(payload, '0.0').body.attachmentId, 'a');
});

test('attachmentBytes enforces base64url shape and the 10 MiB cap', () => {
  assert.throws(() => attachmentBytes({ data: '!!!not-base64!!!' }), { code: 'gmail_invalid_attachment' });
  assert.throws(() => attachmentBytes({ data: 'a'.repeat(Math.ceil(gmailAttachmentLimit * 4 / 3) + 5) }), { code: 'gmail_invalid_attachment' });
  const ok = attachmentBytes({ data: Buffer.from('hi').toString('base64url') });
  assert.equal(ok.toString(), 'hi');
});

test('projectGmailMessage projects headers and marks editability', () => {
  const message = { id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'snip',
    payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@b.c' }],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('body').toString('base64url') } }] } };
  const p = projectGmailMessage(message);
  assert.equal(p.subject, 'Hi');
  assert.equal(p.body, 'body');
  assert.equal(p.editable, true);
});
