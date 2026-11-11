import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {RoomStore} from '../server/store.mjs';import {exportNdjsonText} from '../server/room-export.mjs';import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';import {restoreProgress} from '../server/restore-admission.mjs';import {seedRecoveryInvitationSource} from './helpers/recovery-invitation-source.mjs';
const token='synthetic-independent-invitation-restore';
async function post(store,body){const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),token,store);return{status:response.status,body:await response.json()};}
test('actual operator durably verifies invitations before final oracle, survives save fault and cold retries',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'invitation-cold-recovery-')),filename=join(directory,'room.sqlite'),source=new RoomStore(':memory:');t.after(()=>{source.close();rmSync(directory,{recursive:true,force:true});});const expected=seedRecoveryInvitationSource(source).expected;
 let store=new RoomStore(filename),response=await post(store,exportNdjsonText(source.db));store.close();let calls=0,saw=false,faulted=false,lastInput;const ceilings=new Set();
 while(response.body.pending){store=new RoomStore(filename);try{
  const before=restoreProgress(store.db),input={restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'invitation-step-'+calls};lastInput=input;
  if(before.progress?.audit?.stage==='invitations'){
   saw=true;const prepare=store.db.prepare.bind(store.db);let fired=false;
   if(!faulted){store.db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);if(sql.startsWith('UPDATE current_restore_admission SET phase='))statement.run=(...args)=>{run(...args);fired=true;throw Error('invitation checkpoint save fault');};return statement;};
    try{const failed=await post(store,input);assert.equal(fired,true);assert.equal(failed.status,422);assert.deepEqual(restoreProgress(store.db),before);faulted=true;}finally{store.db.prepare=prepare;}
   }
  }
  response=await post(store,input);assert.ok([200,202].includes(response.status),JSON.stringify(response.body));assert.deepEqual(await post(store,input),response);calls++;
  if(response.body.pending){const progress=restoreProgress(store.db);assert.ok(!ceilings.has(progress.revision));ceilings.add(progress.revision);assert.throws(()=>store.headSequence('legacy-room'),error=>error.status===503);const sourceRows=progress.seal.tables.reduce((n,t)=>n+t.expected.rows,0);assert.ok(calls<sourceRows*8+progress.seal.events*16+2000);}
 }finally{store.close();}}
 assert.equal(saw,true,'invitation semantics must be durably checked before the original oracle');assert.equal(faulted,true);assert.equal(response.body.verified,true);assert.deepEqual(response.body.subsystemContinuation.invitations,expected);assert.equal(response.body.replayContinuation.originalFullOracleRequired,true);
 store=new RoomStore(filename);try{assert.equal(store.headSequence('legacy-room'),source.headSequence('legacy-room'));assert.deepEqual(store.verifyInvitationAudit(),expected);assert.deepEqual(await post(store,lastInput),response);}finally{store.close();}
 t.diagnostic(JSON.stringify({calls,independent:expected,saveFaultRollback:true,coldEveryStep:true,fullOracleRequired:true}));
});
