import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProjectionBodyHashMemo, storedProjection, hydrateProjection } from '../server/projection-at-rest.mjs';
import { RoomStore } from '../server/store.mjs';
const record = body => ({ body, sha: createHash('sha256').update(body).digest('hex') });

test('body hash memo bounds retained text across a growing fleet and replaces old text', () => {
  const memo = new ProjectionBodyHashMemo({ maxBytes: 2048, maxRooms: 3, maxEntries: 4 });
  for (let i = 0; i < 1000; i++) {
    memo.set(`room-${i}`, new Map([['message', record('x'.repeat(200))]]));
    assert.ok(memo.bytes <= 2048); assert.ok(memo.rooms.size <= 3); assert.ok(memo.entries <= 4);
  }
  assert.equal(memo.get('room-0').size, 0);
  assert.equal(memo.get('room-999').get('message').sha, record('x'.repeat(200)).sha);
  memo.set('room-999', new Map([['message', record('replacement')]]));
  assert.equal(memo.get('room-999').get('message').body, 'replacement');
  memo.set('room-999', new Map());
  assert.equal(memo.get('room-999').size, 0);
  for (const id of [...memo.rooms.keys()]) memo.delete(id);
  assert.equal(memo.bytes, 0); assert.equal(memo.entries, 0);
});

test('oversized bodies bypass memoization; small records remain eligible and entry count is bounded', () => {
  const memo = new ProjectionBodyHashMemo({ maxBytes: 2048, maxRooms: 2, maxEntries: 2 });
  memo.set('large', new Map([['huge', record('x'.repeat(5000))], ['small', record('small')]]));
  assert.equal(memo.get('large').has('huge'), false);
  assert.equal(memo.get('large').get('small').body, 'small');
  memo.set('many', new Map(Array.from({ length: 100 }, (_, i) => [`m${i}`, record('')] )));
  assert.ok(memo.entries <= 2); assert.ok(memo.bytes <= 2048);
});

test('serializer remains exact after cross-room eviction, rollback, and immediate body replacement', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const body = tag => `${tag}:${'content'.repeat(100)}`;
  const state = text => ({ messages: [{ id: 'm', body: text }] });
  const save = (room, text) => storedProjection(store.db, room, state(text), { enabled: true });
  const first = save('original', body('first'));
  for (let i = 0; i < 40; i++) save(`other-${i}`, body(`other-${i}`));
  assert.equal(save('original', body('first')), first, 'eviction cannot alter stored hashes');
  assert.throws(() => store.transaction(() => { save('original', body('rolled-back')); throw new Error('rollback'); }), /rollback/);
  assert.equal(save('original', body('first')), first, 'memo from refused transaction cannot determine authority');
  const replacement = save('original', body('replacement'));
  assert.deepEqual(hydrateProjection(store.db, 'original', JSON.parse(replacement), { workEntities: false }).state, state(body('replacement')));
  const rows = store.db.prepare('SELECT body FROM projection_bodies WHERE room_id=?').all('original');
  assert.deepEqual(rows.map(row => row.body), [body('replacement')], 'old text is still released immediately');
});

for (const mode of ['empty', 'inline', 'short']) test(`serializer drops obsolete cached plaintext on ${mode} rewrite`, t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  let captured;
  const original = ProjectionBodyHashMemo.prototype.set;
  ProjectionBodyHashMemo.prototype.set = function (...args) { captured = this; return original.apply(this, args); };
  try {
    storedProjection(store.db, 'room', { messages: [{ id: 'old', body: 'secret'.repeat(100) }] }, { enabled: true });
    assert.equal(captured.get('room').size, 1);
    const messages = mode === 'empty' ? [] : [{ id: 'new', body: mode === 'inline' ? 'new'.repeat(100) : 'short' }];
    storedProjection(store.db, 'room', { messages }, { enabled: mode !== 'inline' });
    assert.equal(captured.get('room').size, 0);
    assert.equal(captured.bytes, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM projection_bodies WHERE room_id=?').get('room').n, 0);
  } finally { ProjectionBodyHashMemo.prototype.set = original; }
});
