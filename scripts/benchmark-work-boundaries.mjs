// Local SQLite experiment. Fixed-head commands roll back after each sample.
// Compare only the event-fact read; all other command work is identical.
import { performance } from 'node:perf_hooks';
import { RoomStore, PILOT_LIMITS } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { WORK_ITEM_BOARD_EVENT_SQL } from '../server/work-item-board.mjs';

const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(100, 1000, 10000);
if (sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000)) throw new Error('Counts must be 1..100000');
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const results = [];
for (const dimension of ['messages', 'workItems']) for (const size of sizes) {
  if (dimension === 'workItems' && size + 1 > PILOT_LIMITS.workItemsPerRoom) {
    results.push({ dimension, size, supported: false, rejection: 'workItemsPerRoom', limit: PILOT_LIMITS.workItemsPerRoom });
    continue;
  }
  const store = new RoomStore(':memory:', { workItemBoardBackfill: 'manual' });
  try {
    const events = initialRoom();
    const add = (type, data) => events.push(event({ id: `seed-${events.length}`, idempotencyKey: `seed-${events.length}`,
      roomId: 'commons', actorId: 'owner', at: new Date(Date.UTC(2026, 0, 1) + events.length * 1000).toISOString(), type, data }));
    add('work.proposed', { workItemId: 'target', title: 'Target', definitionOfDone: 'Measured result', mode: 'read', accountableMemberId: 'owner' });
    add('work.accepted', { workItemId: 'target', expectedRevision: 0 });
    add('work.started', { workItemId: 'target', expectedRevision: 1 });
    for (let i = 0; i < size; i++) {
      if (dimension === 'messages') add('message.posted', { messageId: `m-${i}`, body: `Unrelated ${i}. ${'content '.repeat(32)}` });
      else add('work.proposed', { workItemId: `w-${i}`, title: `Unrelated ${i}`, definitionOfDone: 'Unrelated task', mode: 'read', accountableMemberId: 'owner' });
    }
    store.initialize(events);
    store.roomFlood = { consume() {} };
    store.ensureEventTypeIndex();
    const token = store.issueAccessKey('commons', 'owner');
    const prepare = store.db.prepare.bind(store.db);
    let mode = 'indexed', profile = null;
    store.db.prepare = sql => {
      const effective = mode === 'allEvents' && sql === WORK_ITEM_BOARD_EVENT_SQL
        ? 'SELECT body FROM events WHERE room_id=? ORDER BY sequence' : sql;
      const statement = prepare(effective);
      return new Proxy(statement, { get(target, key) {
        const method = Reflect.get(target, key, target);
        if (typeof method !== 'function') return method;
        return (...bindings) => {
          const result = method.apply(target, bindings);
          if (profile) {
            profile.queries++;
            profile.boundBytes += Buffer.byteLength(JSON.stringify(bindings));
            if (sql === WORK_ITEM_BOARD_EVENT_SQL) profile.factRows += result.length;
          }
          return result;
        };
      } });
    };
    const rollback = new Error('sample rollback');
    const samples = { allEvents: [], indexed: [] };
    for (let iteration = 0; iteration < 14; iteration++) {
      for (mode of iteration % 2 ? ['indexed', 'allEvents'] : ['allEvents', 'indexed']) {
        try { store.transaction(() => {
          profile = { queries: 0, boundBytes: 0, factRows: 0 };
          const start = performance.now();
          store.command(token, 'commons', { id: 'measured-block', type: 'work.blocked',
            data: { workItemId: 'target', expectedRevision: 2, reason: 'Measured blocker', nextAction: 'Resolve the blocker' } });
          const ms = performance.now() - start;
          if (iteration >= 2) samples[mode].push({ ms, ...profile });
          profile = null;
          throw rollback;
        }); } catch (error) { if (error !== rollback) throw error; }
      }
    }
    results.push({ dimension, size, projectionBytes: Buffer.byteLength(prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection),
      samples: 12, modes: Object.fromEntries(Object.entries(samples).map(([name, rows]) => [name, {
        medianMs: percentile(rows.map(row => row.ms), 0.5), p95Ms: percentile(rows.map(row => row.ms), 0.95),
        maxQueries: Math.max(...rows.map(row => row.queries)), maxBoundBytes: Math.max(...rows.map(row => row.boundBytes)),
        maxFactRows: Math.max(...rows.map(row => row.factRows)),
      }])) });
  } catch (error) {
    if (error.code !== 'pilot_limit') throw error;
    results.push({ dimension, size, supported: false, rejection: error.code, message: error.message });
  } finally { store.close(); }
}
console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
  workload: 'one work.blocked command, fixed head; alternating indexed/all-event facts; 2 warmups, 12 samples; rollback excluded; synthetic local SQLite', results }, null, 2));
