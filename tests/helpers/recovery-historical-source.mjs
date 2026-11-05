import assert from 'node:assert/strict';
import {seedLegacyFixture} from './legacy-session-fixture.mjs';
import {repairLegacyMessages} from '../../server/operator-legacy-message-repair.mjs';
import {textVersion} from '../../server/text-results.mjs';
import {auditRecovery} from '../../server/recovery.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../../server/replay-cutover.mjs';
// Synthetic predecessor-writer evidence through the existing executable repair
// producer. No fabricated operator receipt, source rewrite or new permission.
export function seedRecoveryHistoricalSource(store){
 const f=seedLegacyFixture(store),plan=repairLegacyMessages(store,f.request),receipt=repairLegacyMessages(store,{...f.request,planHash:plan.planHash,requestId:'historical-restore-proof'},true),key=store.issueAccessKey('legacy-room','owner'),body='A useful preserved historical result';
 const post=store.command(key,'legacy-room',{id:'historical-result',type:'message.posted',data:{messageId:'historical-result',workItemId:'task',body}}),revision=store.room('legacy-room').state.workItems.task.revision;
 const completed=store.command(key,'legacy-room',{id:'historical-complete',type:'work.completed',data:{workItemId:'task',expectedRevision:revision,evidenceKind:'room_text',evidenceMessageId:'historical-result',evidenceMessageEventId:post.event.id,previousCompletionEventId:null,summary:'Saved legacy result',evidenceVersion:textVersion(body),producerId:'owner',nextAction:'Review'}});
 store.transaction(()=>store.db.prepare('DELETE FROM projection_checkpoints WHERE room_id=?').run('legacy-room'));auditRecovery(store);store.db.exec(replayCutoverSchema({durable:!!store.db.storage}));
 const capture=captureReplayWitness(store,{roomId:'legacy-room',requestId:'capture',expectedHead:store.headSequence('legacy-room'),reason:'Historical recovery qualification'}),base={roomId:'legacy-room',generation:capture.generation};
 let progress={bytes:0},step=0;while(progress.phase!=='witness_verified'){assert.ok(step<500);progress=advanceReplayWitness(store,{...base,requestId:'hash-'+step++,expectedBytes:progress.bytes});}
 progress={bytes:0};step=0;while(progress.phase!=='codec_partitioned'){assert.ok(step<500);progress=partitionReplayWitness(store,{...base,requestId:'codec-'+step++,expectedBytes:progress.bytes});}
 let work={workCount:0};step=0;do{assert.ok(step<500);work=qualifyReplayHWork(store,{...base,requestId:'work-'+step++,expectedWorkCount:work.workCount});}while(!work.workDefaultsQualified);
 let messages={hMessageSteps:0};step=0;do{assert.ok(step<500);messages=qualifyReplayHMessages(store,{...base,requestId:'messages-'+step++,expectedSteps:messages.hMessageSteps});}while(!messages.hMessagesQualified);
 let current={currentSteps:0};step=0;do{assert.ok(step<500);current=advanceCurrentRoomConversion(store,{...base,requestId:'convert-'+step++,expectedSteps:current.currentSteps});}while(current.phase!=='current_serving');
 const recovery=auditRecovery(store);assert.equal(recovery.checks.projectionReplay,true);assert.equal(store.headSequence('legacy-room'),12);return{key,post,completed,receipt,body,head:12,prefix:receipt.replayContract.throughSequence};
}
