import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { messageProjectionArmingFromEnv } from '../server/message-entity-projection.mjs';

// Arming wiring for the dormant message entity projection (lane 1A-3).
// The three production constructors spread messageProjectionArmingFromEnv(env)
// into their RoomStore options. With the env unset the spread is empty and
// behaviour is byte-identical to the dormant defaults; with
// ROOM_MESSAGE_ENTITY_PROJECTION=1 a certified room's writes go entity-ref
// through the existing prepareMessageWrite gate (certification is the guard:
// an uncertified room keeps writing inline).

function armedStore(t, env) {
  const store = new RoomStore(':memory:', { ...messageProjectionArmingFromEnv(env) });
  t.after(() => store.close());
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const post = (id, body) => store.command(owner, 'commons', { id: `cmd-${id}`, type: 'message.posted', data: { messageId: id, body } });
  const storedMessages = () => JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection).messages;
  const certify = () => { while (!store.backfillMessages({ limit: 1000 }).done) {} store.checkMessagesParity({ roomId: 'commons' }); };
  return { store, post, storedMessages, certify };
}

test('env unset: arming helper is empty and the store stays dormant', t => {
  assert.deepEqual(messageProjectionArmingFromEnv({}), {});
  assert.deepEqual(messageProjectionArmingFromEnv({ ROOM_BODIES_AT_REST: '1' }), {});
  const { store } = armedStore(t, {});
  assert.equal(store.messageEntityProjection, false);
  assert.equal(store.messageProjectionWindow, null);
  assert.equal(store.maintainMessageCertification, false);
});

test('env armed: constructor flags arm, uncertified writes stay inline, certified writes emit entity refs', t => {
  const { store, post, storedMessages, certify } = armedStore(t, { ROOM_MESSAGE_ENTITY_PROJECTION: '1' });
  assert.equal(store.messageEntityProjection, true);
  assert.equal(store.messageProjectionWindow, 2000);
  assert.equal(store.maintainMessageCertification, true);

  // No certificate yet: the gate in prepareMessageWrite must fall back to a
  // fully inline projection — arming the deployment alone changes nothing
  // for an uncertified room.
  post('pre-1', 'written before certification');
  post('pre-2', 'also before certification');
  assert.ok(storedMessages().every(m => m._entity !== 1), 'uncertified room writes inline');

  // Per-room backfill + parity certification (lane 1A-2 runbook steps 1-3),
  // then the next write serialises the projection with entity refs.
  certify();
  post('post-1', 'written after certification');
  const messages = storedMessages();
  assert.equal(messages.length, 3);
  assert.ok(messages.every(m => m._entity === 1 && Object.keys(m).length === 2), `expected all entity refs, got ${JSON.stringify(messages)}`);

  // The armed projection loads back losslessly through the real store.
  const loaded = store.room('commons').state.messages;
  assert.deepEqual(loaded.map(m => [m.id, m.body]), [
    ['pre-1', 'written before certification'],
    ['pre-2', 'also before certification'],
    ['post-1', 'written after certification'],
  ]);
});

test('window override parses, and misconfiguration fails loud', () => {
  assert.deepEqual(
    messageProjectionArmingFromEnv({ ROOM_MESSAGE_ENTITY_PROJECTION: '1', ROOM_MESSAGE_PROJECTION_WINDOW: '500' }),
    { messageProjectionWindow: 500, messageEntityProjection: true });
  for (const bad of ['0', '-1', 'abc', '1.5', '']) {
    if (bad === '') continue; // empty window var means "use the default"
    assert.throws(
      () => messageProjectionArmingFromEnv({ ROOM_MESSAGE_ENTITY_PROJECTION: '1', ROOM_MESSAGE_PROJECTION_WINDOW: bad }),
      /ROOM_MESSAGE_PROJECTION_WINDOW/);
  }
  // A window without the arm flag is a configuration error, not a silent
  // window-only mode (window-only archiving is a different mechanism).
  assert.throws(
    () => messageProjectionArmingFromEnv({ ROOM_MESSAGE_PROJECTION_WINDOW: '500' }),
    /ROOM_MESSAGE_ENTITY_PROJECTION/);
});

test('all three production constructors wire the arming helper', () => {
  for (const path of ['../cloudflare/room.mjs', '../cloudflare/room-shard.mjs', '../server.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /messageProjectionArmingFromEnv\(/, `${path} must spread messageProjectionArmingFromEnv into its RoomStore options`);
  }
});
