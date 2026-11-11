import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture, cloneNativeFixture, measureNative, resource } from './helpers/native-mention-context-fixture.mjs';
import { writeTalkPolicy } from '../server/agent-talk-policy.mjs';
import { canonicalNativeMentionPolicyContext } from '../server/native-mention-context.mjs';
import { runMcpOAuthRequest } from '../server/mcp-oauth.mjs';
const outbox = f => f.store.db.prepare('SELECT * FROM mcp_event_outbox ORDER BY event_id').all();
const policy = (f, value) => writeTalkPolicy(f.store.db, f.store.room('commons').state, {
  roomId: 'commons', actorId: 'owner', memberId: f.principal.memberId, policy: value
}, f.store.now(), (...args) => { throw Error(args.join(' ')); });

test('native point context returns only proved policy metadata and declines other event scopes', async t => {
  const f = await nativeFixture(t); f.post();
  const event = { name: 'room.requested', data: { roomId: 'commons', memberId: f.principal.memberId, messageId: 'native-update' } };
  const context = { kind: 'mention', actorId: 'coordinator' };
  const measured = await measureNative(f, () => f.store.transaction(() => canonicalNativeMentionPolicyContext(f.store, f.descriptor, event, context)));
  assert.deepEqual(Object.keys(measured.value).sort(), ['members', 'room']);
  assert.equal(measured.fullRoomReads, 0); assert.equal(measured.messageRows, 3);
  for (const kind of ['dm', 'work', 'board']) assert.equal(f.store.transaction(() => canonicalNativeMentionPolicyContext(f.store, f.descriptor, event, { ...context, kind })), null);
  assert.equal(f.store.transaction(() => canonicalNativeMentionPolicyContext(f.store, f.descriptor, { ...event, data: { ...event.data, memberId: 'owner' } }, context)), null);
});

test('a native invitation OAuth sender keeps its resource-scoped grant while posting bounded mentions', async t => {
  const f = await nativeFixture(t, 30);
  const measured = await measureNative(f, () => runMcpOAuthRequest({ store: f.store, provider: f.oauth.provider,
    token: f.tokens.accessToken, resource, roomId: 'commons', requiredScopes: ['chat:write'] }, () => f.store.command(f.tokens.accessToken, 'commons', {
    id: 'oauth-sender', type: 'message.posted', data: { messageId: 'oauth-sender', body: '@Coordinator checkpoint complete' }
  })));
  assert.equal(measured.value.event.actorId, f.principal.memberId);
  assert.equal(measured.fullRoomReads, 0); assert.ok(measured.messageRows <= 8);
  assert.throws(() => f.store.command(f.tokens.accessToken, 'commons', { id: 'outside-resource', type: 'message.posted', data: { messageId: 'outside-resource', body: 'Not admitted' } }));
});
for (const retained of [1000, 10000]) test(`installed native subscription bounds ordinary mention post and delivery at ${retained} messages`, async t => {
  const f = await nativeFixture(t, retained);
  const posted = await measureNative(f, () => f.post());
  const delivery = await measureNative(f, () => f.runtime.drain());
  t.diagnostic(JSON.stringify({ retained, post: { ...posted, value: undefined }, delivery: { ...delivery, value: undefined } }));
  assert.equal(f.deliveries.length, 1); assert.equal(outbox(f)[0].state, 'delivered');
  assert.equal(posted.fullRoomReads, 0); assert.ok(posted.messageRows <= 8); assert.ok(posted.messageBytes <= 8192);
  assert.equal(delivery.fullRoomReads, 0); assert.ok(delivery.messageRows <= 16); assert.ok(delivery.messageBytes <= 16384);
  assert.equal((await measureNative(f, () => f.post())).value.duplicate, true);
  assert.equal(outbox(f).length, 1);
});

test('bounded native post and signed delivery equal the retained full-context effects and receipts', async t => {
  const f = await nativeFixture(t), full = await cloneNativeFixture(t, f);
  full.store.canonicalMessagePostContext = () => null;
  const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => '11111111-1111-4111-8111-111111111111');
  const a = f.post(), b = full.post(); uuid.mock.restore(); assert.deepEqual(a, b);
  // A predating metadata proof selects the existing full callback policy path.
  // Restore the exact code-owned proof afterward; never mint an oracle hash.
  const proof = full.store.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get();
  full.store.db.prepare("UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id='commons'").run();
  await f.runtime.drain(); await full.runtime.drain();
  full.store.db.prepare("UPDATE integrity_room_state SET metadata_hash=? WHERE room_id='commons'").run(proof.metadata_hash);
  assert.deepEqual(f.deliveries, full.deliveries);
  for (const table of ['rooms', 'messages', 'work_entities', 'commands', 'events', 'mention_states', 'mention_observations', 'agent_wake_signals', 'activity_events', 'mcp_event_outbox', 'integrity_room_state']) {
    const read = fixture => fixture.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    assert.deepEqual(read(f), read(full), table);
  }
  assert.deepEqual(f.store.room('commons').state, full.store.room('commons').state);
});

test('zero subscriptions still permit a bounded ordinary mention without losing the post', async t => {
  const f = await nativeFixture(t, 30);
  f.store.db.prepare("UPDATE mcp_event_subscriptions SET state='inactive'").run();
  const measured = await measureNative(f, () => f.post());
  assert.equal(measured.fullRoomReads, 0); assert.ok(measured.messageRows <= 8);
  assert.equal(outbox(f).length, 0); assert.equal(measured.value.duplicate, false);
});

test('edited, deleted and missing queued messages preserve the full callback fallback', async t => {
  for (const change of ['edited', 'deleted', 'missing']) {
    const f = await nativeFixture(t);
    f.post();
    if (change === 'missing') f.store.db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='native-update'").run();
    else f.store.command(f.sender, 'commons', { id: change, type: `message.${change}`, data: { messageId: 'native-update', expectedMessageRevision: 0, ...(change === 'edited' ? { body: 'Revised checkpoint' } : {}) } });
    const measured = await measureNative(f, () => f.runtime.drain());
    assert.ok(measured.fullRoomReads > 0, change);
    assert.equal(f.deliveries.length, change === 'missing' ? 0 : 1, change);
    assert.equal(outbox(f)[0].state, change === 'missing' ? 'pending' : 'delivered');
  }
});

for (const barrier of ['queued', 'beforeSend']) for (const revoke of ['talk', 'grant', 'pause']) test(`${revoke} revocation at ${barrier} suppresses the queued callback`, async t => {
  const f = await nativeFixture(t); f.post();
  const action = () => {
    if (revoke === 'talk') policy(f, 'nobody');
    if (revoke === 'grant') f.oauth.provider.revoke(f.tokens.refreshToken);
    if (revoke === 'pause') f.store.wakeQueue.pause(f.owner, 'commons', { requestId: 'pause', reason: 'Stop' }, null, { memberId: f.principal.memberId });
  };
  if (barrier === 'queued') action(); else f.beforeSend(action);
  await f.runtime.drain();
  assert.equal(f.deliveries.length, 0); assert.equal(outbox(f)[0].state, 'dead');
});

test('known metadata and message proof corruption cannot become permissive callback absence', async t => {
  for (const damage of ['metadata', 'message']) {
    const f = await nativeFixture(t); f.post();
    if (damage === 'metadata') f.store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','Unproved') WHERE id='commons'").run();
    else f.store.db.prepare("UPDATE messages SET body='Unproved' WHERE room_id='commons' AND message_id='native-update'").run();
    await f.runtime.drain();
    assert.equal(f.deliveries.length, 0, damage); assert.equal(outbox(f)[0].state, 'pending', damage);
  }
});

for (const barrier of [1, 2, 3]) for (const source of ['metadata', 'candidate']) test(`${source} EIO at authorization barrier ${barrier} retries without a false acknowledgment`, async t => {
  const f = await nativeFixture(t); f.post();
  const prepare = f.store.db.prepare; let calls = 0;
  f.store.db.prepare = function(sql) {
    if (sql.includes(source === 'metadata' ? 'AS metadata_hash_bytes' : 'AS message_id_bytes') && ++calls === barrier)
      throw Object.assign(Error('injected native context storage failure'), { code: 'EIO' });
    return prepare.call(this, sql);
  };
  try { await f.runtime.drain(); } finally { f.store.db.prepare = prepare; }
  assert.equal(f.deliveries.length, 0); assert.equal(outbox(f)[0].state, 'pending'); assert.equal(outbox(f)[0].attempts, 1);
  f.store.now = () => f.clock + 5000;
  await f.runtime.drain();
  assert.equal(f.deliveries.length, 1); assert.equal(outbox(f)[0].state, 'delivered'); assert.equal(outbox(f)[0].attempts, 2);
  assert.equal(f.post().duplicate, true); assert.equal(outbox(f).length, 1);
});

for (const damage of ['metadata', 'message']) test(`${damage} corruption after DNS cannot become permissive before-send absence`, async t => {
  const f = await nativeFixture(t); f.post();
  f.beforeSend(() => {
    if (damage === 'metadata') f.store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','Unproved') WHERE id='commons'").run();
    else f.store.db.prepare("UPDATE messages SET body='Unproved' WHERE room_id='commons' AND message_id='native-update'").run();
  });
  await f.runtime.drain();
  assert.equal(f.deliveries.length, 0); assert.equal(outbox(f)[0].state, 'pending');
});

for (const barrier of ['queued', 'beforeSend']) for (const change of ['actor', 'target', 'mute', 'archive', 'trust']) test(`${change} policy change at ${barrier} preserves native refusal`, async t => {
  const f = await nativeFixture(t, 12, { crossOwner: change === 'trust' });
  if (change === 'trust') policy(f, 'room');
  f.post();
  const action = () => {
    if (change === 'actor' || change === 'target') {
      const id = change === 'actor' ? 'coordinator' : f.principal.memberId;
      const member = f.store.room('commons').state.members[id];
      f.store.command(f.owner, 'commons', { id: 'disable', type: 'member.access_changed', data: {
        memberId: id, expectedMemberRevision: member.revision, permissions: member.permissions, active: false
      } });
    }
    if (change === 'mute') {
      const key = f.store.issueAccessKey('commons', f.principal.memberId);
      f.store.command(key, 'commons', { id: 'mute', type: 'member.mute_set', data: { memberId: 'coordinator', muted: true } });
    }
    if (change === 'archive') f.store.command(f.owner, 'commons', { id: 'archive', type: 'room.archived', data: {} });
    if (change === 'trust') f.store.command(f.owner, 'commons', { id: 'trust', type: 'room.trust_set', data: { enabled: false } });
  };
  if (barrier === 'queued') action(); else f.beforeSend(action);
  await f.runtime.drain(); assert.equal(f.deliveries.length, 0); assert.equal(outbox(f)[0].state, 'dead');
});

for (const damage of ['metadata', 'message']) test(`oversized corrupt ${damage} cannot select a permissive full fallback`, async t => {
  const f = await nativeFixture(t); f.post();
  const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
  if (damage === 'metadata') f.store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title',?) WHERE id='commons'").run(oversized);
  else f.store.db.prepare("UPDATE messages SET body=? WHERE room_id='commons' AND message_id='native-update'").run(oversized);
  await f.runtime.drain(); assert.equal(f.deliveries.length, 0); assert.equal(outbox(f)[0].state, 'pending');
});
