import test from 'node:test';
import assert from 'node:assert/strict';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {initialRecoveryTextResults,advanceRecoveryTextResults} from '../server/recovery-text-results.mjs';
import {seedHistoricalRedactionSource} from './helpers/historical-redaction-source.mjs';
import {verifyCurrentRoomSchema} from '../server/current-room-repository.mjs';
import {textVersion} from '../server/text-results.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const authorization=['synthetic','text','restore','1101'].join('-');
async function post(store,body){const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{Authorization:'Bearer '+authorization,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),authorization,store);return{status:response.status,body:await response.json()};}
async function setup(t,{withdraw=false,history=null}={}){
 const source=new RoomStore(':memory:');t.after(()=>source.close());const f=history?(source.initialize(history,{representation:'normalized-current-v1'}),{key:source.issueAccessKey('commons','owner')}):seedHistoricalRedactionSource(source);
 if(withdraw)source.command(f.key,'legacy-room',{id:'withdraw-native-text',type:'message.deleted',data:{messageId:'saved-modern-result',expectedMessageRevision:0}});
 assert.doesNotThrow(()=>auditRecovery(source));
 const store=new RoomStore(':memory:');t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),calls=0;
 while(restoreProgress(store.db).progress?.audit?.stage!=='replay_events'){
  assert.equal(response.status,202,JSON.stringify(response));response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'prepare-text-'+calls++});assert.ok(calls<100);
 }
 const state=restoreProgress(store.db),step=p=>withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,state.restore_id,scratch=>advanceRecoveryTextResults(store,scratch,state.restore_id,'legacy-room',p,state.seal)));
 return{source,store,state,step};
}
for(const withdraw of [false,true])test('exact native-text subsystem completes against independent real restored work/message facts; withdrawn='+withdraw,async t=>{
 const f=await setup(t,{withdraw});let p=initialRecoveryTextResults(),calls=0,maximum=0;
 while(p.stage!=='complete'){const next=f.step(p);p=next.cursor;maximum=Math.max(maximum,next.bytes);assert.ok(next.units<=32);assert.ok(next.bytes<=4*1024*1024);assert.ok(++calls<100);}
 assert.equal(p.projected,1);assert.equal(p.audited,1);assert.equal(p.sequence,f.source.headSequence('legacy-room'));assert.ok(maximum>0);
});
for(const mutation of ['summary','missing-projected','duplicate-projected','wrong-text-version'])test('independent text phase refuses '+mutation,async t=>{
 const f=await setup(t),id=f.state.restore_id;
 withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,id,scratch=>{const work=scratch.get('actual','legacy-room','workBody','task');
  if(mutation==='summary')work.receipt.summary='substituted result';
  if(mutation==='missing-projected')work.receipt=null;
  if(mutation==='duplicate-projected')work.receiptHistory.push(structuredClone(work.receipt));
  if(mutation==='wrong-text-version')work.receipt.evidenceVersion='sha256:'+'0'.repeat(64);
  scratch.set('actual','legacy-room','workBody','task',work);
 }));
 let p=initialRecoveryTextResults();assert.throws(()=>{for(let i=0;i<100;i++){p=f.step(p).cursor;if(p.stage==='complete')break;}},/reconciliation/);
});
test('text phase save failure rolls back scratch as well as external cursor',async t=>{
 const f=await setup(t),before=f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),p=initialRecoveryTextResults();
 assert.throws(()=>withRestoreTransaction(f.store,()=>{withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryTextResults(f.store,scratch,f.state.restore_id,'legacy-room',p,f.state.seal));throw Error('text checkpoint interrupted');}),/text checkpoint interrupted/);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),before);assert.deepEqual(p,initialRecoveryTextResults());assert.ok(f.step(p).units>0);
});

test('legal sealed source event exceeding nominal quantum runs alone with reported actual bytes',async t=>{
 const source=new RoomStore(':memory:');t.after(()=>source.close());const history=initialRoom();history.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'large-source',title:'Retained work',definitionOfDone:'Exact metadata',accountableMemberId:'owner'}}));
 history.at(-1).legacyContext='x'.repeat(4*1024*1024+100);source.initialize(history,{representation:'normalized-current-v1'});assert.doesNotThrow(()=>auditRecovery(source));const store=new RoomStore(':memory:');t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),steps=0,large=false;
 while(response.body.pending){const prior=restoreProgress(store.db);response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'large-text-'+steps++});assert.ok([200,202].includes(response.status),JSON.stringify(response.body.error));
  if(prior.progress?.audit?.stage==='text_results'){const after=restoreProgress(store.db),charged=after.progress.audit.bytes-prior.progress.audit.bytes;if(charged>4*1024*1024){large=true;assert.equal(after.progress.audit.units-prior.progress.audit.units,1);}}
  assert.ok(steps<200);
 }
 assert.equal(large,true);assert.equal(response.body.verified,true);
});

test('receipt history covers external parent and exact proposal bases without repeated same-step work hydration',async t=>{
 const history=initialRoom(),roomId='commons',actorId='owner',workItemId='task';let revision=0,previous=null;
 const add=(type,data)=>{const incoming=event({roomId,actorId,type,data});history.push(incoming);return incoming;};
 add('work.proposed',{workItemId,title:'Result history',definitionOfDone:'Exact saved artifacts',accountableMemberId:'owner'});add('work.accepted',{workItemId,expectedRevision:revision++});
 for(let i=0;i<20;i++){
  const body='Exact result '+i,post=i?add('message.posted',{messageId:'result-'+i,workItemId,body,packetId:'packet-'+i,basisRevision:revision}):null;
  const completed=add('work.completed',{workItemId,expectedRevision:revision++,summary:'Result '+i,nextAction:'Review',producerId:'owner',...(post?{evidenceKind:'room_text',evidenceMessageId:'result-'+i,evidenceMessageEventId:post.id,evidenceVersion:textVersion(body),previousCompletionEventId:previous}:{evidenceUrl:'https://example.test/result',evidenceVersion:'external-v1'})});previous=completed.id;
  if(i<19){add('work.blocked',{workItemId,expectedRevision:revision++,reason:'Improve result',nextAction:'Continue'});add('work.started',{workItemId,expectedRevision:revision++,resolvedBlocker:'Resuming'});}
 }
 const f=await setup(t,{history}),prepare=f.store.db.prepare.bind(f.store.db);let workReads=0,calls=0,p=initialRecoveryTextResults();
 f.store.db.prepare=sql=>{const statement=prepare(sql),get=statement.get.bind(statement);if(sql.startsWith('SELECT payload FROM current_restore_audit_scratch'))statement.get=(...args)=>{if(args[3]==='workBody')workReads++;return get(...args);};return statement;};
 try{while(p.stage!=='complete'){p=withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryTextResults(f.store,scratch,f.state.restore_id,'commons',p,f.state.seal))).cursor;assert.ok(++calls<100);}}finally{f.store.db.prepare=prepare;}
 assert.equal(p.projected,19);assert.equal(p.audited,19);assert.ok(workReads<=calls,'at most one bounded work body read in each synchronous step');
});

test('schema location fallback refuses reinstalled changed guard SQL and recovers only exact original DDL',async t=>{
 const f=await setup(t);withRestoreTransaction(f.store,()=>verifyCurrentRoomSchema(f.store.db));
 const guard=f.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'current_room_guard_current_room_records_%' ORDER BY name LIMIT 1").get();assert.ok(guard);
 f.store.db.exec('DROP TRIGGER '+guard.name);f.store.db.exec(guard.sql.replace('BEGIN','BEGIN SELECT 1;'));
 assert.throws(()=>withRestoreTransaction(f.store,()=>verifyCurrentRoomSchema(f.store.db)),/schema requires reconciliation/);
 assert.throws(()=>f.step(initialRecoveryTextResults()),/owned serving schema changed/);
 f.store.db.exec('DROP TRIGGER '+guard.name);f.store.db.exec(guard.sql);
 assert.doesNotThrow(()=>withRestoreTransaction(f.store,()=>verifyCurrentRoomSchema(f.store.db)));assert.ok(f.step(initialRecoveryTextResults()).units>0);
});

test('text audit refuses ordinary, wrong-restore and wrong-seal callers before event payload transfer',async t=>{
 const f=await setup(t),p=initialRecoveryTextResults(),prepare=f.store.db.prepare.bind(f.store.db);let payloadReads=0;
 f.store.db.prepare=sql=>{if(/^SELECT (?:id,sequence,body|payload FROM)/.test(sql))payloadReads++;return prepare(sql);};
 try{
  assert.throws(()=>advanceRecoveryTextResults(f.store,{},f.state.restore_id,'legacy-room',p,f.state.seal),/reconciliation/);
  assert.throws(()=>withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryTextResults(f.store,scratch,'wrong-restore','legacy-room',p,f.state.seal))),/reconciliation/);
  assert.throws(()=>withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryTextResults(f.store,scratch,f.state.restore_id,'legacy-room',p,{...f.state.seal,id:'wrong-seal'}))),/reconciliation/);
 }finally{f.store.db.prepare=prepare;}
 assert.equal(payloadReads,0);
});
