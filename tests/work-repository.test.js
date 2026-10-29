import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { hydrateWorkItems, readWorkItem } from '../server/work-repository.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'work-repository-'));
  const filename = join(directory, 'room.sqlite');
  let store = new RoomStore(filename, options);
  store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (id, type, data) => store.command(token, 'commons', { id, type, data });
  const propose = id => command(`propose-${id}`, 'work.proposed', {
    workItemId: id, title: id, definitionOfDone: 'Evidence '.repeat(100), mode: 'read', accountableMemberId: 'owner',
  });
  return { get store() { return store; }, command, propose,
    reopen(opts) { store.close(); store = new RoomStore(filename, opts); } };
}
const raw = f => JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);

test('canonical records preserve full work state and write only the changed payload', t => {
  const f = fixture(t);
  f.propose('one'); f.propose('two');
  const before = structuredClone(f.store.room('commons').state.workItems);
  assert.equal(raw(f).workItems.one._workEntity, 1);
  assert.equal(raw(f).workItems.one.definitionOfDone, undefined);
  assert.deepEqual(readWorkItem(f.store.db, 'commons', 'one'), before.one);
  f.store.db.exec("CREATE TRIGGER forbid_other_work BEFORE UPDATE ON work_entities WHEN OLD.work_id='two' BEGIN SELECT RAISE(ABORT,'unrelated payload rewritten'); END");
  f.command('accept', 'work.accepted', { workItemId: 'one', expectedRevision: 0 });
  assert.deepEqual(f.store.room('commons').state.workItems.two, before.two);
  f.reopen();
  assert.equal(f.store.room('commons').state.workItems.one.state, 'accepted');
  assert.deepEqual(f.store.room('commons').state.workItems.two, before.two);
});

test('failed payload persistence rolls back the event, receipt and carrier', t => {
  const f = fixture(t); f.propose('one');
  const before = f.store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get();
  const entity = f.store.db.prepare("SELECT * FROM work_entities WHERE work_id='one'").get();
  f.store.db.exec("CREATE TRIGGER fail_work BEFORE UPDATE ON work_entities BEGIN SELECT RAISE(ABORT,'injected work failure'); END");
  assert.throws(() => f.command('accept', 'work.accepted', { workItemId: 'one', expectedRevision: 0 }), /injected work failure/);
  assert.deepEqual(f.store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get(), before);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM work_entities WHERE work_id='one'").get(), entity);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM commands WHERE id='accept'").get().n, 0);
  f.store.db.exec('DROP TRIGGER fail_work');
  f.command('accept', 'work.accepted', { workItemId: 'one', expectedRevision: 0 });
  assert.equal(f.store.room('commons').state.workItems.one.revision, 1);
});

test('inline migration and reversal are exact, repeatable and survive restart', t => {
  const f = fixture(t, { workEntities: false }); f.propose('one');
  const before = structuredClone(f.store.room('commons').state.workItems);
  assert.equal(raw(f).workItems.one._workEntity, undefined);
  assert.equal(f.store.migrateWorkProjections().converted, 1);
  assert.equal(f.store.migrateWorkProjections().converted, 0);
  assert.deepEqual(hydrateWorkItems(f.store.db, 'commons', raw(f)).workItems, before);
  f.reopen();
  assert.deepEqual(f.store.room('commons').state.workItems, before);
  assert.equal(f.store.migrateWorkProjections({ reverse: true }).converted, 1);
  assert.deepEqual(raw(f).workItems, before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM work_entities').get().n, 0);
  f.reopen({ workEntities: false });
  assert.deepEqual(f.store.room('commons').state.workItems, before);
});

test('interrupted conversion leaves the old carrier and is safe to retry', t => {
  const f = fixture(t, { workEntities: false }); f.propose('one');
  const before = raw(f);
  f.store.db.exec("CREATE TRIGGER fail_carrier BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'injected carrier failure'); END");
  assert.throws(() => f.store.migrateWorkProjections(), /injected carrier failure/);
  assert.deepEqual(raw(f), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM work_entities').get().n, 0);
  f.store.db.exec('DROP TRIGGER fail_carrier');
  assert.equal(f.store.migrateWorkProjections().converted, 1);
});

test('corrupt and cross-room references fail closed on cached and direct reads', t => {
  const f = fixture(t); f.propose('one');
  assert.throws(() => hydrateWorkItems(f.store.db, 'other-room', raw(f)), /work_projection_corrupt/);
  f.store.db.prepare("UPDATE work_entities SET body='{}' WHERE work_id='one'").run();
  assert.throws(() => f.store.room('commons'), /work_projection_corrupt/);
  assert.throws(() => readWorkItem(f.store.db, 'commons', 'one'), /work_projection_corrupt/);
});

for (const count of [1, 30]) test(`selected work context reads one entity payload among ${count} work items`, t => {
  const f = fixture(t, { now: () => 1793200000000 });
  for (let i = 0; i < count; i++) f.propose(`item-${i}`);
  const token = f.store.issueAccessKey('commons', 'owner');
  const expected = f.store.workContext(token, 'commons', 'item-0', { includeOffers: true });
  delete expected.offers; delete expected.offerContextVersion;
  const prepare = f.store.db.prepare.bind(f.store.db);
  let payloadRows = 0, payloadBytes = 0;
  t.mock.method(f.store.db, 'prepare', sql => {
    const statement = prepare(sql);
    if (!/SELECT .*body FROM work_entities/.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key !== 'get' && key !== 'all') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (...args) => {
        const result = target[key](...args);
        for (const row of (key === 'all' ? result : result ? [result] : [])) {
          payloadRows++; payloadBytes += Buffer.byteLength(row.body);
        }
        return result;
      };
    } });
  });
  assert.deepEqual(f.store.workContext(token, 'commons', 'item-0'), expected);
  assert.equal(payloadRows, 1, 'unrelated canonical work payloads must not cross the SQL boundary');
  assert.ok(payloadBytes < 4000, `selected payload bytes: ${payloadBytes}`);
  assert.throws(() => f.store.workContext(token, 'commons', 'missing'), error => error.code === 'work_not_found');
  f.store.revoke(token);
  assert.throws(() => f.store.workContext(token, 'commons', 'item-0'));
});

test('selected scope isolates unrelated corruption while offers and selected corruption still refuse', t => {
  const f = fixture(t); f.propose('one'); f.propose('two');
  const token = f.store.issueAccessKey('commons', 'owner');
  f.store.db.prepare("UPDATE work_entities SET body='{}' WHERE work_id='two'").run();
  assert.equal(f.store.workContext(token, 'commons', 'one').work.id, 'one');
  assert.throws(() => f.store.workContext(token, 'commons', 'one', { includeOffers: true }), /work_projection_corrupt/);
  f.store.db.prepare("UPDATE work_entities SET body='{}' WHERE work_id='one'").run();
  assert.throws(() => f.store.workContext(token, 'commons', 'one'), /work_projection_corrupt/);
});

test('selected work context is identical across inline, entity and mixed carriers', t => {
  const f = fixture(t, { workEntities: false, now: () => 1793200000000 });
  f.propose('one'); f.propose('two');
  const token = f.store.issueAccessKey('commons', 'owner');
  const expected = f.store.workContext(token, 'commons', 'one');
  const inline = raw(f).workItems.one;
  f.store.migrateWorkProjections();
  assert.deepEqual(f.store.workContext(token, 'commons', 'one'), expected);
  f.store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.workItems.one',json(?)) WHERE id='commons'").run(JSON.stringify(inline));
  assert.deepEqual(f.store.workContext(token, 'commons', 'one'), expected);
  assert.equal(raw(f).workItems.two._workEntity, 1);
});

for (const mutation of [
  "DELETE FROM work_entities WHERE work_id='one'",
  "UPDATE work_entities SET revision=revision+1 WHERE work_id='one'",
  "UPDATE work_entities SET digest=printf('%064d',0) WHERE work_id='one'",
  "UPDATE rooms SET projection=json_set(projection,'$.workItems.one.id','other') WHERE id='commons'",
]) test(`selected work refuses invalid entity binding: ${mutation}`, t => {
  const f = fixture(t); f.propose('one');
  const token = f.store.issueAccessKey('commons', 'owner');
  assert.equal(f.store.workContext(token, 'commons', 'one').work.id, 'one');
  f.store.db.exec(mutation);
  assert.throws(() => f.store.workContext(token, 'commons', 'one'), /work_projection_corrupt/);
});
