// Dependency contract under review: only canonical ordinary top-level posts
// with an explicit new message ID and body are candidates. Replies, DMs,
// work/request/channel/crosspost/special fields retain the full command path.
// Published/archived rooms, round-limit resumes and
// a connected room assistant also retain that path until independently proved.
// Members, room policy, channels and other bounded metadata remain available;
// @agent mentions keep their existing permission, trust and wake contracts.
//
// The eventual context must point-check the proposed ID (and its channel alias),
// preserve collision-row/metadata proofs, carry the old count plus one through
// the existing serializer, and publish no partial room cache. Command replay
// must return before context selection. No history scan, count scan, global
// checksum, backfill, self-certification or new authority format is permitted.
// Unrelated missing historical rows remain the existing full-read/recovery
// audit's responsibility: a point-only new post cannot certify their presence.
// Arbitrary message IDs are stored inside event JSON, not an indexed immutable
// ID registry: a missing row's old ID cannot be distinguished from a new ID by
// these point reads. A post never repairs the resulting count/replay drift.
// A newly occurring fan-out failure may still invoke the existing full recovery
// exception; the census qualifies normal admission, not recovery from that fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { exportNdjsonText } from '../server/room-export.mjs';
import { replayNdjsonInto } from '../server/restore-ndjson.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConversation } from '../server/conversation-sync.mjs';
import { journalActivityFanoutFailure } from '../server/activity.mjs';
import { runGuideStep } from '../server/room-guide.mjs';
import { seedStarter } from '../server/starter-room.mjs';

function canonicalFixture(t, retained) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const at = '2026-11-01T12:00:00.000Z';
  const history = initialRoom();
  for (let i = 0; i < retained; i++) history.push(event({
    id: `seed-event-${i}`, type: 'message.posted', roomId: 'commons',
    actorId: 'owner', at, data: { messageId: `seed-${i}`, body: `Retained message ${i}: ${'x'.repeat(64)}` }
  }));
  // Fixture-only qualification uses the existing replay/parity/conversion
  // path before counters begin. The measured command cannot invoke it.
  store.initialize(history);
  while (!store.backfillMessages({ limit: 1000 }).done) {}
  assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true);
  store.migrateMessageAuthority('commons');
  const token = store.issueAccessKey('commons', 'owner');
  store.now = () => Date.parse(at) + 1000;
  return { store, token };
}

function messageResultCensus(db) {
  const original = db.prepare;
  const census = { rows: 0, bytes: 0, statements: [] };
  db.prepare = function(sql) {
    const statement = original.call(this, sql);
    if (!/\b(?:FROM|JOIN)\s+messages\b/i.test(sql)) return statement;
    census.statements.push(sql);
    const record = row => {
      if (row === undefined) return;
      census.rows++;
      census.bytes += Buffer.byteLength(JSON.stringify(row));
    };
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args) => {
        const rows = target.all(...args); rows.forEach(record);
        return rows;
      };
      if (key === 'get') return (...args) => { const row = target.get(...args); record(row); return row; };
      if (key === 'iterate') return function* (...args) { for (const row of target.iterate(...args)) { record(row); yield row; } };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return { census, stop() { db.prepare = original; } };
}

for (const retained of [1000, 10000]) {
  test(`ordinary canonical post reads constant message rows/bytes with ${retained} retained messages`, t => {
    const { store, token } = canonicalFixture(t, retained);
    const measured = messageResultCensus(store.db);
    let result;
    try {
      result = store.command(token, 'commons', {
        id: 'bounded-post-command', type: 'message.posted',
        data: { messageId: 'new-top-level', body: 'A new ordinary message' }
      });
    } finally { measured.stop(); }
    assert.equal(result.duplicate, false);
    const raw = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
    assert.equal(raw.messageAuthority.count, retained + 1);
    assert.equal(Object.hasOwn(raw, 'messages'), false);
    t.diagnostic(JSON.stringify({ retained, messageRows: measured.census.rows, messageBytes: measured.census.bytes }));
    assert.ok(measured.census.rows <= 8,
      `post loaded ${measured.census.rows} message rows; qualified context must not hydrate retained history`);
    assert.ok(measured.census.bytes <= 8192,
      `post loaded ${measured.census.bytes} message-result bytes; target payload must remain bounded`);
    assert.ok(measured.census.statements.every(sql => /\bmessage_id\s*(?:=|IN\s*\()/i.test(sql)),
      'even aggregate/count scans over retained messages are forbidden');
  });
}

function post(store, token, id = 'ordinary', extra = {}) {
  return store.command(token, 'commons', { id: `command-${id}`, type: 'message.posted',
    data: { messageId: id, body: 'An ordinary post', ...extra } });
}

test('bounded posting agrees with the full reducer, entities, receipts and duplicate-ID refusals', t => {
  const { store, token } = canonicalFixture(t, 8);
  const full = new RoomStore(':memory:'); t.after(() => full.close());
  replayNdjsonInto(exportNdjsonText(store.db), full);
  full.canonicalMessagePostContext = () => null;
  full.now = store.now;
  const fullToken = full.issueAccessKey('commons', 'owner');
  const a = post(store, token), b = post(full, fullToken);
  assert.equal(a.sequence, b.sequence); assert.equal(a.duplicate, b.duplicate);
  for (const [id, extra] of [['alias:channel', {}], ['alias', {}],
    ['reply', { replyToId: 'seed-0', alsoSendToChannel: true }], ['private', { toMemberId: 'owner' }]]) {
    post(store, token, id, extra); post(full, fullToken, id, extra);
  }
  assert.deepEqual(store.room('commons').state, full.room('commons').state);
  const rows = s => s.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY seq,message_id").all();
  assert.deepEqual(rows(store), rows(full));
  const reject = (s, key) => {
    try { s.command(key, 'commons', { id: 'new-command-existing-id', type: 'message.posted', data: { messageId: 'seed-0', body: 'A collision' } }); }
    catch (error) { return [error.status, error.code, error.message]; }
    assert.fail('existing ID must be refused');
  };
  assert.deepEqual(reject(store, token), reject(full, fullToken));
  assert.doesNotThrow(() => auditRecovery(store));
});

test('an exact command retry returns before context and changes no message count', t => {
  const { store, token } = canonicalFixture(t, 5);
  const first = post(store, token);
  store.canonicalMessagePostContext = () => { throw Error('retry must not select context'); };
  const retry = post(store, token);
  assert.equal(retry.duplicate, true); assert.equal(retry.sequence, first.sequence);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id='commons'").get().n, 6);
});

test('a missing unrelated row is neither healed nor recounted/certified by a new post', t => {
  const { store, token } = canonicalFixture(t, 5);
  store.db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='seed-0'").run();
  const measured = messageResultCensus(store.db);
  try { post(store, token); } finally { measured.stop(); }
  const raw = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  assert.equal(raw.messageAuthority.count, 6, 'preserve trusted five, then add one; never recount four');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id='commons'").get().n, 5);
  assert.ok(measured.census.rows <= 8, 'the post does not scan or silently repair unrelated history');
  assert.throws(() => store.room('commons'), /canonical message count differs/);
  assert.throws(() => auditRecovery(store));
});

test('a missing candidate history row cannot silently establish a new healthy baseline', t => {
  const { store, token } = canonicalFixture(t, 5);
  store.db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='seed-0'").run();
  // Limitation: the event's arbitrary messageId has no independent point index.
  // Admission can accept this absent ID, but must preserve detectable drift.
  post(store, token, 'seed-0');
  const raw = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  assert.equal(raw.messageAuthority.count, 6);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id='commons'").get().n, 5);
  assert.throws(() => store.room('commons'), /canonical message count differs/);
  assert.throws(() => auditRecovery(store));
});

test('metadata and candidate collision proofs fail closed, without changing the head', t => {
  for (const corrupt of ['metadata', 'candidate']) {
    const { store, token } = canonicalFixture(t, 5);
    const head = store.headSequence('commons');
    if (corrupt === 'metadata') store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','Unproved') WHERE id='commons'").run();
    else store.db.prepare("UPDATE messages SET body='Unproved' WHERE room_id='commons' AND message_id='seed-0'").run();
    assert.throws(() => post(store, token, corrupt === 'candidate' ? 'seed-0' : 'new'), /projection_corrupt/);
    assert.equal(store.headSequence('commons'), head);
  }
});

test('an entity write failure rolls back projection, count, event, receipt and warm cache together', t => {
  const { store, token } = canonicalFixture(t, 5);
  const before = store.room('commons');
  store.db.exec("CREATE TRIGGER post_failure BEFORE INSERT ON messages WHEN NEW.message_id='failed' BEGIN SELECT RAISE(ABORT,'injected post failure'); END");
  assert.throws(() => post(store, token, 'failed'), /injected post failure/);
  assert.deepEqual(store.room('commons'), before);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM commands WHERE room_id='commons' AND id='command-failed'").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')='failed'").get().n, 0);
  store.db.exec('DROP TRIGGER post_failure');
  assert.equal(post(store, token, 'failed').duplicate, false);
  assert.equal(store.room('commons').state.messages.length, 6);
});

test('higher-context posts and maintenance modes retain the full command path', t => {
  const { store } = canonicalFixture(t, 5);
  for (const extra of [{ replyToId: 'seed-0' }, { toMemberId: 'owner' }, { workItemId: 'work' },
    { channelId: 'general' }, { requestKind: 'reply' }, { alsoSendToChannel: true }, { kind: 'poll' }, { messageId: '' }]) {
    assert.equal(store.canonicalMessagePostContext('commons', { type: 'message.posted', data: { messageId: 'new', body: 'Body', ...extra } }, 'owner'), null);
  }
  store.maintainMessageCertification = true;
  assert.equal(store.canonicalMessagePostContext('commons', { type: 'message.posted', data: { messageId: 'new', body: 'Body' } }, 'owner'), null);
});

test('ordinary @agent mentions retain real identity wake and mention behavior without history reads', t => {
  const { store, token } = canonicalFixture(t, 10);
  const target = store.identities.create('BoundedAgent');
  linkWithProof(store, token, 'commons', target, { memberId: 'agent', displayName: 'BoundedAgent', permissions: [] });
  store.agentHeartbeats.heartbeat({ agentId: target.identityId, hostId: 'host', mode: 'wakeable' });
  const measured = messageResultCensus(store.db);
  let posted;
  try { posted = post(store, token, 'mention', { body: '@BoundedAgent please read' }); }
  finally { measured.stop(); }
  assert.ok(measured.census.rows <= 8);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_wake_signals WHERE agent_id=? AND message_id='mention'").get(target.identityId).n, 1);
  assert.equal(store.mentionView('commons', posted.event.id, 'agent').state, 'delivered');
  store.enqueueNativeMcpEvent = () => {};
  assert.ok(store.transaction(() => store.canonicalMessagePostContext('commons', { type: 'message.posted', data: { messageId: 'native', body: '@BoundedAgent hi' } }, 'owner')));
});

test('bounded posting preserves private history and cold-reopen state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-post-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'room.sqlite');
  const { store, token } = canonicalFixture(t, 5);
  store.command(token, 'commons', { id: 'add-viewer', type: 'member.added',
    data: { memberId: 'viewer', displayName: 'Viewer', kind: 'human', permissions: [] } });
  store.command(token, 'commons', { id: 'private-post', type: 'message.posted',
    data: { messageId: 'private', body: 'PRIVATE HISTORY SENTINEL', toMemberId: 'owner' } });
  const disk = new RoomStore(path);
  replayNdjsonInto(exportNdjsonText(store.db), disk);
  const key = disk.issueAccessKey('commons', 'owner');
  post(disk, key, 'durable');
  const viewerKey = disk.issueAccessKey('commons', 'viewer');
  assert.equal(readConversation(disk, viewerKey, 'commons', {}).messages.some(message => message.id === 'private'), false);
  const before = disk.room('commons').state;
  assert.equal(before.messages.find(message => message.id === 'private').toMemberId, 'owner');
  disk.close();
  const reopened = new RoomStore(path); t.after(() => reopened.close());
  assert.deepEqual(reopened.room('commons').state, before);
  const raw = reopened.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  assert.equal(raw.includes('PRIVATE HISTORY SENTINEL'), false);
  assert.doesNotThrow(() => auditRecovery(reopened));
});

test('metadata requiring unqualified side-effect context falls back without loading work payloads', t => {
  const { store } = canonicalFixture(t, 5);
  const command = { type: 'message.posted', data: { messageId: 'new', body: 'Body' } };
  const original = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  for (const change of [raw => { raw.messagesArchive = { throughSeq: 1, count: 1, retainedIds: [] }; },
    raw => { raw.room.starterSeeded = { templateSlug: 'agent-pair' }; },
    raw => { raw.room.publicReceipts = { enabled: true }; }, raw => { raw.room.publicPage = { enabled: true }; },
    raw => { raw.workItems.w = { id: 'w', status: 'suspended', suspended_by: 'round_limit' }; }]) {
    const raw = JSON.parse(original); change(raw);
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(raw));
    assert.equal(store.canonicalMessagePostContext('commons', command, 'owner'), null);
  }
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(original);
  assert.throws(() => store.transaction(() => {
    const raw = JSON.parse(original); raw.workItems.w = { _workEntity: 1, id: 'w', revision: 0, digest: 'not-read' };
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(raw));
    store.canonicalMessagePostContext('commons', command, 'owner');
  }), /projection_corrupt/);
  store.db.prepare('INSERT INTO room_assistant_config VALUES(?,?)').run('commons', JSON.stringify({ coordinatorMemberId: 'agent' }));
  assert.equal(store.transaction(() => store.canonicalMessagePostContext('commons', command, 'owner')), null);
});

test('existing pending fanout recovery and human push retain the full path', t => {
  const { store } = canonicalFixture(t, 5);
  const command = { type: 'message.posted', data: { messageId: 'new', body: 'Body' } };
  journalActivityFanoutFailure(store, { roomId: 'commons', senderId: 'owner', command,
    incoming: { id: 'pending-recovery' }, error: Error('fixture failure') });
  assert.equal(store.transaction(() => store.canonicalMessagePostContext('commons', command, 'owner')), null);
  store.db.prepare("DELETE FROM activity_fanout_failures WHERE room_id='commons'").run();
  store.humanPush.vapid = { publicKey: 'fixture', privateKey: 'fixture', subject: 'fixture' };
  assert.equal(store.canonicalMessagePostContext('commons', {
    type: 'message.posted', data: { messageId: 'new', body: '@Room owner please read' }
  }, 'other-sender'), null);
});

test('legacy rooms are not converted and the context probe returns no inline projection', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  store.initialize(initialRoom());
  const command = { type: 'message.posted', data: { messageId: 'new', body: 'Body' } };
  assert.equal(store.canonicalMessagePostContext('commons', command, 'owner'), null);
  const raw = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  assert.equal(Object.hasOwn(raw, 'messageAuthority'), false);
  assert.equal(Object.hasOwn(raw, 'messages'), true);
  assert.equal(store.db.prepare("SELECT sequence,projection FROM rooms WHERE id=? AND json_type(projection,'$.messageAuthority') IS NOT NULL").get('commons'), undefined);
});

test('inactive canonical Guide verifies skip metadata and active starter Guide keeps its full path', t => {
  const { store, token } = canonicalFixture(t, 5);
  const room = store.room;
  store.room = () => { throw Error('inactive Guide must not hydrate'); };
  try { assert.equal(runGuideStep(store, 'commons'), null); } finally { store.room = room; }
  assert.throws(() => store.transaction(() => {
    store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.starterSeeded',0) WHERE id='commons'").run();
    runGuideStep(store, 'commons');
  }), /projection_corrupt/);
  seedStarter(store, 'commons', { intent: 'bug', ownerMemberId: 'owner' });
  assert.equal(store.canonicalMessagePostContext('commons', {
    type: 'message.posted', data: { messageId: 'starter-post', body: 'Body' }
  }, 'owner'), null);
  let fullReads = 0;
  store.room = function(...args) { fullReads++; return room.apply(this, args); };
  try { runGuideStep(store, 'commons'); } finally { store.room = room; }
  assert.ok(fullReads > 0, 'active starter Guide must retain full context');
  post(store, token, 'starter-post');
  assert.doesNotThrow(() => auditRecovery(store));
});
