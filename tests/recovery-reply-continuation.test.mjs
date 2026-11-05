import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {initialRecoveryReplies,advanceRecoveryReplies} from '../server/recovery-reply-continuation.mjs';
import {seedHistoricalRedactionSource} from './helpers/historical-redaction-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {planCanonicalReplayCapture} from '../server/replay-canonical-plan.mjs';
import {withCurrentAuditUnits,readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
const authorization=['synthetic','text','restore','1101'].join('-');
async function post(store,body){const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{Authorization:'Bearer '+authorization,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),authorization,store);return{status:response.status,body:await response.json()};}
async function setup(t,{checkpoint=false,checkpointMutation=null,withdraw=false,archive=false,scenario=null}={}){
 const source=new RoomStore(':memory:');t.after(()=>source.close());const _f=seedHistoricalRedactionSource(source,{beforeCapture:(store,{key,workerKey})=>{store.command(key,'legacy-room',{id:'request-before-H',type:'message.posted',data:{messageId:'source-question',body:'Please review the saved result',toMemberId:'worker',workItemId:'task',requestKind:'reply'}});if(scenario==='response'){const context=store.command(key,'legacy-room',{id:'request-context',type:'message.posted',data:{messageId:'request-context',body:'A relevant context follow-up',replyToId:'source-question',toMemberId:'worker',workItemId:'task'}});store.command(workerKey,'legacy-room',{id:'request-answer',type:'message.posted',data:{messageId:'request-answer',body:'Reviewed and saved',toMemberId:'owner',replyToId:'source-question',workItemId:'task',responseToRequestId:'source-question',expectedRequestRevision:0,responseOutcome:'answered',contextEventId:context.event.id,contextSequence:context.sequence}});}
 if(scenario==='transfer-cancel'){store.command(key,'legacy-room',{id:'add-human-owner',type:'member.added',data:{memberId:'alice',displayName:'Alice',kind:'human',permissions:[]}});const nextKey=store.issueAccessKey('legacy-room','alice');store.command(key,'legacy-room',{id:'transfer-room',type:'ownership.transferred',data:{toMemberId:'alice',reason:'Synthetic recovery authority'}});store.command(nextKey,'legacy-room',{id:'new-owner-cancel',type:'reply_request.cancelled',data:{requestMessageId:'source-question',expectedRequestRevision:0,reason:'Owner reconciled the request'}});}
 if(archive){while(!store.backfillMessages({limit:200}).done){}assert.equal(store.checkMessagesParity({roomId:'legacy-room'}).ok,true);assert.equal(store.archiveMessages('legacy-room',{keepNewest:2,dryRun:false}).ok,true);assert.equal(store.checkMessagesParity({roomId:'legacy-room'}).ok,true);store.migrateMessageAuthority('legacy-room');}},captureOptions:archive?store=>{const plan=planCanonicalReplayCapture(store,{roomId:'legacy-room',expectedHead:store.headSequence('legacy-room')});assert.equal(plan.certified,false);return{contentBasis:plan.contentBasis,contentPlanHash:plan.planHash};}:undefined});
 if(checkpoint){const state=source.readTransaction(()=>readCurrentRoomForAudit(source,'legacy-room')).state;if(archive)state.messages=source.readTransaction(()=>withCurrentAuditUnits(source,'legacy-room',reader=>source.db.prepare('SELECT message_id FROM messages WHERE room_id=? ORDER BY seq,message_id').all('legacy-room').map(row=>reader.message(row.message_id).value)));checkpointMutation?.(state);source.transaction(()=>source.db.prepare('INSERT INTO projection_checkpoints VALUES(?,?,?)').run('legacy-room',source.headSequence('legacy-room'),JSON.stringify(state)));source.command(_f.key,'legacy-room',{id:'after-checkpoint-context',type:'message.posted',data:{messageId:'tail-context',body:'Additional saved context',replyToId:'source-question',toMemberId:'worker',workItemId:'task'}});}
 if(withdraw)source.command(_f.key,'legacy-room',{id:'withdraw-question',type:'message.deleted',data:{messageId:'source-question',expectedMessageRevision:0}});
 if(checkpointMutation)assert.throws(()=>auditRecovery(source),/reconciliation/);else assert.doesNotThrow(()=>auditRecovery(source));
 const directory=mkdtempSync(join(tmpdir(),'recovery-replies-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const filename=join(directory,'target.sqlite'),store=new RoomStore(filename);t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),calls=0;
 while(restoreProgress(store.db).progress?.audit?.stage!=='replay_events'){
  assert.equal(response.status,202,JSON.stringify(response));response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'prepare-text-'+calls++});assert.ok(calls<100);
 }
 const state=restoreProgress(store.db),step=(p,options)=>withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,state.restore_id,scratch=>advanceRecoveryReplies(store,scratch,state.restore_id,'legacy-room',p,state.seal,options)));
 return{source,store,state,step,filename};
}
test('independent request history preserves authority and exact retained message fields',async t=>{
 const f=await setup(t);let p=initialRecoveryReplies(),calls=0;
 while(p.stage!=='complete'){const result=f.step(p);p=result.cursor;assert.notEqual(p.stage,'deferred');assert.ok(result.units<=32);assert.ok(++calls<100);}
 assert.equal(p.hasRequests,true);assert.equal(p.requests,1);assert.equal(p.sequence,f.source.headSequence('legacy-room'));assert.ok(p.compared>0);
});
test('independent request phase rejects substituted request before full oracle',async t=>{
 const f=await setup(t);withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>{const request=scratch.get('actual','legacy-room','replyRequests','source-question');request.requesterId='worker';scratch.set('actual','legacy-room','replyRequests','source-question',request);}));
 let p=initialRecoveryReplies();assert.throws(()=>{for(let i=0;i<100&&p.stage!=='complete';i++)p=f.step(p).cursor;},/reconciliation/);
});
test('independent request audit verifies hidden checkpoint policy before continuing strict tail',async t=>{
 const f=await setup(t,{checkpoint:true});let p=initialRecoveryReplies(),calls=0;
 while(p.stage!=='complete'){const result=f.step(p);p=result.cursor;assert.notEqual(p.stage,'deferred');assert.ok(++calls<200);}
 assert.equal(p.checkpoint.compared,true);assert.equal(p.checkpoint.present,true);assert.equal(p.checkpoint.requests,1);assert.equal(p.sequence,f.source.headSequence('legacy-room'));
});

for(const mutation of ['request-context','presence','extra-request','message-body','message-link'])test('checkpoint independent request proof refuses '+mutation,async t=>{
 const change=state=>{if(mutation==='request-context')state.replyRequests['source-question'].contextEventId='substitution';if(mutation==='presence')delete state.replyRequests;if(mutation==='extra-request')state.replyRequests.extra={...state.replyRequests['source-question'],id:'extra'};if(mutation==='message-body')state.messages.at(-1).body='substitution';if(mutation==='message-link')state.messages.at(-1).replyToId='substitution';};
 const f=await setup(t,{checkpoint:true,checkpointMutation:change});let p=initialRecoveryReplies();assert.throws(()=>{for(let i=0;i<200&&p.stage!=='complete';i++){p=f.step(p).cursor;assert.notEqual(p.stage,'deferred');}},/reconciliation/);
});
test('redacted request post preserves original policy proof and exact tombstone',async t=>{
 const f=await setup(t,{withdraw:true});let p=initialRecoveryReplies();for(let i=0;p.stage!=='complete';i++){assert.ok(i<100);p=f.step(p).cursor;assert.notEqual(p.stage,'deferred');}assert.equal(p.requests,1);
});

for(const checkpoint of [false,true])test('archive retains exact reply context through original canonical history; checkpoint='+checkpoint,async t=>{
 const f=await setup(t,{archive:true,checkpoint});let p=initialRecoveryReplies();for(let i=0;p.stage!=='complete';i++){assert.ok(i<200);p=f.step(p).cursor;assert.notEqual(p.stage,'deferred');}assert.equal(p.requests,1);assert.ok(p.compared<p.messages);assert.ok(p.compared>0);
});

for(const scenario of ['response','transfer-cancel'])test('original historical request authority and context semantics; '+scenario,async t=>{
 const f=await setup(t,{scenario,checkpoint:true});let p=initialRecoveryReplies();for(let i=0;p.stage!=='complete';i++){assert.ok(i<200);p=f.step(p).cursor;assert.notEqual(p.stage,'deferred');}assert.equal(p.requests,1);assert.equal(p.checkpoint.compared,true);
});

test('reply unit save failure rolls back source cursor and every derived scratch row',async t=>{
 const f=await setup(t,{checkpoint:true}),p=initialRecoveryReplies(),before=f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all();
 assert.throws(()=>withRestoreTransaction(f.store,()=>{withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryReplies(f.store,scratch,f.state.restore_id,'legacy-room',p,f.state.seal));throw Error('reply checkpoint save interrupted');}),/reply checkpoint save interrupted/);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),before);assert.deepEqual(p,initialRecoveryReplies());assert.ok(f.step(p).units>0);
});
test('historical active-member proof is used before accepting a request',async t=>{
 const f=await setup(t);let p=initialRecoveryReplies();while(p.sequence<2)p=f.step(p,{maxUnits:1}).cursor;
 withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>{const member=scratch.get('history','legacy-room','rrMember','owner');assert.equal(member.active,true);member.active=false;scratch.set('history','legacy-room','rrMember','owner',member);}));
 assert.throws(()=>{for(let i=0;i<100&&p.stage!=='complete';i++)p=f.step(p).cursor;},/reconciliation/);
});
test('actual operator durably checks reply and help phases before full audit admission',async t=>{
 const f=await setup(t,{archive:true,checkpoint:true});let store=f.store,response,calls=0,sawReply=false,sawHelp=false;
 try{while(true){const state=restoreProgress(store.db);sawReply||=state.progress.audit.stage==='reply_requests';sawHelp||=state.progress.audit.stage==='work_help';
 const input={restoreId:state.restore_id,sourceSeal:state.seal.id,expectedRevision:state.revision,requestId:'replies-full-'+calls};store.close();store=new RoomStore(f.filename);response=await post(store,input);assert.ok([200,202].includes(response.status),JSON.stringify(response));assert.deepEqual(await post(store,input),response);assert.ok(++calls<300);if(response.status===200)break;assert.throws(()=>store.headSequence('legacy-room'),e=>e.status===503);
 }assert.equal(sawReply,true);assert.equal(sawHelp,true);assert.equal(response.body.verified,true);assert.equal(response.body.reportVersion,1);assert.deepEqual(response.body.subsystemContinuation.replyRequests,{rooms:1,deferred:0,requestsScanned:1,messagesCompared:3});assert.equal(response.body.subsystemContinuation.workHelp.deferred,0);assert.doesNotThrow(()=>auditRecovery(store));
 }finally{store.close();}
});
