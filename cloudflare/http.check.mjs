import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const identity = await json(await call('/api/agent-identities', { data: { displayName: 'Returning agent' } }), 201);
    const identityHeaders = { Authorization: `Bearer ${identity.secret}` };
    await json(await call('/api/agent-rooms', { data: { roomId: 'returning-agent', title: 'Return here', purpose: 'Recovery fixture', kind: 'personal', displayName: 'Returning agent' }, headers: identityHeaders }), 201);
    const memberships = await json(await call('/api/agent-rooms', { headers: identityHeaders }));
    assert.equal(memberships.identityId, identity.identityId);
    assert.deepEqual(memberships.rooms.map(room => room.roomId), ['returning-agent']);
    assert.equal(memberships.nextCursor, null);
    // Actual Worker SQLite must support bounded current-record projection and
    // signed continuation paging; Node SQLite cannot prove this adapter path.
    for (const id of ['older', 'newer']) await json(await call('/api/rooms/returning-agent/commands', {
      headers: identityHeaders, data: { id: randomUUID(), type: 'message.posted', data: { messageId: id, body: id } }
    }), 201);
    const conversation = await json(await call('/api/rooms/returning-agent/conversation?limit=1', { headers: identityHeaders }));
    assert.deepEqual(conversation.messages.map(message => message.id), ['newer']);
    const olderPage = await json(await call('/api/rooms/returning-agent/conversation?limit=1&cursor=' + encodeURIComponent(conversation.nextCursor), { headers: identityHeaders }));
    assert.deepEqual(olderPage.messages.map(message => message.id), ['older']);
    assert.equal(olderPage.nextCursor, null);
    assert.equal((await json(await call('/api/rooms/returning-agent/conversation?limit=1&since=' + encodeURIComponent(conversation.checkpoint), { headers: identityHeaders }))).mode, 'not_modified');
    assert.equal((await call('/api/agent-rooms')).status, 401);
    assert.equal((await call('/api/agent-rooms', { headers: { Authorization: `Bearer ${ownerKey}` } })).status, 401);

    // The webhook inbox is mounted: an unknown connection or wrong secret is 401
    // channel_webhook_denied, not 409 channel_webhook_unavailable, and nothing is journaled.
    const webhook = await call('/api/inbox/webhooks/unknown-connection', { data: { update_id: 1 }, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'not-the-configured-secret-0123' } });
    assert.equal((await json(webhook, 401)).error.code, 'channel_webhook_denied');
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
    assert.match(await door.text(), /A shared place for people and AI agents to build together/);
    // Edge-door hosts: /room and /room/* rewrite onto the Room origin; the /room*
    // route's lookalikes (/rooms, /roommates) are plain 404s, not the spoofed-host 403.
    const edgeDoor = await mf.dispatchFetch('https://www.getdasha.com/room?ref=x', { headers: { Accept: 'text/html', 'CF-Connecting-IP': '192.0.2.1' } });
    assert.equal(edgeDoor.status, 200, await edgeDoor.clone().text());
    assert.match(await edgeDoor.text(), /A shared place for people and AI agents to build together/);
    const lookalike = await mf.dispatchFetch('https://www.getdasha.com/rooms', { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    assert.equal(lookalike.status, 404);
    assert.equal(await lookalike.text(), 'Not found');
    const packet = await call('/room/llms.txt');
    assert.equal(packet.status, 200);
    assert.match(packet.headers.get('content-type'), /text\/plain/);
    assert.match(await packet.text(), /# (Uuriko )?Project Room/);
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
    assert.match(a2aCard.headers.get('content-type'), /application\/json/);
    const a2aCardJson = await a2aCard.json();
    assert.deepEqual(a2aCardJson, await (await call('/.well-known/agent.json')).json());
    // RC-2026-09-23-105: discovery card shape (A2A v1.0 field conventions) on the production card.
    for (const field of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(a2aCardJson[field] !== undefined, field);
    assert.ok(Array.isArray(a2aCardJson.supportedInterfaces) && a2aCardJson.supportedInterfaces.length > 0);
    assert.ok(a2aCardJson.supportedInterfaces.every(i => typeof i.url === 'string' && typeof i.protocolBinding === 'string' && typeof i.protocolVersion === 'string'));
    assert.ok(Array.isArray(a2aCardJson.skills) && a2aCardJson.skills.length > 0);
    assert.ok(a2aCardJson.skills.every(s => s.id && s.name && s.description && Array.isArray(s.tags)));
    assert.equal(typeof a2aCardJson.capabilities.streaming, 'boolean');
    // Discoverability: root card aliases, ARD ai-catalog (ard.json + ai-catalog.json), robots.txt.
    for (const path of ['/agent.json', '/agent-card.json']) {
      const alias = await call(path);
      assert.equal(alias.status, 200, path);
      assert.deepEqual(await alias.json(), a2aCardJson, `${path} matches the card`);
    }
    const ard = await call('/.well-known/ard.json');
    assert.equal(ard.status, 200);
    const ardJson = await ard.json();
    assert.ok(Array.isArray(ardJson.entries) && ardJson.entries.length >= 2);
    assert.deepEqual(await (await call('/.well-known/ai-catalog.json')).json(), ardJson);
    const robots = await call('/robots.txt');
    assert.equal(robots.status, 200);
    const robotsBody = await robots.text();
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Meta-ExternalAgent']) {
      assert.match(robotsBody, new RegExp(`User-agent: ${bot}`), bot);
    }
    const healthShape = async path => json(await call(path));
    const leftoverHealth = await healthShape('/room/health');
    assert.deepEqual(leftoverHealth, { status: 'ok', mode: 'cloudflare-staging' });
    assert.deepEqual(leftoverHealth, await healthShape('/api/health'));
    assert.deepEqual(await healthShape('/api/healthz'), leftoverHealth);
    assert.deepEqual(await healthShape('/healthz'), leftoverHealth);
    assert.deepEqual(await healthShape('/room/healthz'), leftoverHealth);
    assert.deepEqual(await healthShape('/room/api/healthz'), leftoverHealth);
    const ready = await json(await call('/api/ready'));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.mode, 'cloudflare-staging');
    assert.equal(ready.do.status, 'ok');
    assert.equal(ready.do.statusCode, 200);
    assert.equal(typeof ready.do.ms, 'number');
    const readyHead = await call('/api/ready', { method: 'HEAD' });
    assert.equal(readyHead.status, 200);
    assert.equal(await readyHead.text(), '');
    const kits = await call('/room/kits');
    assert.equal(kits.status, 200);
    assert.match(kits.headers.get('content-type'), /text\/plain/);
    const kitsBody = await kits.text();
    assert.match(kitsBody, /This is a catalog\. Not an App Store/);
    assert.notEqual(kitsBody, await (await call('/llms.txt')).text());
    assert.equal(kitsBody, await (await call('/room/apps')).text());
    assert.equal(kitsBody, await (await call('/room/tools')).text());
    assert.equal(kitsBody, await (await call('/kits.txt')).text());
    assert.equal(kitsBody, await (await call('/kits.json')).text());
    assert.equal(kitsBody, await (await call('/room/kits.json')).text());
    assert.equal(kitsBody, await (await call('/kits')).text());
    const login = await call('/api/session', { data: { accessKey: ownerKey } });
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^__Host-room_session=/);
    assert.match(cookie, /HttpOnly; SameSite=Strict;.*Secure/);
    const owner = await json(login, 201);
    const ownerHeaders = { Cookie: cookie.split(';')[0], 'X-CSRF-Token': owner.csrf, 'X-Session-Binding': owner.sessionBinding };
    // Work delivery crosses the actual HTTP + Durable Object SQLite boundary.
    await json(await call('/api/rooms/commons/identity-links', { headers: ownerHeaders,
      data: { identityId: identity.identityId, memberId: 'work-wake-worker', permissions: ['accept_work'] } }), 201);
    const beatWork = () => call('/api/agent-heartbeats', { headers: identityHeaders,
      data: { hostId: 'worker-work-test', mode: 'pull-only', workWakes: true } });
    assert.equal((await json(await beatWork())).host.workWakes, true);
    const wakeAssignmentCommand = { id: randomUUID(), type: 'work.proposed', data: { workItemId: 'worker-work-wake', title: 'Wake test',
      definitionOfDone: 'Review pointer', mode: 'read', accountableMemberId: 'work-wake-worker' } };
    await json(await call('/api/rooms/commons/commands', { headers: ownerHeaders, data: wakeAssignmentCommand }), 201);
    await json(await call('/api/rooms/commons/commands', { headers: ownerHeaders, data: wakeAssignmentCommand }));
    const workSignals = (await json(await beatWork())).pendingWakes;
    assert.deepEqual(workSignals.map(w => [w.kind, w.workItemId, w.workRevision]), [['work', 'worker-work-wake', 0]]);
    const ackWork = await json(await call('/api/agent-heartbeats/ack', { headers: identityHeaders,
      data: { signalIds: workSignals.map(w => w.signalId) } }));
    assert.deepEqual(ackWork.acknowledged, workSignals.map(w => w.signalId));
    assert.deepEqual((await json(await beatWork())).pendingWakes, []);

    const mailSlotResponse = await call('/api/account-session', { ip: '192.0.2.20' });
    const mailCookie = mailSlotResponse.headers.get('set-cookie').split(';')[0], mailSlot = await json(mailSlotResponse);
    const mailLoginResponse = await call('/api/account-session', { method: 'POST', ip: '192.0.2.20',
      headers: { Cookie: mailCookie, 'X-CSRF-Token': mailSlot.csrf, 'X-Session-Binding': mailSlot.sessionBinding },
      data: { accountAccessKey: accountKey, expectedSessionRevision: mailSlot.sessionRevision } });
    const mailSession = await json(mailLoginResponse, 201);
    // QAS-702 (QA-Auth 2026-09-19): the account-key login rotates the slot —
    // the pre-login cookie is dead; the response cookie carries the session.
    const mailHeaders = { Cookie: mailLoginResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': mailSession.csrf, 'X-Session-Binding': mailSession.sessionBinding };
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
    // Consent-bound DMs: the owner's question below is a DM to the guest, so
    // the guest must approve the direction first (requester = owner).
    const ownerViewer = await json(await call('/api/rooms/commons', { headers: ownerHeaders }));
    const dmConsent = await json(await call('/api/rooms/commons/dm-consents', { headers: ownerHeaders,
      data: { targetId: joined.session.member.id, reason: 'reply-request question' } }), 201);
    assert.equal(dmConsent.status, 'pending');
    const dmApproved = await json(await call(`/api/rooms/commons/dm-consents/${ownerViewer.viewerId}/decide`,
      { headers: guestHeaders, data: { decision: 'approve' } }), 200);
    assert.equal(dmApproved.status, 'approved');
    // The guest's answer below is a DM back to the owner: approve that direction too.
    const dmBack = await json(await call('/api/rooms/commons/dm-consents', { headers: guestHeaders,
      data: { targetId: ownerViewer.viewerId, reason: 'reply answer' } }), 201);
    assert.equal(dmBack.status, 'pending');
    const dmBackApproved = await json(await call(`/api/rooms/commons/dm-consents/${joined.session.member.id}/decide`,
      { headers: ownerHeaders, data: { decision: 'approve' } }), 200);
    assert.equal(dmBackApproved.status, 'approved');
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
    assert.equal((await call('/api/ready', { headers: { Origin: 'https://other.example.test' } })).status, 403);
    // Untrusted forwarding headers must not select a rate-limit identity.
    for (let n = 0; n < 20; n++) await json(await call('/api/account-session', { ip: '192.0.2.9', headers: { 'X-Room-Visitor-IP': `198.51.100.${n + 1}` } }));
    assert.equal((await call('/api/account-session', { ip: '192.0.2.9', headers: { 'X-Room-Visitor-IP': '198.51.100.99' } })).status, 429);
    await json(await call('/api/account-session', { ip: '192.0.2.10' }));
  } finally { await mf.dispose(); }
});

test('getdasha entry and canonical browser app share identities, rooms and invites through one namespace', async () => {
  const release = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(release.vars.ROOM_ORIGIN, 'https://room.trydemigod.com');
  assert.equal(release.durable_objects.bindings[0].script_name, release.env.production.name);
  assert.equal(release.env.production.durable_objects.bindings[0].script_name, undefined);
  const productionVars = release.env.production.vars;
  assert.equal(productionVars.ROOM_ORIGIN, 'https://room.trydemigod.com');
  assert.equal(productionVars["ROOM_DEPLOYMENT"], 'production');
  assert.deepEqual(release.triggers.crons, []);
  assert.deepEqual(release.env.production.triggers.crons, ['*/30 * * * *']);
  // Isolated staging owns its Durable Object. It must not inherit the entry
  // binding that points at production, and it must not take the public routes.
  assert.equal(release.name, 'project-room-staging');
  assert.equal(release.env.staging.name, 'project-room-stage');
  assert.equal(release.env.staging.workers_dev, true);
  assert.deepEqual(release.env.staging.routes, []);
  assert.equal(release.env.staging.limits.cpu_ms, 30000);
  assert.deepEqual(release.env.staging.triggers.crons, []);
  assert.equal(release.env.staging.durable_objects.bindings[0].class_name, 'ProjectRoom');
  assert.equal(release.env.staging.durable_objects.bindings[0].script_name, undefined);
  assert.equal(release.env.staging.vars.ROOM_DEPLOYMENT, 'staging');
  assert.equal(release.env.staging.vars.ROOM_ORIGIN, 'https://project-room-stage.getdasha.workers.dev');
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./room.mjs', import.meta.url))], bundle: true,
    write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const common = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: release.compatibility_date,
    compatibilityFlags: release.compatibility_flags, bindings: release.vars,
    serviceBindings: { ASSETS: async () => new Response('synthetic assets') } };
  const mf = new Miniflare({ workers: [
    { ...common, name: release.name, durableObjects: { ROOM: { className: 'ProjectRoom', scriptName: release.env.production.name } } },
    { ...common, name: release.env.production.name, durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } } }
  ] });
  try {
    const canonical = await mf.getWorker(release.env.production.name);
    const call = async (edge, path, data, token) => {
      const url = edge ? 'https://www.getdasha.com/room' + path : release.vars.ROOM_ORIGIN + path;
      const init = { method: data ? 'POST' : 'GET', headers: { 'CF-Connecting-IP': '192.0.2.8',
        ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) };
      const response = edge ? await mf.dispatchFetch(url, init) : await canonical.fetch(url, init);
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    const owner = await call(true, '/api/agent-identities', { displayName: 'Cross-entry owner' });
    const room = await call(false, '/api/agent-rooms', { roomId: 'shared-entry', title: 'One room', purpose: 'Same people and agents',
      kind: 'organization', displayName: 'Cross-entry owner' }, owner.secret);
    assert.equal(room.roomId, 'shared-entry');
    assert.equal((await call(true, '/api/agent-rooms', null, owner.secret)).rooms[0].roomId, room.roomId);
    const invite = await call(false, '/api/rooms/shared-entry/agent-invites', { profile: 'chat' }, owner.secret);
    const peer = await call(true, '/api/agent-invites/redeem', { code: invite.code, displayName: 'Cross-entry peer' });
    const snapshot = await call(false, '/api/rooms/shared-entry', null, peer.mcpToken.credential);
    assert.equal(snapshot.viewerId, peer.memberId);
    assert.equal(snapshot.state.members[peer.memberId].displayName, 'Cross-entry peer');
  } finally { await mf.dispose(); }
});

// Independent platform contract: an actual Durable Object receipt survives restart
// and is citable through HTTP MCP. Node SQLite tests cannot exercise this adapter
// or transport. The prior nonexistent receipt id column breaks the final assertion.
// Setup uses the receipt owner; no invented schema or production test seam.
test('Worker MCP pitch cites a canonical receipt after Durable Object restart', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test', directory = await mkdtemp(join(tmpdir(), 'project-room-cf-emissary-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } },
    durableObjectsPersist: directory, bindings: { ROOM_ORIGIN: origin } };
  let mf = new Miniflare(config);
  const call = async (path, data, key) => {
    const response = await mf.dispatchFetch(origin + path, { method: 'POST',
      headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.1',
        Origin: origin, 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(data) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    const owner = await call('/api/agent-identities', { displayName: 'Receipt reviewer' });
    const room = await call('/api/agent-rooms', { title: 'Receipt room', purpose: 'Synthetic review evidence' }, owner.secret);
    const receipt = await call('/__test-emissary-receipt', { roomId: room.roomId });
    await mf.dispose(); mf = new Miniflare(config);
    const reply = await call('/mcp', { jsonrpc: '2.0', id: 'pitch', method: 'tools/call',
      params: { name: 'emissary_pitch', arguments: { roomId: room.roomId,
        focus: 'We need reviewers.', proof_refs: [receipt.receipt_id] } } }, owner.secret);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
    const result = reply.result?.structuredContent ?? JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
    assert.equal(typeof result.text, 'string', JSON.stringify(reply));
    assert.ok(result.text.includes(receipt.receipt_id), 'pitch cites the persisted receipt');
    assert.ok(result.text.startsWith('We need reviewers.'));
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Worker bounty HTTP receipts create distinct durable webhook deliveries without dispatch', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } },
    durableObjectsPersist: await mkdtemp(join(tmpdir(), 'project-room-cf-bounty-http-')),
    bindings: { ROOM_ORIGIN: origin } };
  let mf = new Miniflare(config);
  const call = async (path, key, data) => {
    const response = await mf.dispatchFetch(origin + path, { method: data ? 'POST' : 'GET',
      headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.1',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.equal(response.status, data ? 201 : 200, await response.clone().text());
    return response.json();
  };
  try {
    const { ownerKey } = await call('/__test-bounty-provision');
    const payloads = ['one', 'two'].map(id => ({ title: id, criteria: 'Synthetic unfunded draft',
      amount: 1, deadline: new Date(Date.now() + 3600000).toISOString(), idempotencyKey: id }));
    const receipts = [];
    for (const data of payloads) {
      const result = await call('/api/rooms/commons/bounties', ownerKey, data);
      assert.equal(result.bounty.state, 'proposed');
      receipts.push(result);
    }
    const queued = await call('/__test-bounty-queue');
    assert.equal(queued.deliveries.length, 2, 'each proposal must queue a separate delivery');
    assert.deepEqual(queued.events.filter(event => event.type === 'bounty.proposed'), receipts.map(result => result.receipt.event));
    assert.deepEqual(queued.deliveries, receipts.map(result => ({ event_id: `bounty-event-${result.receipt.event.seq}`, state: 'pending', attempts: 0 })));
    await mf.dispose(); mf = new Miniflare(config);
    assert.deepEqual(await call('/__test-bounty-queue'), queued); // Also disables dispatch in the restarted fixture.
    for (let i = 0; i < payloads.length; i++) assert.deepEqual(await call('/api/rooms/commons/bounties', ownerKey, payloads[i]), receipts[i]);
    assert.deepEqual(await call('/__test-bounty-queue'), queued);
  } finally { await mf.dispose(); }
});


test('Worker board v2 routes stay retired across restart, including when the old flag is set', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test', directory = await mkdtemp(join(tmpdir(), 'project-room-cf-board-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } },
    durableObjectsPersist: directory, bindings: { ROOM_ORIGIN: origin } };
  let mf = new Miniflare(config);
  const call = async (path, key, data, status = 410) => {
    const response = await mf.dispatchFetch(origin + path, { method: data ? 'POST' : 'GET',
      headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.1',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  try {
    const { ownerKey } = await call('/__test-provision', undefined, undefined, 200);
    const base = '/api/rooms/commons/board/v2';
    const payload = { task_id: 'RC-2026-09-27-9001', files: ['synthetic/board-fixture.txt'], lease: 'lease=8h', reason: 'Isolated Worker persistence check' };
    const retired = await call(base + '/board', ownerKey);
    assert.equal(retired.error.code, 'board_v2_retired');
    assert.equal(retired.next[0].href, '/api/rooms/commons/work-claims');
    assert.equal((await call(base + '/claims', ownerKey, payload)).error.code, 'board_v2_retired');
    await mf.dispose();
    config.bindings.ROOM_BOARD_V2_ENABLED = '1';
    mf = new Miniflare(config);
    const again = await call(base + '/claims', ownerKey, payload);
    assert.equal(again.error.code, 'board_v2_retired');
    assert.equal(again.next[0].href, '/api/rooms/commons/work-claims');
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});


test('Workers password reset commits failed attempts, consumes once and requires fresh password login', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin } });
  const call = (path, data, headers = {}) => mf.dispatchFetch(origin + path, {
    method: data ? 'POST' : 'GET', headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.73',
      ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const json = async (response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text()); return response.json();
  };
  const freshSlot = async () => {
    const response = await call('/api/account-session');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^__Host-account_session=/);
    const view = await json(response);
    return { view, headers: { Cookie: cookie, 'X-CSRF-Token': view.csrf, 'X-Session-Binding': view.sessionBinding } };
  };
  try {
    const proof = await json(await call('/__test-password-reset-provision'));
    const slot = await freshSlot();
    const body = { email: proof.email, code: proof.code, newPassword: randomUUID(), sessionRevision: slot.view.sessionRevision };
    const invalid = await json(await call('/api/auth/password/reset/consume', { ...body, code: 'wrong-reset-proof' }, slot.headers), 401);
    assert.equal(invalid.error.code, 'invalid_password_reset');
    assert.deepEqual(await json(await call('/__test-password-reset-state')), { attempts: 1, consumed_at: null },
      'failed proof counter survives the actual Durable Object writer transaction');
    assert.deepEqual(await json(await call('/api/auth/password/reset/consume', body, slot.headers)),
      { status: 'password_reset', signInRequired: true });
    assert.equal((await json(await call('/api/account-session', null, slot.headers))).authenticated, false);
    assert.equal((await json(await call('/api/auth/password/reset/consume', body, slot.headers), 401)).error.code, 'invalid_password_reset');
    const loginSlot = await freshSlot();
    const loginBody = { email: proof.email, password: proof.originalPassword, sessionRevision: loginSlot.view.sessionRevision };
    await json(await call('/api/auth/password/login', loginBody, loginSlot.headers), 401);
    const login = await call('/api/auth/password/login', { ...loginBody, password: body.newPassword }, loginSlot.headers);
    const session = await json(login);
    assert.equal(session.authenticated, true); assert.equal(session.account.id, 'worker-reset-owner');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, loginSlot.headers.Cookie, 'fresh login rotates the browser slot');
    assert.equal((await json(await call('/api/account-session', null, { Cookie: cookie }))).account.id, 'worker-reset-owner');
  } finally { await mf.dispose(); }
});


test('Workers held wake poll receives a fresh online mention and fences revoked credentials', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough', 'enable_nodejs_http_server_modules'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin } });
  const call = (path, data, headers = {}) => mf.dispatchFetch(origin + path, {
    method: data ? 'POST' : 'GET', headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.87',
      ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const json = async (response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text()); return response.json();
  };
  try {
    const { ownerKey } = await json(await call('/__test-provision'));
    const peer = await json(await call('/api/agent-identities', { displayName: 'Workers wake agent' }), 201);
    const ownerHeaders = { Authorization: `Bearer ${ownerKey}` }, identityHeaders = { Authorization: `Bearer ${peer.secret}` };
    await json(await call('/api/rooms/commons/identity-links', {
      identityId: peer.identityId, memberId: 'worker-wake-peer', displayName: 'Worker wake peer', permissions: []
    }, ownerHeaders), 201);
    const key = await json(await call('/api/agent-keys', { scopes: ['heartbeats:report', 'heartbeats:read'] }, identityHeaders), 201);
    const peerHeaders = { Authorization: `Bearer ${key.credential}` };
    const host = await json(await call('/api/agent-heartbeats', { hostId: 'worker-wake-host' }, peerHeaders));
    assert.equal(host.host.mode, 'wakeable'); assert.equal(host.host.wakeUrl, null);
    const pollPath = '/api/agent-wakes/poll?hostId=worker-wake-host&waitMs=2000';
    let settled = false;
    const held = call(pollPath, null, peerHeaders).then(response => { settled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(settled, false, 'workerd keeps the actual HTTP poll pending');
    await json(await call('/api/rooms/commons/commands', { id: randomUUID(), type: 'message.posted',
      data: { messageId: 'worker-held-mention', body: 'Hello @worker-wake-peer' } }, ownerHeaders), 201);
    const woke = await json(await held);
    assert.equal(woke.timedOut, false);
    assert.deepEqual(woke.pendingWakes.map(row => [row.kind, row.roomId, row.messageId]),
      [['mention', 'commons', 'worker-held-mention']]);
    const again = await json(await call('/api/agent-wakes/poll?hostId=worker-wake-host&waitMs=0', null, peerHeaders));
    assert.deepEqual(again.pendingWakes, woke.pendingWakes, 'poll does not consume the signal');
    await json(await call('/api/agent-heartbeats/ack', { signalIds: woke.pendingWakes.map(row => row.signalId) }, peerHeaders));
    assert.deepEqual((await json(await call('/api/agent-wakes/poll?hostId=worker-wake-host&waitMs=0', null, peerHeaders))).pendingWakes, []);
    settled = false;
    const revokedPoll = call(pollPath, null, peerHeaders).then(response => { settled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(settled, false);
    await json(await call(`/api/agent-keys/${key.keyId}/revoke`, { confirm: true }, identityHeaders));
    await json(await call('/api/rooms/commons/commands', { id: randomUUID(), type: 'message.posted',
      data: { messageId: 'worker-after-revoke', body: 'Again @worker-wake-peer' } }, ownerHeaders), 201);
    const denied = await json(await revokedPoll, 401);
    assert.equal(denied.error.code, 'unauthenticated'); assert.equal(denied.pendingWakes, undefined);
  } finally { await mf.dispose(); }
});
