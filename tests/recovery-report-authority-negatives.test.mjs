import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {beginRestore,checkpointRestore,restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {withRecoveryReportFingerprint,recoveryReportFingerprint} from '../server/recovery-report-scope.mjs';
import {verifyRecoveryReportScratch,deleteRecoveryReportScratch} from '../server/recovery-report-cleanup.mjs';
function setup(t){const store=new RoomStore(':memory:');t.after(()=>store.close());const id=beginRestore(store);withRestoreTransaction(store,()=>checkpointRestore(store.db,{restoreId:id,expectedRevision:0,phase:'audit_pending',seal:{syntheticScratchHarness:true},progress:{audit:{stage:'full_audit_pending',report:null}},latest:null}));return{store,id};}
const rows=store=>store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all();
function seed(f,values){withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.id,s=>{for(const [domain,key,value,lane='report',room='messages']of values)s.put(lane,room,domain,key,value);}));}
test('fingerprint consumption cannot grant an operation from an absent/incomplete persisted report or caller certificate',t=>{
 const f=setup(t),before=restoreProgress(f.store.db);let entered=false,admitted=false;
 assert.equal(recoveryReportFingerprint(f.store),null);
 const attempt=()=>withRecoveryReportFingerprint(f.store,f.id,{assertSealedSource(){admitted=true;},dataSha256:'0'.repeat(64),tables:[]},()=>{entered=true;});
 assert.throws(attempt,/requires reconciliation/);assert.throws(()=>withRestoreTransaction(f.store,attempt),/requires reconciliation/);assert.equal(entered,false);assert.equal(admitted,false);assert.equal(recoveryReportFingerprint(f.store),null);assert.deepEqual(restoreProgress(f.store.db),before);
});
for(const mutation of ['foreign-id','foreign-lane','unowned-domain','false-zero','wrong-count'])test('workspace cleanup refuses '+mutation+' without changing rows or guards',t=>{
 const f=setup(t),entry=mutation==='unowned-domain'?['unowned','x',1]:['fingerprint-index0','0000000000000000',0,mutation==='foreign-lane'?'actual':'report'];seed(f,[entry]);
 const before=rows(f.store),ddl=f.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'current_restore_audit_scratch_%' ORDER BY name").all(),remaining=mutation==='false-zero'?0:mutation==='wrong-count'?2:1,id=mutation==='foreign-id'?'not-'+f.id:f.id;
 assert.throws(()=>withRestoreTransaction(f.store,()=>deleteRecoveryReportScratch(f.store.db,id,remaining)),/requires reconciliation/);assert.deepEqual(rows(f.store),before);assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'current_restore_audit_scratch_%' ORDER BY name").all(),ddl);
});
test('workspace cleanup requires transaction authority and proves actual emptiness after bounded pages',t=>{
 const f=setup(t);assert.throws(()=>verifyRecoveryReportScratch(f.store.db,f.id,0),/requires reconciliation/);assert.throws(()=>deleteRecoveryReportScratch(f.store.db,f.id,0),/requires reconciliation/);
 for(const [start,count]of[[0,128],[128,2]])seed(f,Array.from({length:count},(_,i)=>['fingerprint-index0',String(start+i).padStart(16,'0'),start+i]));
 assert.equal(rows(f.store).length,130);let result=withRestoreTransaction(f.store,()=>deleteRecoveryReportScratch(f.store.db,f.id,130));assert.deepEqual(result,{removed:128,remaining:2});assert.equal(rows(f.store).length,2);
 result=withRestoreTransaction(f.store,()=>deleteRecoveryReportScratch(f.store.db,f.id,2));assert.deepEqual(result,{removed:2,remaining:0});assert.equal(rows(f.store).length,0);withRestoreTransaction(f.store,()=>verifyRecoveryReportScratch(f.store.db,f.id,0));
 assert.throws(()=>f.store.db.prepare("INSERT INTO current_restore_audit_scratch VALUES(?,'report','messages','fingerprint-index0','0000000000000000',0,1,'0')").run(f.id),/unsupported restore admission mutation/,'helper restores the original SQL guard; empty-table DELETE would fire no row trigger');assert.equal(rows(f.store).length,0);
});
