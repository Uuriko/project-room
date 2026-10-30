import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';

function fixture(t) {
  const store = new RoomStore(':memory:', { bodiesAtRest: true });
  t.after(() => store.close());
  store.initialize([...initialRoom(), event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
    data: { memberId: 'reader', displayName: 'Reader', kind: 'human', permissions: [] } }),
  ...Array.from({ length: 512 }, (_, i) => event({ roomId: 'commons', actorId: 'owner', type: 'message.posted',
    data: { messageId: `unrelated-${i}`, body: 'Unrelated context' } }))]);
  const owner = store.issueAccessKey('commons', 'owner'), reader = store.issueAccessKey('commons', 'reader');
  store.dmConsents.request('commons', 'owner', 'reader', 'Test');
  store.dmConsents.decide('commons', 'reader', 'owner', 'approve');
  store.command(owner, 'commons', { id: 'ask', type: 'message.posted',
    data: { messageId: 'ask', body: 'Selected question', toMemberId: 'reader', requestKind: 'reply' } });
  const read = () => store.replyRequests.selected(reader, 'commons', 'ask', { limit: 1 });
  read(); // Warm projection: direct SQL corruption below must not be hidden by it.
  return { store, read };
}

test('selected reply context batches global event validation without one room-sized SQL result', t => {
  const { store, read } = fixture(t), prepare = store.db.prepare.bind(store.db);
  const batches = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes('AS event_id') || !sql.includes('FROM events')) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        if (key === 'all') batches.push(result.length);
        return result;
      };
    } });
  };
  const result = read();
  assert.deepEqual(result.page.items.map(item => item.message.id), ['ask']);
  assert.ok(result.current.answerBasis);
  assert.ok(batches.length >= 5, 'must still inspect all unrelated event metadata');
  assert.ok(batches.every(size => size <= 128), `unbounded metadata result: ${batches}`);
});

for (const mutation of ['gap', 'zero-sequence', 'event-id', 'posted-author', 'posted-time']) {
  test(`bounded reply event scan rejects unrelated ${mutation} corruption`, t => {
    const { store, read } = fixture(t);
    const row = store.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND json_extract(body,'$.data.messageId')=?")
      .get('commons', 'unrelated-300');
    if (mutation === 'gap') store.db.prepare('DELETE FROM events WHERE room_id=? AND sequence=?').run('commons', row.sequence);
    else if (mutation === 'zero-sequence') {
      const bad = { ...JSON.parse(row.body), id: 'invalid-zero-event' };
      store.db.prepare('INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)').run('commons', 0, bad.id, JSON.stringify(bad));
    } else {
      const bad = JSON.parse(row.body);
      if (mutation === 'event-id') bad.id = 'mismatching-id';
      if (mutation === 'posted-author') bad.actorId = 'reader';
      if (mutation === 'posted-time') bad.at = 'changed-time';
      store.db.prepare('UPDATE events SET body=? WHERE room_id=? AND sequence=?').run(JSON.stringify(bad), 'commons', row.sequence);
    }
    assert.throws(read, error => error.code === 'reply_history_changed');
  });
}
