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

