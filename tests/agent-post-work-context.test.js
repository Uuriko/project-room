// First agent-coordination slice: ordinary top-level posts in rooms carrying
// canonical work references. Native callback policy has a separate context;
// round-limit resumes retain their full path. This is not a general claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore, PILOT_LIMITS } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { exportNdjsonText } from '../server/room-export.mjs';
import { replayNdjsonInto } from '../server/restore-ndjson.mjs';
import { auditRecovery } from '../server/recovery.mjs';

function fixture(t, { retained = 4, work = 1, permissions = [] } = {}) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const at = '2026-11-01T12:00:00.000Z', history = initialRoom();
  history.push(event({ id: 'add-agent', type: 'member.added', roomId: 'commons', actorId: 'owner', at,
    data: { memberId: 'coordinator', displayName: 'Coordinator', kind: 'agent', permissions } }));
  for (let i = 0; i < work; i++) history.push(event({ id: `propose-${i}`, type: 'work.proposed', roomId: 'commons', actorId: 'owner', at,
    data: { workItemId: `work-${i}`, title: `Task ${i}`, definitionOfDone: 'Report exact findings', mode: 'read', accountableMemberId: 'coordinator' } }));
  for (let i = 0; i < retained; i++) history.push(event({ id: `seed-event-${i}`, type: 'message.posted', roomId: 'commons', actorId: 'owner', at,
    data: { messageId: `seed-${i}`, body: `Retained message ${i}: ${'x'.repeat(64)}` } }));
  store.initialize(history);
  while (!store.backfillMessages({ limit: 1000 }).done) {}
  assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true);
  store.migrateMessageAuthority('commons');
  store.now = () => Date.parse(at) + 1000;
  return { store, token: store.issueAccessKey('commons', 'coordinator') };
}
const command = (id = 'update') => ({ id: `command-${id}`, type: 'message.posted', data: { messageId: id, body: 'Checkpoint complete; reviewing next task.' } });
function census(db) {
  const prepare = db.prepare, result = { messageRows: 0, messageBytes: 0, workPayloadRows: 0, workPayloadBytes: 0, statements: [] };
  db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    const message = /\b(?:FROM|JOIN)\s+messages\b/i.test(sql);
    const workPayload = /SELECT[^;]*\bbody\s+FROM\s+work_entities\b/i.test(sql);
    if (!message && !workPayload) return statement;
    result.statements.push(sql);
    const record = row => {
      if (row === undefined) return;
      if (message) { result.messageRows++; result.messageBytes += Buffer.byteLength(JSON.stringify(row)); }
      if (workPayload) { result.workPayloadRows++; result.workPayloadBytes += Buffer.byteLength(JSON.stringify(row)); }
    };
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args) => { const rows = target.all(...args); rows.forEach(record); return rows; };
      if (key === 'get') return (...args) => { const row = target.get(...args); record(row); return row; };
      if (key === 'iterate') return function* (...args) { for (const row of target.iterate(...args)) { record(row); yield row; } };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return { result, stop() { db.prepare = prepare; } };
}

for (const retained of [1000, 10000]) test(`agent post with work references bounds message reads at ${retained} retained`, t => {
  const { store, token } = fixture(t, { retained });
  const measured = census(store.db);
  try { assert.equal(store.command(token, 'commons', command()).duplicate, false); } finally { measured.stop(); }
  t.diagnostic(JSON.stringify({ retained, ...measured.result }));
  assert.ok(measured.result.messageRows <= 8, `loaded ${measured.result.messageRows} retained-message rows`);
  assert.ok(measured.result.messageBytes <= 8192);
  assert.equal(measured.result.workPayloadRows, 1);
  assert.ok(measured.result.statements.filter(sql => /FROM messages\b/.test(sql)).every(sql => /message_id\s*(?:=|IN\s*\()/i.test(sql)));
});

for (const work of [100, 400, PILOT_LIMITS.workItemsPerRoom]) test(`existing ${work}-work-item room uses admitted work payloads without message hydration`, t => {
  const { store, token } = fixture(t, { work, retained: 20 });
  const measured = census(store.db);
  try { store.command(token, 'commons', command()); } finally { measured.stop(); }
  assert.ok(measured.result.messageRows <= 8);
  assert.equal(measured.result.workPayloadRows, work);
  assert.ok(measured.result.workPayloadBytes <= PILOT_LIMITS.projectionBytes);
});

test('work row cap+1 and every oversized scalar refuse bounded hydration before payload reads', t => {
  for (const scalar of ['work_id', 'revision', 'digest', 'body', 'count', 'aggregate']) {
    const { store } = fixture(t);
    if (scalar === 'count') {
      const insert = store.db.prepare('INSERT INTO work_entities VALUES(?,?,?,?,?)');
      for (let i = 0; i < PILOT_LIMITS.workItemsPerRoom; i++) insert.run('commons', `orphan-${i}`, 0, 'unused', '{}');
    } else if (scalar === 'aggregate') {
      for (let i = 0; i < 2; i++) store.db.prepare('INSERT INTO work_entities VALUES(?,?,?,?,?)').run('commons', `orphan-${i}`, 0, 'unused', 'x'.repeat(PILOT_LIMITS.projectionBytes / 2 + 1));
    } else {
      const values = { work_id: 'orphan', revision: 0, digest: 'unused', body: '{}' };
      values[scalar] = 'x'.repeat(PILOT_LIMITS.projectionBytes + 1);
      store.db.prepare('INSERT INTO work_entities VALUES(?,?,?,?,?)').run('commons', values.work_id, values.revision, values.digest, values.body);
    }
    const measured = census(store.db);
    try { assert.equal(store.transaction(() => store.canonicalMessagePostContext('commons', command(), 'coordinator')), null, scalar); }
    finally { measured.stop(); }
    assert.equal(measured.result.workPayloadRows, 0, `${scalar}: no payload before admission`);
    assert.equal(measured.result.messageRows, 0, `${scalar}: fallback before candidate payload reads`);
  }
});

test('bounded work-ref posts equal full reducer, carrier, entity and receipt effects; retries are inert', t => {
  const { store, token } = fixture(t);
  const full = new RoomStore(':memory:'); t.after(() => full.close());
  replayNdjsonInto(exportNdjsonText(store.db), full); full.now = store.now;
  const fullToken = full.issueAccessKey('commons', 'coordinator'); full.canonicalMessagePostContext = () => null;
  const workBefore = store.db.prepare('SELECT * FROM work_entities ORDER BY work_id').all();
  const a = store.command(token, 'commons', command()), b = full.command(fullToken, 'commons', command());
  assert.equal(a.sequence, b.sequence); assert.equal(a.duplicate, b.duplicate);
  assert.deepEqual(store.room('commons').state, full.room('commons').state);
  assert.deepEqual(store.db.prepare('SELECT * FROM messages ORDER BY message_id').all(), full.db.prepare('SELECT * FROM messages ORDER BY message_id').all());
  assert.deepEqual(store.db.prepare('SELECT * FROM work_entities ORDER BY work_id').all(), workBefore);
  assert.deepEqual(store.db.prepare('SELECT * FROM commands ORDER BY id').all(), full.db.prepare('SELECT * FROM commands ORDER BY id').all());
  assert.equal(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection, full.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  store.canonicalMessagePostContext = () => { throw Error('retry cannot hydrate or choose context'); };
  assert.equal(store.command(token, 'commons', command()).duplicate, true);
  assert.deepEqual(store.room('commons').state, full.room('commons').state);
  assert.doesNotThrow(() => auditRecovery(store));
});

test('missing and same-head digest-corrupt work references fail without changing event, receipt or carrier', t => {
  for (const damage of ['missing', 'body', 'digest', 'revision']) {
    const { store, token } = fixture(t);
    const before = store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get();
    if (damage === 'missing') store.db.prepare("DELETE FROM work_entities WHERE room_id='commons' AND work_id='work-0'").run();
    else store.db.prepare(`UPDATE work_entities SET ${damage}=? WHERE room_id='commons' AND work_id='work-0'`).run(damage === 'revision' ? 99 : 'corrupt');
    assert.throws(() => store.command(token, 'commons', command()), /work_projection_corrupt/);
    assert.deepEqual(store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get(), before);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM commands WHERE id='command-update'").get().n, 0);
  }
});

test('round-limit paused work retains the full path and the original worker-post resume', t => {
  const { store, token } = fixture(t, { permissions: ['accept_work'] });
  const session = (id, type, data) => store.command(token, 'commons', { id, type,
    data: { workItemId: 'work-0', expectedRevision: store.room('commons').state.workItems['work-0'].revision, ...data } });
  session('start', 'session.started', {});
  session('pause', 'session.status_changed', { status: 'suspended', suspendReason: 'round_limit' });
  assert.equal(store.transaction(() => store.canonicalMessagePostContext('commons', command(), 'coordinator')), null);
  const before = store.headSequence('commons');
  store.command(token, 'commons', command());
  const item = store.room('commons').state.workItems['work-0'];
  assert.equal(item.status, 'active'); assert.equal(item.suspended_by, null);
  assert.equal(store.headSequence('commons'), before + 2, 'post and approved resume remain atomic events');
  assert.equal(store.command(token, 'commons', command()).duplicate, true);
  assert.equal(store.headSequence('commons'), before + 2);
});

test('native mentions use bounded post context and inactive agent writes remain refused', t => {
  const { store, token } = fixture(t, { retained: 20 });
  store.enqueueNativeMcpEvent = () => { throw Error('an unresolved mention cannot call delivery'); };
  const native = command(); native.data.body = '@UnknownAgent checkpoint';
  assert.ok(store.transaction(() => store.canonicalMessagePostContext('commons', native, 'coordinator')));
  const measured = census(store.db);
  try { store.command(token, 'commons', native); } finally { measured.stop(); }
  assert.ok(measured.result.messageRows <= 8, 'native mention admission does not hydrate history');
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'disable-agent', type: 'member.access_changed',
    data: { memberId: 'coordinator', expectedMemberRevision: store.room('commons').state.members.coordinator.revision, active: false, permissions: [] } });
  const before = store.headSequence('commons');
  assert.throws(() => store.command(token, 'commons', command('inactive')));
  assert.equal(store.headSequence('commons'), before);
});

test('message persistence failure rolls back work-ref post count, events, receipt and all work bytes', t => {
  const { store, token } = fixture(t);
  const before = store.room('commons'), work = store.db.prepare('SELECT * FROM work_entities').all();
  store.db.exec("CREATE TRIGGER refuse_agent_post BEFORE INSERT ON messages WHEN NEW.message_id='update' BEGIN SELECT RAISE(ABORT,'injected work-ref post failure'); END");
  assert.throws(() => store.command(token, 'commons', command()), /injected work-ref post failure/);
  assert.deepEqual(store.room('commons'), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM work_entities').all(), work);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM commands WHERE id='command-update'").get().n, 0);
  store.db.exec('DROP TRIGGER refuse_agent_post');
  assert.equal(store.command(token, 'commons', command()).duplicate, false);
});

test('work size admission storage failure rolls back and an exact retry commits once', t => {
  const { store, token } = fixture(t);
  const before = store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get();
  const prepare = store.db.prepare;
  store.db.prepare = function(sql) {
    if (sql.includes('AS id_bytes')) throw Object.assign(Error('injected work admission EIO'), { code: 'EIO' });
    return prepare.call(this, sql);
  };
  try { assert.throws(() => store.command(token, 'commons', command()), error => error.message === 'Storage is unavailable; no success is claimed' && error.cause?.code === 'EIO'); }
  finally { store.db.prepare = prepare; }
  assert.deepEqual(store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get(), before);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM commands WHERE id='command-update'").get().n, 0);
  assert.equal(store.command(token, 'commons', command()).duplicate, false);
  assert.equal(store.command(token, 'commons', command()).duplicate, true);
  assert.equal(store.headSequence('commons'), before.sequence + 1);
});
