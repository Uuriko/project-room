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
    const { ownerKey, accountKey, sourceId } = await json(await call('/__test-provision'));
    assert.equal((await json(await call('/api/health'))).mode, 'cloudflare-staging');
    const version = await json(await call('/api/version'));
    assert.deepEqual(version, { status: 'ok', mode: 'cloudflare-staging', sourceRevision: 'unstamped', buildId: 'unstamped' });
    const versionHead = await call('/api/version', { method: 'HEAD' });
    assert.equal(versionHead.status, 200); assert.equal(await versionHead.text(), '');
    const healthHead = await call('/api/health', { method: 'HEAD' });
    assert.equal(healthHead.status, 200);
    assert.equal(await healthHead.text(), '');
    const page = await call('/');
    assert.equal(page.status, 200, await page.clone().text());
    assert.match(await page.text(), /message-input/);
    const door = await call('/room', { headers: { Accept: 'text/html' } });
    assert.equal(door.status, 200, await door.clone().text());
    assert.match(door.headers.get('content-type'), /text\/html/);
    assert.match(await door.text(), /Work Items, next actions, receipts/);
    const packet = await call('/room/llms.txt');
    assert.equal(packet.status, 200);
    assert.match(packet.headers.get('content-type'), /text\/plain/);
    assert.match(await packet.text(), /# Project Room/);
    const plainDoor = await call('/room', { headers: { Accept: 'text/plain' } });
    assert.match(plainDoor.headers.get('content-type'), /text\/plain/);
    assert.equal(await plainDoor.text(), await (await call('/llms.txt')).text());
    const leftoverPacket = await call('/room/skill');
    assert.equal(leftoverPacket.status, 200);
    assert.equal(await leftoverPacket.text(), await (await call('/llms.txt')).text());
    const leftoverCard = await call('/room/agent.json');
    assert.equal(leftoverCard.status, 200);
    assert.deepEqual(await leftoverCard.json(), await (await call('/.well-known/agent.json')).json());
    const a2aCard = await call('/.well-known/agent-card.json');
    assert.equal(a2aCard.status, 200);
    assert.deepEqual(await a2aCard.json(), await (await call('/.well-known/agent.json')).json());
    const leftoverHealth = await json(await call('/room/health'));
    assert.deepEqual(leftoverHealth, await json(await call('/api/health')));
    const kits = await call('/room/kits');
    assert.equal(kits.status, 200);
    assert.match(kits.headers.get('content-type'), /text\/plain/);
    const kitsBody = await kits.text();
    assert.match(kitsBody, /This is a catalog\. Not an App Store/);
    assert.notEqual(kitsBody, await (await call('/llms.txt')).text());
    assert.equal(kitsBody, await (await call('/room/apps')).text());
    assert.equal(kitsBody, await (await call('/room/tools')).text());
    assert.equal(kitsBody, await (await call('/kits.txt')).text());
    const login = await call('/api/session', { data: { accessKey: ownerKey } });
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^__Host-room_session=/);
    assert.match(cookie, /HttpOnly; SameSite=Strict;.*Secure/);
    const owner = await json(login, 201);
    const ownerHeaders = { Cookie: cookie.split(';')[0], 'X-CSRF-Token': owner.csrf, 'X-Session-Binding': owner.sessionBinding };
    const mailSlotResponse = await call('/api/account-session', { ip: '192.0.2.20' });
    const mailCookie = mailSlotResponse.headers.get('set-cookie').split(';')[0], mailSlot = await json(mailSlotResponse);
    const mailSession = await json(await call('/api/account-session', { method: 'POST', ip: '192.0.2.20',
      headers: { Cookie: mailCookie, 'X-CSRF-Token': mailSlot.csrf, 'X-Session-Binding': mailSlot.sessionBinding },
      data: { accountAccessKey: accountKey, expectedSessionRevision: mailSlot.sessionRevision } }), 201);
    const mailHeaders = { Cookie: mailCookie, 'X-CSRF-Token': mailSession.csrf, 'X-Session-Binding': mailSession.sessionBinding };
    const reviewPath = '/api/inbox/sources/' + sourceId + '/reply-review?view=reply-review-v1';
    const draftReview = await json(await call(reviewPath, { headers: mailHeaders }));
    assert.equal(draftReview.attempt.canReview, true); assert.equal(draftReview.attempt.canSend, false);
    assert.equal(draftReview.comparison, undefined);
    const comparison = await json(await call(reviewPath.replace('reply-review-v1', 'reply-review-v2'), { headers: mailHeaders }));
    assert.deepEqual(comparison.attempt, draftReview.attempt);
    assert.equal(typeof comparison.comparison.originalBody, 'string'); assert.equal(comparison.comparison.updateStatus, null);
    assert.doesNotMatch(JSON.stringify(comparison.comparison), /providerDraftId|Authorization|https:/);
    const latest = await json(await call(reviewPath.replace('reply-review-v1', 'reply-review-v3'), { headers: mailHeaders }));
    assert.deepEqual(latest.attempt, comparison.attempt); assert.deepEqual(latest.comparison, comparison.comparison);
    const updated = await json(await call(reviewPath.replace('reply-review-v1', 'reply-review-v4'), { headers: mailHeaders }));
    assert.deepEqual(updated.attempt, latest.attempt); assert.deepEqual(updated.comparison, latest.comparison); assert.equal(updated.update, null);
    const reviewCommand = { action: 'reply.review', requestId: 'worker-browser-review', sourceId, attemptId: draftReview.attempt.id,
      expectedRevision: draftReview.attempt.revision, reviewVersion: draftReview.attempt.observation.version };
    await json(await call('/api/inbox/review', { headers: { ...mailHeaders, 'X-CSRF-Token': '' }, data: reviewCommand }), 403);
    await json(await call('/api/inbox/review', { headers: mailHeaders, data: { ...reviewCommand, action: 'reply.dispatch' } }), 422);
    const reviewed = await json(await call('/api/inbox/review', { headers: mailHeaders, data: reviewCommand }), 201);
    assert.equal(reviewed.receipt.attempt, undefined); assert.equal(reviewed.receipt.reviewVersion, reviewCommand.reviewVersion);
    assert.equal((await json(await call('/api/inbox/review', { headers: mailHeaders, data: reviewCommand }))).duplicate, true);
    assert.equal((await json(await call(reviewPath, { headers: mailHeaders }))).attempt.review.current, true);
    await json(await call(reviewPath, { headers: { Authorization: 'Bearer ' + ownerKey } }), 401);
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
    const roomList = await json(await call('/api/account-rooms', { headers: guestHeaders }));
    assert.equal(roomList.viewer.accountId, joined.session.account.id);
    assert.deepEqual(roomList.rooms.map(r => r.id), ['commons']); assert.equal(roomList.nextCursor, null);
    await json(await call('/api/account-rooms', { headers: { Cookie: slotCookie } }), 422);
    const command = { id: randomUUID(), type: 'message.posted', data: { body: 'Shared HTTP on Cloudflare' } };
    const posted = await json(await call('/api/rooms/commons/commands', { headers: guestHeaders, data: command }), 201);
    await json(await call('/api/rooms/commons/commands', { headers: ownerHeaders, data: {
      id: randomUUID(), type: 'work.proposed', data: { workItemId: 'selected:task', title: 'Selected task', definitionOfDone: 'Inspect the linked request',
        accountableMemberId: 'owner', sourceMessageId: posted.event.data.messageId ?? posted.event.id, mode: 'read' }
    } }), 201);
    const beforeRead = await json(await call('/api/rooms/commons', { headers: guestHeaders }));
    assert.equal(beforeRead.replyRequestContractVersion, 1, 'Worker advertises the same request contract as the local service');
    const workViewResponse = await call('/api/rooms/commons?view=work', { headers: guestHeaders });
    assert.equal(workViewResponse.headers.get('cache-control'), 'no-store');
    const workView = await json(workViewResponse);
    assert.equal(workView.snapshotView, 'work'); assert.equal(workView.snapshotVersion, 1);
    assert.equal(workView.viewerId, joined.session.member.id);
    assert.equal(workView.viewerSessionBinding, joined.session.sessionBinding);
    assert.equal(workView.sequence, beforeRead.sequence);
    assert.deepEqual(Object.keys(workView.state).sort(), ['members', 'room', 'workItems']);
    assert.equal(Object.hasOwn(workView, 'cursor'), false);
    assert.equal(workView.state.workItems['selected:task'].sourceMessageId, posted.event.data.messageId ?? posted.event.id);
    assert.equal(JSON.stringify(workView).includes(command.data.body), false);
    await json(await call('/api/rooms/commons?view=work&view=work', { headers: guestHeaders }), 422);
    const contextResponse = await call('/api/rooms/commons/work-context?workItemId=selected%3Atask&includeSource=true', { headers: guestHeaders });
    assert.equal(contextResponse.headers.get('cache-control'), 'no-store');
    const context = await json(contextResponse);
    assert.equal(context.work.id, 'selected:task');
    assert.equal(context.viewer.id, joined.session.member.id);
    assert.equal(context.viewerSessionBinding, joined.session.sessionBinding);
    assert.equal(context.context.source.message.body, command.data.body);
    assert.equal(context.collaboration.version, 1); assert.equal(context.collaboration.status, 'may_offer');
    assert.equal(context.helpContextVersion, 1); assert.equal(context.help.status, 'off');
    assert.equal(Object.hasOwn(workView, 'helpContextVersion'), false, 'Legacy snapshot envelope stays unchanged');
    const helpView = await json(await call('/api/rooms/commons?view=work', {
      headers: { ...guestHeaders, 'X-Project-Room-Help-Context': '1' } }));
    assert.equal(helpView.helpContextVersion, 1);
    assert.equal(new Date(helpView.evaluatedAt).toISOString(), helpView.evaluatedAt);
    assert.equal(helpView.sequence, beforeRead.sequence);
    assert.deepEqual(helpView.state, workView.state);
    await json(await call('/api/rooms/commons?view=work', {
      headers: { ...guestHeaders, 'X-Project-Room-Help-Context': '2' } }), 422);
    assert.deepEqual(context.collaboration.offer.request.arguments, { workItemId: 'selected:task', toMemberId: 'owner' });
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
    assert.deepEqual(noSource.collaboration, { version: 1, status: 'accountable', offer: null });
    assert.equal((await call('/api/rooms/commons/work-context?workItemId=selected%3Atask', { headers: { ...guestHeaders, 'X-Session-Binding': 'f'.repeat(64) } })).status, 409);
    assert.deepEqual(await json(await call('/api/rooms/commons', { headers: guestHeaders })), beforeRead);
    const offerPath = '/api/rooms/commons/work-context?workItemId=selected%3Atask';
    const offerHeaders = { ...guestHeaders, 'X-Project-Room-Offer-Context': '1' };
    const emptyOffers = await json(await call(offerPath, { headers: offerHeaders }));
    assert.equal(emptyOffers.offerContextVersion, 1);
    assert.deepEqual(emptyOffers.offers.offers, []);
    assert.equal(emptyOffers.offers.availability.reason, 'invitation_unavailable');
    assert.equal(Object.hasOwn(context, 'offerContextVersion'), false, 'Existing reads remain unchanged');
    await json(await call(offerPath, { headers: { ...offerHeaders, 'X-Project-Room-Offer-Context': '2' } }), 422);
    const workCommand = async (type, data, headers = ownerHeaders) => json(await call('/api/rooms/commons/commands', {
      headers, data: { id: randomUUID(), type, data: { workItemId: 'selected:task', expectedRevision: 1, ...data } }
    }), 201);
    await workCommand('work.accepted', { expectedRevision: 0 });
    const invitation = await workCommand('work.help_updated', { expectedHelpRevision: 0, status: 'open',
      scope: 'Suggest a short agenda', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await workCommand('work.help_offer_opened', { offerId: 'worker-offer', expectedHelpRevision: 1,
      helpEventId: invitation.event.id, plan: 'I can suggest two items' }, guestHeaders);
    const pending = await json(await call(offerPath, { headers: { ...ownerHeaders, 'X-Project-Room-Offer-Context': '1' } }));
    assert.equal(pending.offers.offers[0].canSelect, true);
    assert.ok(pending.context.participants.some(p => p.id === joined.session.member.id));
    await workCommand('work.help_offer_updated', { offerId: 'worker-offer', expectedOfferRevision: 0,
      expectedHelpRevision: 1, helpEventId: invitation.event.id, status: 'selected', reason: 'Use this plan' });
    const selectedOffer = await json(await call(offerPath, { headers: offerHeaders }));
    assert.equal(selectedOffer.offers.offers[0].canRelease, true);
    assert.equal(selectedOffer.offers.offers[0].externalExecution, false);
    assert.equal(selectedOffer.viewerSessionBinding, joined.session.sessionBinding);
    const browserOffers = await json(await call('/api/rooms/commons', { headers: offerHeaders }));
    assert.equal(browserOffers.offerContextVersion, 1);
    assert.equal(browserOffers.state.helpOffers['worker-offer'].status, 'selected');
    assert.equal(browserOffers.viewerSessionBinding, joined.session.sessionBinding);
    assert.equal((await json(await call('/api/rooms/commons', { headers: guestHeaders }))).offerContextVersion, undefined);
    await json(await call('/api/rooms/commons?view=work', { headers: offerHeaders }), 422);
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
