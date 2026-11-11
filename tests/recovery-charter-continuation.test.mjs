import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {initialRecoveryCharter,advanceRecoveryCharter} from '../server/recovery-charter-continuation.mjs';
import {seedHistoricalRedactionSource} from './helpers/historical-redaction-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const authorization=['synthetic','text','restore','1101'].join('-');
async function post(store,body){const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{Authorization:'Bearer '+authorization,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),authorization,store);return{status:response.status,body:await response.json()};}
async function setup(t){
 const source=new RoomStore(':memory:');t.after(()=>source.close());const _f=seedHistoricalRedactionSource(source,{beforeCapture:(store,{key})=>store.command(key,'legacy-room',{id:'charter-in-recovery',type:'room.charter_updated',data:{expectedRevision:0,purpose:'Coordinate useful work',outputs:null,boundaries:null,escalation:null}})});
 source.command(_f.key,'legacy-room',{id:'charter-after-normalized',type:'room.charter_updated',data:{expectedRevision:1,purpose:'Preserve edited normalized instructions',outputs:null,boundaries:null,escalation:null}});
 assert.doesNotThrow(()=>auditRecovery(source));
 const directory=mkdtempSync(join(tmpdir(),'charter-restore-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const filename=join(directory,'target.sqlite');const store=new RoomStore(filename);t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),calls=0;
 while(restoreProgress(store.db).progress?.audit?.stage!=='replay_events'){
  assert.equal(response.status,202,JSON.stringify(response));response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'prepare-text-'+calls++});assert.ok(calls<100);
 }
 const state=restoreProgress(store.db),step=p=>withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,state.restore_id,scratch=>advanceRecoveryCharter(store,scratch,state.restore_id,'legacy-room',p,state.seal)));
 return{source,store,state,step,filename};
}
test('independent charter phase preserves strict source history and checkpoint comparison',async t=>{
 const f=await setup(t);let p=initialRecoveryCharter(),calls=0;
 while(p.stage!=='complete'){const result=f.step(p);p=result.cursor;assert.ok(result.units<=32);assert.ok(++calls<100);}
 assert.equal(p.facts.ownerId,'owner');assert.equal(p.facts.current.purpose,'Preserve edited normalized instructions');assert.equal(p.sequence,f.source.headSequence('legacy-room'));
});
for(const mutation of ['owner','charter'])test('independent charter phase rejects substituted '+mutation,async t=>{
 const f=await setup(t);withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>{
 const room=scratch.get('actual','legacy-room','metadata','room');if(mutation==='owner')room.ownerId='worker';else room.charter.purpose='substituted';scratch.set('actual','legacy-room','metadata','room',room);
 }));let p=initialRecoveryCharter();assert.throws(()=>{for(let i=0;i<100&&p.stage!=='complete';i++)p=f.step(p).cursor;},/reconciliation/);
});
test('charter history interruption rolls back keyed facts with cursor',async t=>{
 const f=await setup(t),before=f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),p=initialRecoveryCharter();
 assert.throws(()=>withRestoreTransaction(f.store,()=>{withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryCharter(f.store,scratch,f.state.restore_id,'legacy-room',p,f.state.seal));throw Error('charter save interrupted');}),/charter save interrupted/);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),before);assert.deepEqual(p,initialRecoveryCharter());assert.ok(f.step(p).units>0);
});
test('actual operator admits charter only after durable independent phase and full oracle',async t=>{
 const f=await setup(t);let store=f.store,response,calls=0,saw=false;
 try{while(true){const state=restoreProgress(store.db);if(state.progress.audit.stage==='charter')saw=true;
 const input={restoreId:state.restore_id,sourceSeal:state.seal.id,expectedRevision:state.revision,requestId:'charter-full-'+calls};
 store.close();store=new RoomStore(f.filename);response=await post(store,input);assert.ok([200,202].includes(response.status),JSON.stringify(response));assert.deepEqual(await post(store,input),response);
 assert.ok(++calls<100);if(response.status===200)break;assert.throws(()=>store.headSequence('legacy-room'),e=>e.status===503);
 }assert.equal(saw,true);assert.equal(response.body.verified,true);assert.equal(response.body.reportVersion,1);assert.deepEqual(response.body.subsystemContinuation.charters,{rooms:1});assert.equal(response.body.subsystemContinuation.textResults.projected,1);assert.doesNotThrow(()=>auditRecovery(store));
 }finally{store.close();}
});
