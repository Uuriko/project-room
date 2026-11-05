import assert from 'node:assert/strict';
import {event} from '../../src/events.js';
import {seedLegacyFixture,historicalSequence} from './legacy-session-fixture.mjs';
import {repairLegacyMessages} from '../../server/operator-legacy-message-repair.mjs';
import {textVersion} from '../../server/text-results.mjs';
import {auditRecovery} from '../../server/recovery.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../../server/replay-cutover.mjs';
export function seedHistoricalRedactionSource(store,{extraPrefixMessages=0,beforeCapture,captureOptions}={}){
 const es=historicalSequence(),intro=[
  event({roomId:'legacy-room',actorId:'owner',type:'member.added',data:{memberId:'worker',displayName:'Worker',kind:'agent',permissions:[]}}),
  ...['prefix-one','prefix-two','prefix-private',...Array.from({length:extraPrefixMessages},(_,i)=>'prefix-extra-'+i)].map(id=>event({roomId:'legacy-room',actorId:'owner',type:'message.posted',data:{messageId:id,body:'sensitive-'+id+'-original',...(id==='prefix-private'?{toMemberId:'worker'}:{})}})),
  event({roomId:'legacy-room',actorId:'owner',type:'message.edited',data:{messageId:'prefix-one',body:'sensitive-prefix-one-edited',expectedMessageRevision:0}})
 ];
 const f=seedLegacyFixture(store,[...es.slice(0,2),...intro,...es.slice(2)]),plan=repairLegacyMessages(store,f.request),repair=repairLegacyMessages(store,{...f.request,planHash:plan.planHash,requestId:'derived-privacy-source'},true);
 const key=store.issueAccessKey('legacy-room','owner'),workerKey=store.issueAccessKey('legacy-room','worker'),before=store.room('legacy-room').state.workItems.task;
 const body='Saved modern result after historical repair',posted=store.command(key,'legacy-room',{id:'saved-modern-result',type:'message.posted',data:{messageId:'saved-modern-result',body,workItemId:'task'}});
 store.command(key,'legacy-room',{id:'saved-modern-complete',type:'work.completed',data:{workItemId:'task',expectedRevision:before.revision,evidenceKind:'room_text',evidenceMessageId:'saved-modern-result',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,summary:'Saved complete result',producerId:'owner',nextAction:'Review'}});
 beforeCapture?.(store,{key,workerKey});
 store.transaction(()=>store.db.prepare('DELETE FROM projection_checkpoints WHERE room_id=?').run('legacy-room'));auditRecovery(store);
 store.db.exec(replayCutoverSchema({durable:!!store.db.storage}));
 const captured=captureReplayWitness(store,{roomId:'legacy-room',requestId:'privacy-H',expectedHead:store.headSequence('legacy-room'),reason:'Historical privacy qualification',...(captureOptions?.(store)??{})}),base={roomId:'legacy-room',generation:captured.generation};
 const run=(advance,start,complete,field)=>{let value=start,i=0;do{assert.ok(i<500);value=advance(store,{...base,requestId:field+'-'+i++,...field==='hash'||field==='codec'?{expectedBytes:value.bytes}:field==='work'?{expectedWorkCount:value.workCount}:field==='messages'?{expectedSteps:value.hMessageSteps}:{expectedSteps:value.currentSteps}});}while(!complete(value));return value;};
 run(advanceReplayWitness,{bytes:0},v=>v.phase==='witness_verified','hash');
 run(partitionReplayWitness,{bytes:0},v=>v.phase==='codec_partitioned','codec');
 run(qualifyReplayHWork,{workCount:0},v=>v.workDefaultsQualified,'work');
 run(qualifyReplayHMessages,{hMessageSteps:0},v=>v.hMessagesQualified,'messages');
 run(advanceCurrentRoomConversion,{currentSteps:0},v=>v.phase==='current_serving','current');
 auditRecovery(store);
 const original=store.db.prepare("SELECT id,counts_json FROM operator_actions WHERE action IN ('legacy_session_backfill_reconciled','legacy_session_replay_lookup') ORDER BY id").all();
 const erase=(id,commandId='erase-'+id)=>store.command(key,'legacy-room',{id:commandId,type:'message.deleted',data:{messageId:id,expectedMessageRevision:id==='prefix-one'?1:0,reason:'Authorized removal'}});
 return{key,workerKey,repair,original,erase,body,head:store.headSequence('legacy-room')};
}
