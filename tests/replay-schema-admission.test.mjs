import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import * as cutover from '../server/replay-cutover.mjs';
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'replay-schema-')),filename=join(directory,'room.sqlite');
  let store=new RoomStore(filename);store.initialize(initialRoom());store.db.exec(cutover.replayCutoverSchema());
  const captured=cutover.captureReplayWitness(store,{roomId:'commons',requestId:'capture-schema',expectedHead:store.headSequence('commons'),reason:'Synthetic schema admission'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  let bytes=0;const step=n=>{const result=cutover.advanceReplayWitness(store,{roomId:'commons',generation:captured.generation,expectedBytes:bytes,requestId:'schema-step-'+n});bytes=result.bytes;return result;};
  return {get store(){return store;},step,reopen(){store.close();store=new RoomStore(filename);}};
}
function measure(db){
  const counts={definitions:0,versions:0,points:0},original=db.prepare.bind(db);
  db.prepare=sql=>{if(sql.includes('FROM sqlite_master WHERE name=?'))counts.definitions++;
    if(sql==='PRAGMA schema_version')counts.versions++;if(sql.includes('FROM sqlite_master WHERE rowid=?'))counts.points++;return original(sql);};
  return counts;
}
test('warm bounded steps revalidate bounded catalog rowids instead of full scans',t=>{
  const f=fixture(t),counts=measure(f.store.db);f.step(1);
  assert.equal(counts.definitions,0);assert.equal(counts.versions,0);assert.equal(counts.points,18);
});
test('DROP and exact recreate refuses until explicit readmission',t=>{
  const f=fixture(t),db=f.store.db,sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='replay_source_update'").get().sql;
  db.exec('DROP TRIGGER replay_source_update');db.exec(sql);
  assert.throws(()=>f.step(1),/schema.*reconciliation|readmission/);
  assert.throws(()=>f.step(2),/schema.*reconciliation|readmission/);
  cutover.admitReplayCutoverSchema(db);assert.equal(f.step(3).phase,'witness_verified');
});
test('unrelated DDL leaves exact current owned tuples valid without a rescan',t=>{
  const f=fixture(t),db=f.store.db;db.exec('CREATE TABLE synthetic_unrelated_schema(value TEXT)');
  const counts=measure(db);assert.equal(f.step(1).phase,'witness_verified');assert.equal(counts.definitions,0);assert.equal(counts.points,18);
});
test('reopen performs fresh exact admission and then uses its own connection cache',t=>{
  const f=fixture(t);f.reopen();const counts=measure(f.store.db);f.step(1);
  assert.equal(counts.definitions,18);counts.definitions=0;counts.versions=0;counts.points=0;f.step(2);
  assert.equal(counts.definitions,0);assert.equal(counts.versions,0);assert.equal(counts.points,18);
});
test('rolled back DDL restores current tuples without a hidden rescan',t=>{
  const f=fixture(t),db=f.store.db,before=db.prepare('PRAGMA schema_version').get().schema_version;
  assert.throws(()=>f.store.transaction(()=>{db.exec('DROP TRIGGER replay_source_update');throw Error('synthetic rollback');}),/synthetic rollback/);
  assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,before);
  const counts=measure(db);assert.equal(f.step(1).phase,'witness_verified');assert.equal(counts.definitions,0);
});

test('a changed trigger stays refused until its exact definition is explicitly readmitted',t=>{
  const f=fixture(t),db=f.store.db,sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='replay_source_update'").get().sql;
  db.exec('DROP TRIGGER replay_source_update');
  db.exec("CREATE TRIGGER replay_source_update AFTER UPDATE ON events BEGIN SELECT 1; END");
  assert.throws(()=>f.step(1),/reconciliation/);
  assert.throws(()=>cutover.admitReplayCutoverSchema(db),/reconciliation/);
  db.exec('DROP TRIGGER replay_source_update');db.exec(sql);
  assert.throws(()=>f.step(2),/reconciliation/);
  cutover.admitReplayCutoverSchema(db);assert.equal(f.step(3).phase,'witness_verified');
});
test('renaming an owned table refuses the complete catalog tuple',t=>{
  const f=fixture(t);f.store.db.exec('ALTER TABLE message_replay_units RENAME TO synthetic_renamed_units');
  assert.throws(()=>f.step(1),/reconciliation/);
});
test('an observed invalid schema remains invalid after transaction rollback until readmission',t=>{
  const f=fixture(t),db=f.store.db;
  assert.throws(()=>f.store.transaction(()=>{db.exec('DROP TRIGGER replay_source_update');assert.throws(()=>f.step(1),/reconciliation/);throw Error('synthetic outer rollback');}),/synthetic outer rollback/);
  assert.throws(()=>f.step(2),/reconciliation/);
  cutover.admitReplayCutoverSchema(db);assert.equal(f.step(3).phase,'witness_verified');
});
test('same-rowid identical recreate proves current tuples, not historical continuity',t=>{
  const f=fixture(t),db=f.store.db;
  const before=db.prepare("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE name='replay_body_before_insert'").get();
  db.exec('DROP TRIGGER replay_body_before_insert');db.exec(before.sql);
  const after=db.prepare("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE name='replay_body_before_insert'").get();
  assert.deepEqual(after,before,'SQLite really reused the final catalog rowid');
  assert.equal(f.step(1).phase,'witness_verified','this verifies the current byte-identical definition only');
});
