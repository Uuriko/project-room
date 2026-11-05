import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {withRestoreTransaction,withExactRestoreGuards,RESTORE_CONTROL_GUARDS} from '../server/restore-admission.mjs';
const guards=RESTORE_CONTROL_GUARDS.filter(([name])=>name.startsWith('current_restore_admission_'));
function setup(t){const store=new RoomStore(':memory:');t.after(()=>store.close());return store;}
function observed(store,operation){const prepare=store.db.prepare.bind(store.db),queries=[];store.db.prepare=sql=>{if(/FROM sqlite_master WHERE name/.test(sql))queries.push(sql);return prepare(sql);};try{operation();}finally{store.db.prepare=prepare;}return queries;}
test('exact guard suspension uses two bounded name-set probes, preserving definitions',t=>{
 const store=setup(t),before=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'current_restore_admission_%' ORDER BY name").all();
 const queries=observed(store,()=>withRestoreTransaction(store,()=>withExactRestoreGuards(store.db,guards,()=>{})));
 assert.equal(queries.length,2);assert.ok(queries.every(sql=>/name IN \(\?,\?,\?\)/.test(sql)));
 assert.deepEqual(store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'current_restore_admission_%' ORDER BY name").all(),before);
});
for(const kind of ['missing','changed','wrong-table'])test(`guard batching refuses ${kind} definition before any suspension`,t=>{
 const store=setup(t),[name,sql]=guards[1];store.db.exec('DROP TRIGGER '+name);
 if(kind==='changed')store.db.exec(sql.replace('unsupported restore admission mutation','changed admission mutation'));
 if(kind==='wrong-table')store.db.exec(sql.replace(' ON current_restore_admission ',' ON current_restore_audit_scratch '));
 const exec=store.db.exec.bind(store.db);let drops=0;store.db.exec=sql=>{if(/^DROP TRIGGER /.test(sql))drops++;return exec(sql);};
 assert.throws(()=>withRestoreTransaction(store,()=>withExactRestoreGuards(store.db,guards,()=>assert.fail('operation entered'))),/reconciliation/);assert.equal(drops,0);
});
test('guard operation failure rolls back control and reinstalls exact guards',t=>{
 const store=setup(t),before=store.db.prepare('SELECT * FROM current_restore_admission').all();
 assert.throws(()=>withRestoreTransaction(store,()=>withExactRestoreGuards(store.db,guards,()=>{store.db.prepare('UPDATE current_restore_admission SET latest_receipt=?').run('synthetic');throw Error('injected save fault');})),/injected save fault/);
 assert.deepEqual(store.db.prepare('SELECT * FROM current_restore_admission').all(),before);
 assert.throws(()=>store.db.prepare('UPDATE current_restore_admission SET latest_receipt=?').run('forbidden'),/unsupported restore admission mutation/);
});
