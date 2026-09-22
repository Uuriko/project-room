import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { gmailLiveFixture } from '../scripts/gmail-live-fixture.mjs';
import { GmailMailbox } from '../server/gmail-mailbox.mjs';
import { GmailActions } from '../server/gmail-actions.mjs';
import { createRoomServer } from '../server/http.mjs';
async function setup(t) {
  const f = createAcceptanceFixture(), provider = gmailLiveFixture(), m = new GmailMailbox(f.store, provider.config);
  t.after(() => { f.store.close(); rmSync(f.directory, { force: true, recursive: true }); });
  const account = f.store.accountForMember('commons', 'owner'), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const url = new URL(m.begin(slot.token, session.sessionBinding)); url.pathname = '/api/auth/gmail/callback'; url.host = 'room.example'; url.searchParams.set('code', 'test');
  await m.complete(url, url.searchParams.get('state'));
  const actions = new GmailActions(m), run = data => actions.run(slot.token, session.sessionBinding, data);
  return { ...f, ...provider, m, actions, run, account, slot, session };
}
const compose = { action: 'send', requestId: 'send-one', to: 'taylor@example.com', cc: 'cc@example.com', bcc: 'bcc@example.com', subject: 'Friday plan', body: 'Hello π\nSecond line' };
test('live compose delivers bounded MIME with CC/BCC and stable replay without storing body', async t => {
  const f = await setup(t), first = await f.run(compose), again = await f.run(compose);
  assert.equal(first.state, 'accepted'); assert.deepEqual(first, again);
  const sends = f.calls.filter(c => c.url.endsWith('/messages/send')); assert.equal(sends.length, 1);
  const mime = Buffer.from(JSON.parse(sends[0].body).raw, 'base64url').toString();
  assert.match(mime, /Cc: cc@example.com/); assert.match(mime, /Bcc: bcc@example.com/); assert.match(mime, /From: morgan@gmail.test/);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM gmail_operations').all()).includes('Hello'));
  await assert.rejects(f.run({ ...compose, body: 'Changed' }), { code: 'gmail_request_conflict' });
});
test('reply uses provider thread, Message-ID and Reply-To; save/reopen/update/send provider draft', async t => {
  const f = await setup(t), saved = await f.run({ ...compose, action: 'save', replyId: 'mail-1', requestId: 'draft-one' });
  assert.equal(saved.state, 'accepted'); const listed = await f.run({ action: 'list', folder: 'drafts', query: '' }); assert.equal(listed.messages[0].draftId, saved.id);
  const read = await f.run({ action: 'read', id: saved.messageId, draftId: saved.id }); assert.equal(read.message.body, 'Hello π\r\nSecond line');
  const updated = await f.run({ ...compose, action: 'save', draftId: saved.id, expectedMessageId: saved.messageId, requestId: 'draft-two', body: 'Updated' });
  await assert.rejects(f.run({ ...compose, draftId: saved.id, expectedMessageId: saved.messageId }), { code: 'gmail_draft_changed' });
  assert.equal((await f.run({ ...compose, draftId: saved.id, expectedMessageId: updated.messageId, requestId: 'draft-send' })).state, 'accepted');
  const sent = f.calls.find(c => c.url.endsWith('/drafts/send')), payload = JSON.parse(sent.body); assert.equal(payload.message.threadId, 'thread-1');
  assert.match(Buffer.from(payload.message.raw, 'base64url').toString(), /In-Reply-To: <original@example.com>/);
});
test('ambiguous send reconciles against Sent across service restart without resending', async t => {
  const f = await setup(t), original = f.config.fetchImpl;
  f.config.fetchImpl = async (url, init) => { if (url.endsWith('/messages/send')) { await original(url, init); throw new Error('lost receipt'); } return original(url, init); };
  const results = await Promise.all([f.run(compose), f.run(compose)]); assert.ok(results.every(r => ['unknown', 'accepted'].includes(r.state)));
  const restarted = new GmailActions(new GmailMailbox(f.store, f.config)); assert.equal((await restarted.run(f.slot.token, f.session.sessionBinding, compose)).state, 'accepted');
  assert.equal(f.calls.filter(c => c.url.endsWith('/messages/send')).length, 1);
});
test('old read-only consent rejects writes; header injection and unsupported draft attachments never mutate', async t => {
  const f = await setup(t), auth = f.m.auth(f.slot.token, f.session.sessionBinding), record = f.m.record(auth);
  f.m.save(auth, { ...record, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
  assert.equal(f.m.status(auth).canWrite, false); await assert.rejects(f.run(compose), { code: 'gmail_write_permission_required' });
  f.m.save(auth, record);
  await assert.rejects(f.run({ ...compose, to: 'x@example.com\r\nBcc: z@example.com' }), { code: 'gmail_invalid_address' });
  await assert.rejects(f.run({ ...compose, subject: 'a\r\nb' }), { code: 'gmail_invalid_message' });
  assert.equal(f.calls.filter(c => c.url.endsWith('/messages/send')).length, 0);
});
test('mailbox search, archive/read/star/trash reflect Gmail and session changes block dispatch', async t => {
  const f = await setup(t);
  assert.equal((await f.run({ action: 'list', folder: 'inbox', query: 'Friday' })).messages.length, 1);
  for (const action of ['read-mark', 'star', 'archive', 'trash', 'untrash']) assert.equal((await f.run({ action, id: 'mail-1', requestId: action })).state, 'accepted');
  assert.deepEqual(f.messages.get('mail-1').labelIds, []);
  const original = f.config.fetchImpl;
  f.config.fetchImpl = async (...args) => { const r = await original(...args); if (args[0].includes('/token')) f.m.disconnect(f.slot.token, f.session.sessionBinding); return r; };
  await assert.rejects(f.run(compose), { code: 'gmail_session_changed' }); assert.equal(f.calls.filter(c => c.url.endsWith('/messages/send')).length, 0);
});
test('mailbox HTTP rejects missing CSRF before provider access and projects owner', async t => {
  const f = await setup(t), server = createRoomServer({ store: f.store, gmailAuth: f.config });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = 'http://127.0.0.1:' + server.address().port, count = f.calls.length;
  const headers = { Cookie: 'account_session=' + f.slot.token, Origin: origin, 'X-Session-Binding': f.session.sessionBinding, 'Content-Type': 'application/json' };
  const request = () => fetch(origin + '/api/inbox/gmail/mailbox', { method: 'POST', headers, body: JSON.stringify(compose) });
  assert.equal((await request()).status, 403); assert.equal(f.calls.length, count);
  headers['X-CSRF-Token'] = f.session.csrf; const response = await request(); assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.viewer.accountId, f.account.id); assert.equal(data.state, 'accepted');
});

test('formatted drafts preserve explicit attachment review and sanitize executable HTML', async t => {
  const f = await setup(t), read = await f.run({ action: 'read', id: 'mail-1' });
  assert.equal(read.message.replyTo, 'reply@example.com');
  const saved = await f.run({ ...compose, action: 'save', html: '<p><b>Hello</b><script>evil()</script><img src="https://tracker.test/pixel"></p>', attachments: [{ name: 'plan.txt', type: 'text/plain', data: Buffer.from('Plan').toString('base64') }] });
  const draft = await f.run({ action: 'read', id: saved.messageId, draftId: saved.id });
  assert.equal(draft.message.editable, true); assert.equal(draft.message.attachments[0].name, 'plan.txt'); assert.match(draft.message.html, /<b>Hello<\/b>/); assert.ok(!/script|img|tracker/.test(draft.message.html));
  await assert.rejects(f.run({ ...compose, requestId: 'omit-files', draftId: saved.id, expectedMessageId: saved.messageId }), { code: 'gmail_attachment_review_required' });
  const sent = await f.run({ ...compose, requestId: 'with-files', draftId: saved.id, expectedMessageId: saved.messageId, html: draft.message.html, attachments: draft.message.attachments.map(a => ({ messageId: saved.messageId, partId: a.partId })) });
  assert.equal(sent.state, 'accepted'); const opened = await f.run({ action: 'read', id: sent.id }); assert.equal(opened.message.attachments.length, 1);
  const downloaded = await f.run({ action: 'attachment', id: sent.id, partId: opened.message.attachments[0].partId }); assert.equal(Buffer.from(downloaded.attachment.data, 'base64url').toString(), 'Plan');
});

test('search pagination forwards Gmail cursor and remains scoped to each account', async t => {
  const f = await setup(t), original = f.config.fetchImpl;
  f.config.fetchImpl = async (url, init) => url.includes('/messages?') ? Response.json({ messages: [{ id: 'mail-1' }], nextPageToken: 'page-two' }) : original(url, init);
  assert.equal((await f.run({ action: 'list', folder: 'all', query: 'Friday', pageToken: 'page-two' })).nextPageToken, 'page-two');
  const other = f.store.createAccount('gmail-actions-other'), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(other.id), 0);
  await assert.rejects(f.actions.run(slot.token, session.sessionBinding, { action: 'read', id: 'mail-1' }), { code: 'gmail_reconnect_required' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM gmail_operations WHERE account_id=?').get(other.id).n, 0);
});
