import test from 'node:test';
import assert from 'node:assert/strict';
import { GmailMailReader } from '../server/gmail-mail-reader.mjs';
import { GMAIL_READ_SCOPE } from '../server/gmail-oauth.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
const connection = { accountId: 'account-a', id: 'gmail-a', revision: 1, provider: 'gmail', mailboxId: 'pilot@example.com', identity: { name: '', address: 'pilot@example.com' }, aliases: [] };
const grant = { accountId: 'account-a', connectionId: 'gmail-a', connectionRevision: 1, mailboxId: 'pilot@example.com', authEpoch: 1, scope: GMAIL_READ_SCOPE, accessToken: 'token-fixture', expiresAt: 2000 };
const mail = { id: 'abc123', threadId: 'abc123', historyId: '1', internalDate: '1789214400000', labelIds: ['INBOX'], raw: Buffer.from('From: sender@example.com\r\nContent-Type: text/plain\r\n\r\nPrivate note').toString('base64url') };
function fixture({ authorize = () => grant, respond } = {}) {
  const calls = [];
  const reader = new GmailMailReader({ connection, authEpoch: 1, now: () => 1000, authorize,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond ? respond(url, calls.length) : Response.json(calls.length === 1 ? { emailAddress: connection.mailboxId }
        : calls.length === 2 ? { messages: [{ id: mail.id }] } : mail);
    } });
  return { calls, reader };
}
test('bounded GET page hydrates into Gmail envelope with no token output', async () => {
  const f = fixture(); const result = await f.reader.readPage();
  assert.equal(result.observations[0].envelope.body.content, 'Private note\n');
  assert.equal(result.complete, true); assert.equal(result.nextPageToken, null);
  assert.ok(!JSON.stringify(result).includes(grant.accessToken));
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.init.method === 'GET' && call.init.redirect === 'error' && call.init.signal));
  assert.equal(new URL(f.calls[1].url).searchParams.get('maxResults'), '25');
});
test('wrong mailbox stops before message listing', async () => {
  const f = fixture({ respond: () => Response.json({ emailAddress: 'other@example.com' }) });
  await assert.rejects(f.reader.readPage(), { code: 'gmail_read_mailbox_mismatch' }); assert.equal(f.calls.length, 1);
});
test('wrong or expired authority stops before network', async () => {
  for (const changed of [{ accountId: 'other' }, { authEpoch: 2 }, { connectionRevision: 2 }, { expiresAt: 1000 }, { scope: 'https://mail.google.com/' }]) {
    const f = fixture({ authorize: () => ({ ...grant, ...changed }) });
    await assert.rejects(f.reader.readPage(), { code: 'gmail_read_authorization_required' }); assert.equal(f.calls.length, 0);
  }
});
test('revocation during response is checked before exposing results', async () => {
  let active = true;
  const f = fixture({ authorize: () => active ? grant : null, respond: () => { active = false; return Response.json({ emailAddress: connection.mailboxId }); } });
  await assert.rejects(f.reader.readPage(), { code: 'gmail_read_authorization_required' }); assert.equal(f.calls.length, 1);
});
test('page tokens are encoded values, never destinations or extra query parameters', async () => {
  const f = fixture(); await f.reader.readPage({ pageToken: 'abc+/==' });
  assert.equal(new URL(f.calls[1].url).origin, 'https://gmail.googleapis.com');
  assert.equal(new URL(f.calls[1].url).searchParams.get('pageToken'), 'abc+/==');
  for (const pageToken of ['https://evil.example', 'x&maxResults=500'])
    await assert.rejects(f.reader.readPage({ pageToken }), { code: 'gmail_read_invalid_request' });
});
test('duplicate and oversized pages fail without message hydration', async () => {
  for (const messages of [[{ id: 'abc' }, { id: 'abc' }], Array.from({ length: 26 }, (_, i) => ({ id: String(i) }))]) {
    const f = fixture({ respond: (url, n) => Response.json(n === 1 ? { emailAddress: connection.mailboxId } : { messages }) });
    await assert.rejects(f.reader.readPage(), { code: 'gmail_read_invalid_page' }); assert.equal(f.calls.length, 2);
  }
});
test('failed hydration never produces a partial page or next cursor', async () => {
  const f = fixture({ respond: (url, n) => n === 1 ? Response.json({ emailAddress: connection.mailboxId })
    : n === 2 ? Response.json({ messages: [{ id: 'abc' }], nextPageToken: 'next' }) : new Response('secret', { status: 404 }) });
  await assert.rejects(f.reader.readPage(), { code: 'gmail_message_changed' });
});
test('oversized response fails and provider error bodies remain private', async () => {
  for (const [response, code] of [[new Response('x'.repeat(2097153)), 'gmail_read_response_limit'], [new Response('secret', { status: 429 }), 'gmail_read_retry_later']]) {
    const f = fixture({ respond: () => response });
    await assert.rejects(f.reader.readPage(), { code });
  }
});

test('reader output commits through private Inbox import without creating room messages', async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember('commons', 'owner');
  const slot = f.store.createAccountSessionSlot();
  const auth = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const profile = { ...connection, accountId: account.id };
  const apply = request => f.store.email.apply(slot.token, request, auth.sessionBinding);
  apply({ action: 'connection.configure', requestId: randomUUID(), connectionId: profile.id, expectedRevision: 0, profile });
  const before = JSON.stringify(f.store.room('commons').state.messages);
  let calls = 0;
  const reader = new GmailMailReader({ connection: profile, authEpoch: 1, now: () => 1000,
    authorize: () => ({ ...grant, accountId: account.id }), fetchImpl: async () => Response.json(++calls === 1
      ? { emailAddress: profile.mailboxId } : calls === 2 ? { messages: [{ id: mail.id }] } : mail) });
  const page = await reader.readPage();
  apply({ action: 'page.apply', requestId: randomUUID(), connectionId: profile.id, connectionRevision: 1,
    folderId: page.labelId, expectedRevision: 0, expectedCursor: null, cursor: 'test-scan-complete', reset: true,
    complete: page.complete, observations: page.observations.map(observation => ({ ...observation, expectedSourceRevision: 0 })) });
  const view = f.store.inbox.read(slot.token, page.observations[0].envelope.sourceId, auth.sessionBinding, { emailView: true, excerptView: true });
  assert.match(view.source.paragraphs[0], /Private note/);
  assert.equal(JSON.stringify(f.store.room('commons').state.messages), before);
});
