import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphMailReader } from '../server/graph-mail-reader.mjs';
import { emailContractFixture } from '../scripts/email-contract-fixture.mjs';

function fixture(responses, overrides = {}) {
  const f = emailContractFixture(), calls = [];
  let authCalls = 0;
  const grant = { accountId: f.connection.accountId, connectionId: f.connection.id,
    connectionRevision: 1, mailboxId: f.connection.mailboxId, expiresAt: 2000, accessToken: 'test-token' };
  const reader = new GraphMailReader({ connection: f.connection, now: () => 1000,
    authorize: async () => { authCalls++; return grant; },
    fetchImpl: async (url, init) => { calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next instanceof Response ? next : Response.json(next); }, ...overrides });
  return { ...f, reader, calls, grant, authCalls: () => authCalls };
}
const identity = { id: 'fixture-mailbox' };
const folder = 'AQMkFixtureInbox=';
const cursor = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$deltatoken=opaque`;

test('hydrates actual Graph-shaped responses into the existing private email contract', async () => {
  const source = emailContractFixture();
  const f = fixture([identity, source.message]);
  const result = await f.reader.readMessage(source.message.id);
  assert.equal(result.body.content, source.message.body.content);
  assert.equal(result.attachments.state, 'not_loaded');
  assert.equal(result.message.id, source.message.id);
  assert.equal(f.authCalls(), 2);
  assert.ok(f.calls[1].url.includes(encodeURIComponent(source.message.id)));
  for (const { init } of f.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.match(init.headers.Prefer, /ImmutableId/);
  }
  assert.doesNotMatch(JSON.stringify(result), /test-token/);
});
test('pins the mailbox before reading private message data', async () => {
  const f = fixture([{ id: 'another-mailbox' }]);
  await assert.rejects(f.reader.readMessage(f.message.id), { code: 'graph_mailbox_mismatch' });
  assert.equal(f.calls.length, 1);
});
test('rejects expired or cross-account connection grants without any network access', async () => {
  for (const changed of [{ accountId: 'other' }, { connectionId: 'other' }, { connectionRevision: 2 },
    { mailboxId: 'other' }, { expiresAt: 999 }, { accessToken: 'secret\r\nInjected: yes' }]) {
    const f = fixture([]); Object.assign(f.grant, changed);
    await assert.rejects(f.reader.readMessage(f.message.id), { code: 'graph_authorization_required' });
    assert.equal(f.calls.length, 0);
  }
});
test('checks authorization again after identity lookup', async () => {
  const f = fixture([identity]); let n = 0;
  const r = new GraphMailReader({ connection: f.connection, now: () => 1000,
    authorize: () => ++n === 1 ? f.grant : null,
    fetchImpl: async () => Response.json(identity) });
  await assert.rejects(r.readMessage(f.message.id), { code: 'graph_authorization_required' });
});
test('folder page hydrates changes and preserves folder removals without claiming global deletion', async () => {
  const source = emailContractFixture();
  const f = fixture([identity, { value: [{ id: source.message.id }, { id: 'moved', '@removed': { reason: 'deleted' } }],
    '@odata.deltaLink': cursor }, source.message]);
  const page = await f.reader.readFolderPage(folder);
  assert.equal(page.complete, true); assert.equal(page.messages.length, 1);
  assert.equal(page.changes[1].action, 'absent-from-folder');
  assert.equal(page.cursor, cursor); assert.match(page.batchVersion, /^[a-f0-9]{64}$/);
});
test('cursor cannot expand attachments or rewrite select on the same path', async () => {
  const expand = cursor.replace('$deltatoken=opaque', '$expand=attachments&$select=body');
  const f = fixture([]);
  await assert.rejects(f.reader.readFolderPage(folder, expand), { code: 'invalid_graph_cursor' });
  assert.equal(f.calls.length, 0);
});
test('HTML bodies are rejected even if Graph ignores Prefer text', async () => {
  const source = emailContractFixture();
  const html = { ...source.message, body: { contentType: 'html', content: '<img src=x onerror=alert(1)>' } };
  const f = fixture([identity, html]);
  await assert.rejects(f.reader.readMessage(source.message.id), { code: 'graph_message_unsupported' });
});
test('cursor cannot redirect a bearer token to a different origin, resource or mailbox', async () => {
  for (const bad of ['https://evil.test/a', cursor.replace('/me/', '/users/other/'),
    cursor.replace('AQMkFixtureInbox%3D', 'other'), cursor + '#fragment',
    cursor.replace('https://', 'http://'), cursor.replace('graph.microsoft.com', 'user@graph.microsoft.com')]) {
    const f = fixture([]);
    await assert.rejects(f.reader.readFolderPage(folder, bad), { code: 'invalid_graph_cursor' });
    assert.equal(f.calls.length, 0);
  }
});
test('valid continuation is followed unchanged and hostile returned cursors fail before hydration', async () => {
  const f = fixture([identity, { value: [], '@odata.deltaLink': cursor }]);
  await f.reader.readFolderPage(folder, cursor);
  assert.equal(f.calls[1].url, cursor);
  const bad = fixture([identity, { value: [{ id: 'message' }], '@odata.nextLink': 'https://evil.test/' }]);
  await assert.rejects(bad.reader.readFolderPage(folder), { code: 'invalid_graph_cursor' });
  assert.equal(bad.calls.length, 2);
});
test('provider errors are classified without leaking response content', async () => {
  for (const [status, code] of [[401, 'graph_authorization_required'], [403, 'graph_authorization_required'],
    [404, 'graph_resource_unavailable'], [410, 'graph_resync_required'], [500, 'graph_request_failed'], [302, 'graph_request_failed']]) {
    const f = fixture([new Response('PRIVATE PROVIDER BODY', { status })]);
    await assert.rejects(f.reader.readMessage(f.message.id), e => e.code === code && !JSON.stringify(e).includes('PRIVATE'));
  }
  const f = fixture([new Response('private', { status: 429, headers: { 'Retry-After': '45' } })]);
  await assert.rejects(f.reader.readMessage(f.message.id), e => e.code === 'graph_retry_later' && e.retryAfterSeconds === 45);
});
test('malformed, oversized, mismatched and incomplete responses never become email', async () => {
  for (const response of [new Response('bad-json'), new Response(' '.repeat(2097153))]) {
    const f = fixture([response]); await assert.rejects(f.reader.readMessage(f.message.id));
  }
  const f = fixture([identity, { id: 'wrong' }]);
  await assert.rejects(f.reader.readMessage(f.message.id), { code: 'graph_message_mismatch' });
  const g = fixture([identity, { id: f.message.id }]);
  await assert.rejects(g.reader.readMessage(g.message.id), { code: 'graph_message_unsupported' });
});
test('bounds page work and does not skip failed hydration to advance a cursor', async () => {
  const f = fixture([identity, { value: Array.from({ length: 26 }, (_, n) => ({ id: `id-${n}` })), '@odata.deltaLink': cursor }]);
  await assert.rejects(f.reader.readFolderPage(folder), { code: 'graph_page_limit' });
  assert.equal(f.calls.length, 2);
  const g = fixture([identity, { value: [{ id: 'gone' }], '@odata.deltaLink': cursor }, new Response('', { status: 404 })]);
  await assert.rejects(g.reader.readFolderPage(folder), { code: 'graph_resource_unavailable' });
});
