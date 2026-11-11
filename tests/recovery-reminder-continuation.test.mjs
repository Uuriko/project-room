import {reportProgressGuard} from './helpers/recovery-report-progress.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress} from '../server/restore-admission.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {seedRecoveryReminderSource} from './helpers/recovery-reminder-source.mjs';
import {initialRecoveryReminders,validateRecoveryReminders} from '../server/recovery-reminder-continuation.mjs';
import {recoveryReminderStep} from '../server/recovery-reminder-rules.mjs';
test('persisted reminder cursors and receipt gaps refuse ambiguous recovery',()=>{
 const cursor=initialRecoveryReminders();assert.doesNotThrow(()=>validateRecoveryReminders(cursor));
 assert.throws(()=>validateRecoveryReminders({...cursor,unexpected:true}));
 assert.throws(()=>validateRecoveryReminders({...cursor,version:1}));
 assert.throws(()=>validateRecoveryReminders({...cursor,after:0.5}));
 assert.throws(()=>recoveryReminderStep({revision:1,state:'active',dueAt:10},{revision:3,state:'cancelled',dueAt:10}));
});
const credential='synthetic-durable-restore-00000000000000',url='https://room.example/api/operator/restore';
async function post(store,body){const json=typeof body!=='string';const response=await operatorRestoreResponse(new Request(url,{method:'POST',headers:{Authorization:'Bearer '+credential,...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(body):body}),credential,store);return{status:response.status,body:await response.json()};}
const next=(result,id)=>({restoreId:result.restoreId,sourceSeal:result.sourceSeal,expectedRevision:result.revision,requestId:id});
function setup(t,current=true){const directory=mkdtempSync(join(tmpdir(),'recovery-reminders-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const source=new RoomStore(':memory:');t.after(()=>source.close());const f=seedRecoveryReminderSource(source,{current});return{...f,source,filename:join(directory,'target.sqlite')};}
for(const current of [false,true])test('operator independently checks reminder ledger with cold resume and save fault; current='+current,async t=>{
 const f=setup(t,current),text=exportNdjsonText(f.source.db);let store=new RoomStore(f.filename),response=await post(store,text),steps=0,saw=0,faulted=false;
 const guard=reportProgressGuard(()=>store,assert);
 try{while(response.body.pending){const before=restoreProgress(store.db),mark=guard.before(before),input=next(response.body,'reminder_'+steps);if(before.progress?.audit?.stage==='reminders'){saw++;if(!faulted&&before.progress.audit.reminders.stage==='history'){const file=f.filename+'.request';writeFileSync(file,JSON.stringify(input));const child=spawnSync(process.execPath,['tests/fixtures/durable-coverage-operator-child.mjs',f.filename,file,'before-commit'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(child.status,77,child.stderr);assert.deepEqual(restoreProgress(store.db),before);faulted=true;}}
   store.close();store=new RoomStore(f.filename);response=await post(store,input);assert.ok([200,202].includes(response.status),JSON.stringify(response.body));assert.deepEqual(await post(store,input),response);if(response.body.pending)assert.throws(()=>store.headSequence('commons'),error=>error.status===503);steps++;guard.after(mark,restoreProgress(store.db));assert.ok(guard.summary().preReportCalls<200,'original pre-report bound remains');
  }
  assert.equal(response.status,200);assert.equal(response.body.verified,true);assert.ok(saw>=4);assert.equal(faulted,true);assert.deepEqual(response.body.subsystemContinuation.privateReminders,{complete:true,receipts:f.receipts,rows:4,groups:4});assert.doesNotThrow(()=>auditRecovery(store));assert.equal(store.db.prepare("SELECT revision FROM private_reminders WHERE work_item_id='gap'").get().revision,3);
 }finally{store.close();}
 t.diagnostic(JSON.stringify({current,receipts:f.receipts,rows:4,steps,reminderCalls:saw,processFaultRetry:true,phaseCalls:guard.summary(),fullOracleStillRequired:true}));
});
for(const fault of ['fingerprint','missing-first','duplicate-revision','missing-reminder','missing-human-binding','inactive-account','future-work-basis'])test('independent reminder phase refuses '+fault+' before full oracle',async t=>{
 const f=setup(t);
 f.source.transaction(()=>{
  if(fault==='fingerprint'||fault==='missing-first'){
   const name='private_reminder_commands_no_'+(fault==='missing-first'?'delete':'update'),sql=f.source.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;f.source.db.exec('DROP TRIGGER '+name);
   if(fault==='fingerprint')f.source.db.prepare("UPDATE private_reminder_commands SET fingerprint=? WHERE request_id='schedule-cancelled'").run('0'.repeat(64));else f.source.db.prepare("DELETE FROM private_reminder_commands WHERE request_id='schedule-cancelled'").run();f.source.db.exec(sql);
  }else if(fault==='duplicate-revision'){
   const request={requestId:'duplicate-revision',workItemId:'active',expectedRevision:0,action:'schedule',dueAt:Date.now()+100000},ordered=Object.fromEntries(Object.keys(request).sort().map(key=>[key,request[key]])),receipt={requestId:request.requestId,workItemId:'active',revision:1,state:'active',dueAt:request.dueAt};
   f.source.db.prepare("INSERT INTO private_reminder_commands VALUES('commons','owner',?,?,?)").run(request.requestId,createHash('sha256').update(JSON.stringify(ordered)).digest('hex'),JSON.stringify(receipt));
  }else if(fault==='missing-reminder')f.source.db.prepare("DELETE FROM private_reminders WHERE work_item_id='cancelled'").run();
  else if(fault==='inactive-account')f.source.db.prepare("UPDATE accounts SET active=0 WHERE id='reminder-account'").run();
  else if(fault==='future-work-basis')f.source.db.prepare("UPDATE private_reminders SET basis_work_revision=999 WHERE work_item_id='active'").run();
  else f.source.db.prepare("DELETE FROM member_accounts WHERE room_id='commons' AND member_id='owner'").run();
 });
 assert.throws(()=>auditRecovery(f.source));const store=new RoomStore(f.filename);t.after(()=>store.close());let response=await post(store,exportNdjsonText(f.source.db)),steps=0;
 while(response.status===202){const before=restoreProgress(store.db);response=await post(store,next(response.body,'negative_'+steps++));assert.ok(steps<200);if(response.status===422){assert.equal(before.progress.audit.stage,'reminders');assert.deepEqual(restoreProgress(store.db),before);}}
 assert.equal(response.status,422,JSON.stringify(response.body));assert.throws(()=>store.headSequence('commons'),error=>error.status===503);
});

test('large legacy context admits one sealed source atom and reports its actual charged bytes',async t=>{
 const f=setup(t,false),quantum=4*1024*1024;let projectionBytes=0,posts=0,now=f.source.now();f.source.now=()=>now;
 const size=()=>f.source.db.prepare("SELECT length(CAST(projection AS BLOB)) bytes FROM rooms WHERE id='commons'").get().bytes;
 while((projectionBytes=size())<quantum-6000){
  const bodyBytes=Math.max(1,Math.min(30000,Math.floor((quantum-4096-projectionBytes-1000)/3)));
  now+=3000;f.source.command(f.owner,'commons',{id:'large-context-'+posts,type:'message.posted',data:{messageId:'large-context-'+posts,body:'x'.repeat(bodyBytes)}});
  assert.ok(++posts<500);
 }
 assert.ok(projectionBytes<quantum);assert.doesNotThrow(()=>auditRecovery(f.source));
 const store=new RoomStore(f.filename);t.after(()=>store.close());let response=await post(store,exportNdjsonText(f.source.db)),steps=0,maximumCharged=0,sourceBound=0;
 const guard=reportProgressGuard(()=>store,assert);
 while(response.body.pending){const prior=restoreProgress(store.db),mark=guard.before(prior);if(prior.progress.audit?.stage==='reminders'){
   const rooms=prior.seal.tables.find(row=>row.name==='rooms'),reminders=prior.seal.tables.find(row=>row.name==='private_reminders');const work=prior.seal.tables.find(row=>row.name==='work_entities');sourceBound=rooms.maxRowBytes+reminders.maxRowBytes+work.maxRowBytes+12288;
  }
  response=await post(store,next(response.body,'large_reminder_'+steps++));assert.ok([200,202].includes(response.status),JSON.stringify(response.body));
  const after=restoreProgress(store.db);if(prior.progress.audit?.stage==='reminders'&&after.progress?.audit){const charged=after.progress.audit.bytes-prior.progress.audit.bytes;maximumCharged=Math.max(maximumCharged,charged);assert.ok(charged<=sourceBound);}
  guard.after(mark,after);assert.ok(guard.summary().preReportCalls<250,'original pre-report bound remains');
 }
 assert.ok(maximumCharged>quantum);assert.equal(response.status,200);assert.equal(response.body.subsystemContinuation.privateReminders.complete,true);
 t.diagnostic(JSON.stringify({sourcePlatform:'node-sqlite',phaseCalls:guard.summary(),projectionBytes,posts,maximumChargedBytes:maximumCharged,explicitSealedBound:sourceBound,quantumBytes:quantum,strictQuantum:false,workerLargeRowAcceptanceClaimed:false,fullOracleStillRequired:true}));
});
