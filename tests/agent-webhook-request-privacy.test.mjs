import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';

const types = ['reply_request.progressed', 'reply_request.cancelled'];
const dnsResolvers = {resolve4: async () => ['93.184.216.34'], resolve6: async () => []};
function fixture(t, events = types) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const olive = store.identities.create('Olive'), parker = store.identities.create('Parker'), vega = store.identities.create('Vega');
  const roomId = 'request-webhook-privacy';
  new AgentRooms(store).create(olive.secret, {roomId, title: 'Private request tests', purpose: 'Synthetic tests', starter: false});
  for (const identity of [parker, vega]) store.invites.redeem(store.invites.create(olive.secret, roomId, {profile: 'member'}).code,
    {identitySecret: identity.secret, displayName: identity.displayName});
  store.dmConsents.request(roomId, parker.identityId, olive.identityId, 'Reply coordination');
  store.dmConsents.decide(roomId, olive.identityId, parker.identityId, 'approve');
  const send = (who, id, type, data) => store.command(who.secret, roomId, {id, type, data});
  send(parker, 'ask', 'message.posted', {messageId: 'ask', toMemberId: olive.identityId, requestKind: 'reply', body: 'Synthetic private ask'});
  const subs = new Map([olive, parker, vega].map(identity => [identity.identityId,
    store.agentPlugin.subscribeWebhook({identityId: identity.identityId, url: 'https://hooks.example.test/agent', events, secret: 'synthetic-test-secret'}).subscription]));
  const rows = () => store.db.prepare('SELECT * FROM agent_webhook_deliveries ORDER BY created_at,delivery_id').all();
  const drain = async () => {
    const sent = [];
    await store.agentPlugin.drainWebhookDeliveries({dnsResolvers, fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body)); return {status: 200, headers: {get: () => null}, text: async () => 'ok'};
    }});
    return sent;
  };
  const stale = (who, type, requestMessageId = 'ask') => store.agentPlugin.buildWebhookDelivery(subs.get(who.identityId).subscriptionId,
    {eventType: type, eventId: `old-${who.identityId}-${type}-${requestMessageId}`, roomId,
      data: {requestMessageId, expectedRequestRevision: 0, progress: 'working', note: 'PRIVATE-NOTE', reason: 'PRIVATE-REASON'}});
  return {store, roomId, olive, parker, vega, send, subs, rows, drain, stale};
}
for (const events of [types, ['*']]) test(`request follow-ups reach only participants (${events.join(',')})`, async t => {
  const f = fixture(t, events);
  f.send(f.olive, 'progress', types[0], {requestMessageId: 'ask', expectedRequestRevision: 0, progress: 'needs_input', note: 'PRIVATE-NOTE'});
  f.send(f.parker, 'cancel', types[1], {requestMessageId: 'ask', expectedRequestRevision: 0, reason: 'PRIVATE-REASON'});
  assert.equal(f.rows().filter(r => r.agent_id === f.vega.identityId).length, 0);
  for (const who of [f.olive, f.parker]) assert.equal(f.rows().filter(r => r.agent_id === who.identityId).length, 2);
  const sent = await f.drain(); assert.equal(sent.length, 4);
  assert.ok(sent.every(e => e.subscriptionId !== f.subs.get(f.vega.identityId).subscriptionId));
  assert.equal((await f.drain()).length, 0, 'successful deliveries are not repeated');
});
for (const type of types) test(`dispatch fences already-queued ${type} and preserves participant delivery`, async t => {
  const f = fixture(t); f.stale(f.vega, type); f.stale(f.olive, type);
  const sent = await f.drain();
  assert.equal(sent.length, 1); assert.equal(sent[0].subscriptionId, f.subs.get(f.olive.identityId).subscriptionId);
  assert.equal(f.rows().find(r => r.agent_id === f.vega.identityId).state, 'dead_letter');
  assert.equal((await f.drain()).length, 0, 'denied backlog must not retry');
});
for (const type of types) test(`unavailable context fails closed for ${type}`, async t => {
  const f = fixture(t);
  const outcome = f.store.agentPlugin.fanoutRoomEvent({roomId: f.roomId, event: {id: 'unknown', type, actorId: f.olive.identityId,
    data: {requestMessageId: 'missing', note: 'PRIVATE-NOTE', reason: 'PRIVATE-REASON'}}});
  assert.equal(outcome.deliveries, 0);
  f.stale(f.olive, type, 'missing');
  assert.equal((await f.drain()).length, 0);
  assert.equal(f.rows()[0].state, 'dead_letter');
});
test('revocation after enqueue still prevents dispatch', async t => {
  const f = fixture(t); f.stale(f.olive, types[0]);
  f.store.identities.revoke(f.olive.identityId, f.olive.secret);
  assert.equal((await f.drain()).length, 0);
});

// Shared read-path follow-up types must have the same audience on webhooks.
const siblings = ['message.edited', 'message.deleted', 'message.redacted', 'poll.voted', 'message.pinned', 'message.unpinned'];
test('editing the private opening request does not disclose its body', async t => {
  const f = fixture(t, ['message.edited']);
  f.send(f.parker, 'edit-ask', 'message.edited', {messageId: 'ask', expectedMessageRevision: 0, body: 'SYNTHETIC-PRIVATE-EDIT'});
  assert.equal(f.rows().filter(r => r.agent_id === f.vega.identityId).length, 0);
  assert.equal((await f.drain()).length, 2);
});
for (const type of siblings) test(`shared follow-up audience at enqueue and stale dispatch: ${type}`, async t => {
  const f = fixture(t, [type]);
  const data = {messageId: 'ask', body: 'SYNTHETIC-PRIVATE-EDIT'};
  f.store.agentPlugin.fanoutRoomEvent({roomId: f.roomId, event: {id: 'private-followup', type, actorId: f.parker.identityId, data}});
  assert.equal(f.rows().filter(r => r.agent_id === f.vega.identityId).length, 0);
  f.store.agentPlugin.buildWebhookDelivery(f.subs.get(f.vega.identityId).subscriptionId,
    {eventType: type, eventId: 'stale-private', roomId: f.roomId, data});
  assert.equal((await f.drain()).length, 2);
  assert.equal(f.rows().find(r => r.agent_id === f.vega.identityId).state, 'dead_letter');
  assert.equal((await f.drain()).length, 0);
});
for (const type of siblings) test(`known public follow-up reaches all subscribers: ${type}`, async t => {
  const f = fixture(t, [type]);
  f.send(f.parker, 'public', 'message.posted', {messageId: 'public', body: 'Public test'});
  const data = {messageId: 'public', body: 'Public edit'};
  f.store.agentPlugin.fanoutRoomEvent({roomId: f.roomId, event: {id: 'public-followup', type, actorId: f.parker.identityId, data}});
  assert.equal(f.rows().length, 3);
  assert.equal((await f.drain()).length, 3);
});
for (const type of siblings) test(`unknown follow-up context fails closed: ${type}`, async t => {
  const f = fixture(t, [type]);
  const data = {messageId: 'missing', body: 'Unknown private edit'};
  assert.equal(f.store.agentPlugin.fanoutRoomEvent({roomId: f.roomId,
    event: {id: 'unknown-followup', type, actorId: f.parker.identityId, data}}).deliveries, 0);
  f.store.agentPlugin.buildWebhookDelivery(f.subs.get(f.olive.identityId).subscriptionId,
    {eventType: type, eventId: 'stale-unknown', roomId: f.roomId, data});
  assert.equal((await f.drain()).length, 0);
});
