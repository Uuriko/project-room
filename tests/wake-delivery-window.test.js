import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorWakeIndex, WAKE_INDEX_LIMITS } from '../server/operator-wake-index.mjs';
import { WAKE_INDEXES, WAKE_INDEX_RECEIPT, boundedWakeDeliveryActive, readWakeWindow, wakeIndexState, WAKE_WINDOW_LIMITS } from '../server/wake-delivery-window.mjs';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wake-window-')), filename = join(directory, 'room.sqlite');
  let store = new RoomStore(filename); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = { get store() { return store; }, reopen() { store.close(); store = new RoomStore(filename); },
    plan: () => operatorWakeIndex(store, { reason: 'Synthetic qualification' }),
    execute: (plan, extra = {}) => operatorWakeIndex(store, { reason: 'Synthetic qualification', planHash: plan.planHash, requestId: 'install', ...extra }, true),
    seed: (count, field = null) => store.transaction(() => {
      const insert = store.db.prepare("INSERT INTO agent_wake_signals VALUES(?,'agent','mention','commons',?,1,NULL)");
      for (let n = 0; n < count; n++) insert.run('s' + n.toString().padStart(6, '0'), field ?? 'm' + n);
    }) };
  return f;
}
test('all four indexes plus their exact original immutable receipt activate; startup/retry preserve them', t => {
  const f = fixture(t); f.seed(300);
  assert.equal(wakeIndexState(f.store.db), 'absent'); assert.equal(boundedWakeDeliveryActive(f.store.db), false);
  const plan = f.plan(); const first = f.execute(plan); assert.equal(first.duplicate, false);
  assert.equal(boundedWakeDeliveryActive(f.store.db), true);
  const bytes = f.store.db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(WAKE_INDEX_RECEIPT).counts_json;
  f.reopen(); assert.equal(boundedWakeDeliveryActive(f.store.db), true);
  assert.deepEqual(f.execute(plan), { ...first, duplicate: true });
  assert.equal(f.store.db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(WAKE_INDEX_RECEIPT).counts_json, bytes);
  assert.throws(() => f.execute(plan, { requestId: 'other' }), { code: 'idempotency_conflict' });
});
test('unreceipted optional indexes preserve legacy staging and operator rejects adoption', t => {
  const f = fixture(t);
  f.store.db.exec(WAKE_INDEXES[0].sql);
  assert.equal(boundedWakeDeliveryActive(f.store.db), false);
  assert.throws(f.plan, { code: 'wake_index_conflict' });
  for (const index of WAKE_INDEXES.slice(1)) f.store.db.exec(index.sql);
  assert.equal(boundedWakeDeliveryActive(f.store.db), false);
  const unreceipted = f.plan(); assert.equal(unreceipted.installed, true);
  assert.throws(() => f.execute(unreceipted), { code: 'wake_index_conflict' });
});
test('installation rollback includes all four indexes and success receipt; retry uses original plan', t => {
  const f = fixture(t); f.seed(1); const plan = f.plan();
  f.store.db.exec(`CREATE TRIGGER reject_wake_install BEFORE INSERT ON operator_actions WHEN NEW.id='${WAKE_INDEX_RECEIPT}' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END`);
  assert.throws(() => f.execute(plan), /synthetic interruption/);
  assert.equal(wakeIndexState(f.store.db), 'absent');
  assert.equal(f.store.db.prepare('SELECT 1 FROM operator_actions WHERE id=?').get(WAKE_INDEX_RECEIPT), undefined);
  f.store.db.exec('DROP TRIGGER reject_wake_install'); assert.equal(f.execute(plan).duplicate, false);
  f.store.db.exec('DROP INDEX ' + WAKE_INDEXES[1].name);
  assert.throws(() => boundedWakeDeliveryActive(f.store.db), { code: 'storage_unavailable' });
  assert.throws(() => f.execute(plan), { code: 'storage_unavailable' });
});
test('source-bound plan refuses changed input and installation admission refuses excess rows before DDL', t => {
  const f = fixture(t); const plan = f.plan(); f.seed(1);
  assert.throws(() => f.execute(plan), { code: 'plan_changed' }); assert.equal(wakeIndexState(f.store.db), 'absent');
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO agent_wake_signals VALUES(?,'agent','mention','commons',?,1,NULL)");
    for (let n = 1; n <= WAKE_INDEX_LIMITS.rows; n++) insert.run('s' + n.toString().padStart(6, '0'), 'm' + n);
  });
  assert.throws(f.plan, { code: 'wake_index_budget_exceeded' }); assert.equal(wakeIndexState(f.store.db), 'absent');
});
test('ordered scalar window advances equal timestamps without gaps and oversize refuses before wide read', t => {
  const f = fixture(t); f.seed(300); f.execute(f.plan());
  let after = null; const ids = [];
  for (let n = 0; n < 4; n++) {
    const page = readWakeWindow(f.store.db, 'agent_wake_signals', 'agent', after);
    assert.ok(page.rows.length <= WAKE_WINDOW_LIMITS.rows); assert.ok(page.admitted.bytes <= WAKE_WINDOW_LIMITS.bytes);
    ids.push(...page.rows.map(row => row.signal_id)); if (!page.more) break; after = page.through;
  }
  assert.equal(ids.length, 300); assert.equal(new Set(ids).size, 300);
  f.store.transaction(() => f.store.db.prepare("UPDATE agent_wake_signals SET message_id=? WHERE signal_id='s000000'").run('x'.repeat(1025)));
  let wideReads = 0; const original = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (/WHERE rowid=\?/.test(sql)) wideReads++; return original(sql); };
  assert.throws(() => readWakeWindow(f.store.db, 'agent_wake_signals', 'agent'), { code: 'storage_unavailable' }); assert.equal(wideReads, 0);
});
test('malformed original activation receipt cannot authorize either indexed source', t => {
  const f = fixture(t); for (const index of WAKE_INDEXES) f.store.db.exec(index.sql);
  f.store.transaction(() => f.store.db.prepare("INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,1,'wake_delivery_indexes_execute','database','wake_delivery','Synthetic',?,'{}','ok','install')").run(WAKE_INDEX_RECEIPT, 'a'.repeat(64)));
  assert.throws(() => boundedWakeDeliveryActive(f.store.db), { code: 'storage_unavailable' });
});
test('key byte installation admission precedes key transfer and DDL', t => {
  const f = fixture(t);
  f.store.transaction(() => f.store.db.prepare("INSERT INTO agent_wake_signals VALUES(?,'agent','mention','commons','m',1,NULL)").run('x'.repeat(WAKE_INDEX_LIMITS.keyBytes + 1)));
  let keyReads = 0; const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (/SELECT hex\(CAST\(agent_id AS BLOB\)\)/.test(sql)) keyReads++; return prepare(sql); };
  assert.throws(f.plan, { code: 'wake_index_budget_exceeded' }); assert.equal(keyReads, 0); assert.equal(wakeIndexState(f.store.db), 'absent');
});
test('invalid UTF8 in an admitted source field is a typed refusal without a returned page', t => {
  const f = fixture(t); f.seed(1); f.execute(f.plan());
  f.store.transaction(() => f.store.db.prepare("UPDATE agent_wake_signals SET message_id=CAST(x'80' AS TEXT) WHERE signal_id='s000000'").run());
  assert.throws(() => readWakeWindow(f.store.db, 'agent_wake_signals', 'agent'), { code: 'storage_unavailable' });
});
test('interruption after the first CREATE INDEX rolls back the pair and leaves original plan retryable', t => {
  const f = fixture(t); f.seed(1); const plan = f.plan(), exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => { if (sql === WAKE_INDEXES[1].sql) throw Error('synthetic second index failure'); return exec(sql); };
  assert.throws(() => f.execute(plan), /synthetic second index failure/);
  f.store.db.exec = exec; assert.equal(wakeIndexState(f.store.db), 'absent');
  assert.equal(f.store.db.prepare('SELECT 1 FROM operator_actions WHERE id=?').get(WAKE_INDEX_RECEIPT), undefined);
  assert.equal(f.execute(plan).duplicate, false);
});
test('UTF8 byte ordering matches SQLite BINARY and leading BOM source text is preserved', t => {
  const f = fixture(t);
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO agent_wake_signals VALUES(?,'agent','mention','commons',?,1,NULL)");
    insert.run('\uE000', '\uFEFFkept'); insert.run('\u{10000}', 'other');
  });
  f.execute(f.plan()); const page = readWakeWindow(f.store.db, 'agent_wake_signals', 'agent');
  assert.deepEqual(page.rows.map(row => row.signal_id), ['\uE000', '\u{10000}']);
  assert.equal(page.rows[0].message_id, '\uFEFFkept');
});
for (const table of ['agent_wake_signals', 'agent_work_wakes']) test('installation plan binds same-byte room moves in ' + table, t => {
  const f = fixture(t); f.store.initialize(initialRoom('outside'));
  f.store.transaction(() => {
    if (table === 'agent_wake_signals') f.store.db.prepare("INSERT INTO agent_wake_signals VALUES('signal','agent','mention','commons','message',1,NULL)").run();
    else f.store.db.prepare("INSERT INTO agent_work_wakes VALUES('signal','agent','commons','worker','task',0,'event','owner','{}',1,NULL,NULL)").run();
  });
  const plan = f.plan();
  f.store.transaction(() => f.store.db.prepare(`UPDATE ${table} SET room_id='outside' WHERE signal_id='signal'`).run());
  assert.throws(() => f.execute(plan), { code: 'plan_changed' });
  assert.equal(wakeIndexState(f.store.db), 'absent');
});
test('installation plan distinguishes nullable room key from empty TEXT', t => {
  const f = fixture(t);
  f.store.transaction(() => f.store.db.prepare("INSERT INTO agent_wake_signals VALUES('signal','agent','mention',NULL,'message',1,NULL)").run());
  const plan = f.plan();
  f.store.transaction(() => f.store.db.prepare("UPDATE agent_wake_signals SET room_id='' WHERE signal_id='signal'").run());
  assert.throws(() => f.execute(plan), { code: 'plan_changed' });
  assert.equal(wakeIndexState(f.store.db), 'absent');
});
