import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { patrolPendingSince } from '../server/patrol.mjs';
import { jobHealthView, applyOutcomes } from '../cloudflare/job-heartbeat.mjs';

function fixture(t) {
  let now = Date.now();
  const store = new RoomStore(':memory:', { now: () => now });
  t.after(() => store.close());
  store.initialize(initialRoom('patrol-health'));
  store.patrolTick();
  const key = store.issueAccessKey('patrol-health', 'owner');
  let stored = applyOutcomes({}, [{ job: 'patrol', ok: true, at: now }]);
  let id = 0;
  return { store, now: () => now, advance: ms => { now += ms; },
    post: () => store.command(key, 'patrol-health', { id: `message-${++id}`, type: 'message.posted', data: { body: 'Synthetic patrol work' } }),
    view: () => jobHealthView(stored, now, {}, store).jobs.find(row => row.name === 'patrol'),
    fail: () => { stored = applyOutcomes(stored, [{ job: 'patrol', ok: false, at: now, error: 'synthetic failure' }]); }
  };
}

test('fresh patrol activation gets bounded grace without hiding an older backlog or a failure', t => {
  const f = fixture(t);
  f.advance(3600000);
  assert.equal(f.view().status, 'disabled');
  f.post();
  const pending = f.now();
  assert.equal(f.view().status, 'ok');
  assert.equal(f.view().pendingSinceAt, new Date(pending).toISOString());
  assert.equal(f.view().secondsSinceSuccess, 3600, 'historical heartbeat is not rewritten');
  f.fail();
  assert.equal(f.view().status, 'failing');
  f.advance(181000);
  f.post();
  assert.equal(f.view().status, 'stale');
  assert.equal(patrolPendingSince(f.store, f.now()), pending, 'new writes do not restart the oldest backlog clock');
  f.store.patrolTick();
  assert.equal(f.view().status, 'disabled');
});

for (const at of [null, 'invalid', '2999-01-01T00:00:00.000Z']) test(`unknown patrol pending time stays stale: ${at}`, t => {
  const f = fixture(t);f.advance(3600000);f.post();
  const row = f.store.db.prepare('SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 1').get('patrol-health');
  const body = JSON.parse(row.body);body.at = at;
  f.store.db.prepare('UPDATE events SET body=? WHERE room_id=? AND sequence=?').run(JSON.stringify(body), 'patrol-health', row.sequence);
  assert.equal(f.view().status, 'stale');
  assert.equal(f.view().pendingSinceAt, null);
});

test('missing successor fails closed; current-head parked room does not supply freshness', t => {
  const f = fixture(t);f.advance(3600000);f.post();
  const head = f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('patrol-health').sequence;
  f.store.db.prepare('UPDATE patrol_cursor SET sequence=? WHERE room_id=?').run(head, 'patrol-health');
  f.store.db.prepare('UPDATE rooms SET sequence=? WHERE id=?').run(head + 1, 'patrol-health');
  assert.equal(f.view().status, 'stale');
  f.store.db.prepare('INSERT INTO patrol_blocks(room_id,sequence,head_seq,error_class,error) VALUES (?,?,?,?,?)').run('patrol-health', head,head+1,'synthetic','synthetic');
  assert.equal(patrolPendingSince(f.store, f.now()), null);
  assert.equal(f.view().status, 'disabled');
});

test('first-run pending freshness is bounded to 1000 rooms and never hides unknown overflow', t => {
  const store = new RoomStore(':memory:');t.after(() => store.close());
  const now = Date.now();
  const room = store.db.prepare('INSERT INTO rooms(id,sequence,projection) VALUES (?,1,?)');
  const event = store.db.prepare('INSERT INTO events(room_id,sequence,id,body) VALUES (?,1,?,?)');
  const add = i => { room.run(`pending-${i}`, '{}');event.run(`pending-${i}`, `event-${i}`, JSON.stringify({ at: new Date(now).toISOString() })); };
  store.transaction(() => { for (let i = 0; i < 1000; i++) add(i); });
  assert.equal(patrolPendingSince(store, now), now);
  const view = jobHealthView({}, now, {}, store).jobs.find(row => row.name === 'patrol');
  assert.equal(view.status, 'ok');assert.equal(view.lastSuccessAt, null);
  store.transaction(() => add(1000));
  assert.equal(patrolPendingSince(store, now), null);
  assert.equal(jobHealthView({}, now, {}, store).jobs.find(row => row.name === 'patrol').status, 'stale');
});
