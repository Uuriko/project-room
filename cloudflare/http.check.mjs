import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';

test('shared HTTP service on Workers: secure cookie, invitation, guest message, CSRF and visitor rate limits', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin },
    serviceBindings: { ASSETS: async request => {
      const pathname = new URL(request.url).pathname;
      if (!/^\/(index\.html|src\/[a-z-]+\.(js|css))$/.test(pathname)) return new Response(null, { status: 404 });
      return new Response(await readFile(new URL('..' + pathname, import.meta.url)));
    } }
  });
  const call = (path, { data, headers = {}, method = data ? 'POST' : 'GET', ip = '192.0.2.1' } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { Host: new URL(origin).host, 'CF-Connecting-IP': ip, ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {})
  });
  const json = async (response, status = 200) => {
    assert.equal(response.status, status, response.status >= 400 ? await response.clone().text() : 'Unexpected response status');
    return response.json();
  };
  try {
    const { ownerKey } = await json(await call('/__test-provision'));
    assert.equal((await json(await call('/api/health'))).mode, 'cloudflare-staging');
    const page = await call('/');
    assert.equal(page.status, 200, await page.clone().text());
    assert.match(await page.text(), /message-input/);
    const login = await call('/api/session', { data: { accessKey: ownerKey } });
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^__Host-room_session=/);
    assert.match(cookie, /HttpOnly; SameSite=Strict;.*Secure/);
    const owner = await json(login, 201);
    const ownerHeaders = { Cookie: cookie.split(';')[0], 'X-CSRF-Token': owner.csrf, 'X-Session-Binding': owner.sessionBinding };
    const linkToken = randomBytes(32).toString('base64url');
    const link = await json(await call('/api/rooms/commons/share-links', { headers: ownerHeaders,
      data: { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 3, expectedMemberRevision: 0 } }), 201);
    assert.ok(link.link.id);
    const slotResponse = await call('/api/account-session', { ip: '192.0.2.2' });
    const slotCookie = slotResponse.headers.get('set-cookie').split(';')[0];
    const slot = await json(slotResponse);
    const slotHeaders = { Cookie: slotCookie, 'X-CSRF-Token': slot.csrf, 'X-Session-Binding': slot.sessionBinding };
    const joined = await json(await call('/api/share-links/join', { headers: slotHeaders, ip: '192.0.2.2',
      data: { linkToken, displayName: 'Browser guest', redemptionId: randomUUID(), expectedSessionRevision: slot.sessionRevision } }), 201);
    assert.equal(joined.session.member.role, 'guest');
    const guestHeaders = { Cookie: slotCookie, 'X-CSRF-Token': joined.session.csrf,
      'X-Session-Binding': joined.session.sessionBinding, 'X-Project-Room-Auth': 'account' };
    const command = { id: randomUUID(), type: 'message.posted', data: { body: 'Shared HTTP on Cloudflare' } };
    const posted = await json(await call('/api/rooms/commons/commands', { headers: guestHeaders, data: command }), 201);
    await json(await call('/api/rooms/commons/commands', { headers: ownerHeaders, data: {
      id: randomUUID(), type: 'work.proposed', data: { workItemId: 'selected:task', title: 'Selected task', definitionOfDone: 'Inspect the linked request',
        accountableMemberId: 'owner', sourceMessageId: posted.event.data.messageId ?? posted.event.id, mode: 'read' }
    } }), 201);
    const beforeRead = await json(await call('/api/rooms/commons', { headers: guestHeaders }));
    assert.equal(beforeRead.replyRequestContractVersion, 1, 'Worker advertises the same request contract as the local service');
    const contextResponse = await call('/api/rooms/commons/work-context?workItemId=selected%3Atask&includeSource=true', { headers: guestHeaders });
    assert.equal(contextResponse.headers.get('cache-control'), 'no-store');
    const context = await json(contextResponse);
    assert.equal(context.work.id, 'selected:task');
    assert.equal(context.viewer.id, joined.session.member.id);
    assert.equal(context.viewerSessionBinding, joined.session.sessionBinding);
    assert.equal(context.context.source.message.body, command.data.body);
    const discussionResponse = await call('/api/rooms/commons/work-discussion?workItemId=selected%3Atask&limit=1', { headers: guestHeaders });
    assert.equal(discussionResponse.headers.get('cache-control'), 'no-store');
    const discussion = await json(discussionResponse);
    assert.equal(discussion.viewerId, joined.session.member.id);
    assert.equal(discussion.viewerSessionBinding, joined.session.sessionBinding);
    assert.equal(discussion.discussion.items[0].eventId, posted.event.id);
    assert.equal(discussion.discussion.items[0].message.body, command.data.body);
    assert.equal(discussion.discussion.items[0].relation, 'source');
    assert.equal(discussion.discussion.checkpoint, beforeRead.sequence);
    assert.equal(discussion.current.workRevision, 0);
    const refreshed = await json(await call('/api/rooms/commons/work-discussion?workItemId=selected%3Atask&since=' + discussion.discussion.checkpoint, { headers: guestHeaders }));
    assert.deepEqual(refreshed.discussion.items, []);
    assert.equal((await call('/api/rooms/commons/work-discussion?workItemId=selected%3Atask', { headers: { ...guestHeaders, 'X-Session-Binding': 'f'.repeat(64) } })).status, 409);
    assert.equal(context.next.addressedToViewer, false);
    assert.deepEqual(context.suggestedActions, []);
    const noSource = await json(await call('/api/rooms/commons/work-context?workItemId=selected%3Atask', { headers: { Authorization: `Bearer ${ownerKey}` } }));
    assert.equal(noSource.context.source.status, 'not_requested');
    assert.equal(noSource.context.source.message, null);
    assert.equal(noSource.next.action, 'accept');
    assert.equal((await call('/api/rooms/commons/work-context?workItemId=selected%3Atask', { headers: { ...guestHeaders, 'X-Session-Binding': 'f'.repeat(64) } })).status, 409);
    assert.deepEqual(await json(await call('/api/rooms/commons', { headers: guestHeaders })), beforeRead);
    const questionCommand = { id: randomUUID(), type: 'message.posted', data: { messageId: 'worker-reply-request', requestKind: 'reply',
      toMemberId: joined.session.member.id, body: 'Which agenda would you choose?' } };
    const asked = await json(await call('/api/rooms/commons/commands', { headers: ownerHeaders, data: questionCommand }), 201);
    const selectedReply = await json(await call('/api/rooms/commons/reply-context?requestMessageId=worker-reply-request', { headers: guestHeaders }));
    assert.equal(selectedReply.current.answerBasis.contextEventId, asked.event.id);
    assert.equal(selectedReply.viewerSessionBinding, joined.session.sessionBinding);
    assert.equal((await json(await call('/api/rooms/commons/reply-requests', { headers: guestHeaders }))).requests[0].id, 'worker-reply-request');
    const answerCommand = { id: randomUUID(), type: 'message.posted', data: { messageId: 'worker-reply-answer', responseToRequestId: 'worker-reply-request',
      ...selectedReply.current.answerBasis, responseOutcome: 'answered', body: 'The short agenda 🪷', replyToId: 'worker-reply-request', toMemberId: 'owner', workItemId: null } };
    const answered = await json(await call('/api/rooms/commons/commands', { headers: guestHeaders, data: answerCommand }), 201);
    assert.equal((await json(await call('/api/rooms/commons/commands', { headers: guestHeaders, data: answerCommand }))).event.id, answered.event.id);
    const replyHistory = await json(await call('/api/rooms/commons/reply-history', { headers: guestHeaders }));
    assert.deepEqual(replyHistory.page.items.map(row => row.kind), ['opened', 'answered']);
    assert.equal(replyHistory.page.items.at(-1).message.body, answerCommand.data.body);
    assert.equal((await json(await call('/api/rooms/commons', { headers: guestHeaders }))).cursor, beforeRead.cursor);
    assert.equal((await call('/api/rooms/commons/reply-context?requestMessageId=worker-reply-request', { headers: { ...guestHeaders, 'X-Session-Binding': 'f'.repeat(64) } })).status, 409);
    assert.equal((await call('/api/rooms/commons/reply-history?status=open', { headers: guestHeaders })).status, 422);
    const denied = await call('/api/rooms/commons/commands', { headers: { ...guestHeaders, 'X-CSRF-Token': '' }, data: { ...command, id: randomUUID() } });
    assert.equal(denied.status, 403);
    assert.equal((await call('/api/rooms/commons')).status, 401);
    assert.equal((await call('/api/health', { headers: { Origin: 'https://other.example.test' } })).status, 403);
    // Untrusted forwarding headers must not select a rate-limit identity.
    for (let n = 0; n < 20; n++) await json(await call('/api/account-session', { ip: '192.0.2.9', headers: { 'X-Room-Visitor-IP': `198.51.100.${n + 1}` } }));
    assert.equal((await call('/api/account-session', { ip: '192.0.2.9', headers: { 'X-Room-Visitor-IP': '198.51.100.99' } })).status, 429);
    await json(await call('/api/account-session', { ip: '192.0.2.10' }));
  } finally { await mf.dispose(); }
});
