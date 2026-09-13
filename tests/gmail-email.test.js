import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { normalizeGmailEmail, gmailRawLimit } from '../server/gmail-email.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { emailSourceId } from '../server/email-envelope.mjs';
import { normalizeGraphEmail, graphFolderChanges } from '../server/graph-email.mjs';
import { GraphMailReader } from '../server/graph-mail-reader.mjs';

const connection = { accountId: 'account-a', id: 'gmail-a', revision: 1, provider: 'gmail', mailboxId: 'pilot@example.com', identity: { name: 'Pilot', address: 'pilot@example.com' }, aliases: [] };
const headers = ['From: "Doe, Jane" <jane@example.com>', 'To: Pilot <pilot@example.com>', 'Subject: =?UTF-8?B?SGVsbG8g8J+YgA==?=', 'Date: Sat, 12 Sep 2026 12:00:00 +0000', 'Message-ID: <hello@example.com>', 'MIME-Version: 1.0'];
const message = (mime = [...headers, 'Content-Type: text/plain; charset=utf-8', '', 'Private note'].join('\r\n')) => ({
  id: 'abc123', historyId: '123456', threadId: 'thread123', labelIds: ['INBOX', 'UNREAD'], internalDate: '1789214400000', raw: Buffer.from(mime).toString('base64url')
});

test('Gmail connections cannot enter Graph provider boundaries', () => {
  assert.throws(() => normalizeGraphEmail(connection, {}), { code: 'invalid_email_connection' });
  assert.throws(() => graphFolderChanges(connection, 'INBOX', {}), { code: 'invalid_email_connection' });
  assert.throws(() => new GraphMailReader({ connection, authorize: () => {} }), { code: 'invalid_graph_provider' });
});

test('normalizes Gmail IDs, Unicode headers, quoted addresses and read state', async () => {
  const result = await normalizeGmailEmail(connection, message());
  assert.equal(result.connection.provider, 'gmail');
  assert.equal(result.message.from.name, 'Doe, Jane');
  assert.equal(result.message.subject, 'Hello 😀');
  assert.equal(result.message.isRead, false);
  assert.equal(result.body.content.trim(), 'Private note');
  assert.notEqual(result.sourceId, emailSourceId({ ...connection, provider: 'microsoft-graph' }, 'abc123'));
});

test('multipart alternative prefers text; attachment bytes and HTML do not enter text envelope', async () => {
  const mime = [...headers, 'Content-Type: multipart/mixed; boundary=outer', '', '--outer',
    'Content-Type: multipart/alternative; boundary=inner', '', '--inner', 'Content-Type: text/plain', '', 'Useful text',
    '--inner', 'Content-Type: text/html', '', '<script>HTML_SECRET</script>', '--inner--', '--outer',
    'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="report.bin"',
    'Content-Transfer-Encoding: base64', '', Buffer.from('ATTACHMENT_SECRET').toString('base64'), '--outer--'].join('\r\n');
  const result = await normalizeGmailEmail(connection, message(mime));
  assert.equal(result.body.format, 'text'); assert.equal(result.body.content.trim(), 'Useful text');
  assert.equal(result.attachments.items[0].name, 'report.bin');
  assert.equal(result.attachments.items[0].size, 17);
  assert.ok(!JSON.stringify(result).includes('ATTACHMENT_SECRET'));
  assert.ok(!JSON.stringify(result).includes('HTML_SECRET'));
});

test('HTML-only mail stays marked HTML and missing sent dates remain unknown', async () => {
  const raw = ['From: jane@example.com', 'Content-Type: text/html', '', '<img src="https://example.com/tracker">'].join('\r\n');
  const result = await normalizeGmailEmail(connection, message(raw));
  assert.equal(result.body.format, 'html'); assert.equal(result.message.sentAt, null);
});

test('attached emails are objects, not silently expanded private context', async () => {
  const raw = [...headers, 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'Outer note',
    '--b', 'Content-Type: message/rfc822', '', 'From: nested-secret@example.com', 'Subject: NESTED_SECRET', '', 'NESTED_BODY_SECRET', '--b--'].join('\r\n');
  const result = await normalizeGmailEmail(connection, message(raw));
  assert.equal(result.body.content.trim(), 'Outer note');
  assert.equal(result.attachments.items[0].kind, 'item');
  assert.ok(!JSON.stringify(result).includes('NESTED_BODY_SECRET'));
  assert.ok(!JSON.stringify(result).includes('nested-secret@example.com'));
});

test('deep MIME nesting is rejected within the parser limit', async () => {
  let body = 'Content-Type: text/plain\r\n\r\nEnd';
  for (let i = 0; i < 35; i++) body = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
  await assert.rejects(normalizeGmailEmail(connection, message([...headers, body].join('\r\n'))), { code: 'gmail_mime_invalid' });
});

test('rejects missing raw, wrong label, ambiguous sender, invalid base64 and oversized input', async () => {
  for (const raw of [{ ...message(), raw: undefined }, { ...message(), labelIds: ['TRASH'] },
    { ...message(), raw: '%%%%' }, message('x'.repeat(gmailRawLimit + 1)),
    message([...headers, 'From: other@example.com', '', 'text'].join('\r\n'))])
    await assert.rejects(normalizeGmailEmail(connection, raw));
});

test('Gmail envelope imports into private Inbox, retains drafts and never publishes room events', async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember('commons', 'owner');
  const key = f.store.issueAccountAccessKey(account.id); const slot = f.store.createAccountSessionSlot();
  const auth = f.store.loginAccountSession(slot.token, key, 0);
  const profile = { ...connection, accountId: account.id };
  const apply = request => f.store.email.apply(slot.token, request, auth.sessionBinding);
  const roomBefore = JSON.stringify(f.store.room('commons').state.messages);
  apply({ action: 'connection.configure', requestId: randomUUID(), connectionId: profile.id, expectedRevision: 0, profile });
  const envelope = await normalizeGmailEmail(profile, message());
  apply({ action: 'page.apply', requestId: randomUUID(), connectionId: profile.id, connectionRevision: 1,
    folderId: 'INBOX', expectedRevision: 0, expectedCursor: null, cursor: 'fixture-snapshot-1', reset: true, complete: true,
    observations: [{ kind: 'message', expectedSourceRevision: 0, envelope }] });
  const read = () => f.store.inbox.read(slot.token, envelope.sourceId, auth.sessionBinding, { emailView: true, excerptView: true });
  assert.match(read().source.paragraphs[0], /Private note/);
  f.store.inbox.apply(slot.token, { action: 'draft.save', requestId: randomUUID(), sourceId: envelope.sourceId,
    sourceRevision: read().source.revision, expectedRevision: 0, body: 'Retain my private draft' }, auth.sessionBinding);
  apply({ action: 'connection.disconnect', requestId: randomUUID(), connectionId: profile.id, expectedRevision: 1 });
  assert.equal(read().draft.body, 'Retain my private draft');
  assert.equal(JSON.stringify(f.store.room('commons').state.messages), roomBefore);
  assert.throws(() => f.store.inbox.sendContext(slot.token, envelope.sourceId, auth.sessionBinding), { code: 'email_sending_unavailable' });
});
