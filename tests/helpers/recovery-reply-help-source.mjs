import assert from 'node:assert/strict';
import {seedRecoveryWorkHelpSource} from './recovery-work-help-source.mjs';
import {planCanonicalReplayCapture} from '../../server/replay-canonical-plan.mjs';
import {readCurrentRoomForAudit,withCurrentAuditUnits} from '../../server/current-room-repository.mjs';
import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
import {auditRecovery} from '../../server/recovery.mjs';
import {exactReplyAuditMessage} from '../../server/recovery-reply-rules.mjs';
export function seedRecoveryReplyHelpSource(store){
 const f=seedRecoveryWorkHelpSource(store,{checkpoint:false,beforeCapture(s,{key,workerKey,send}){
  send(key,'message.posted',{messageId:'combined-question',body:'Review the coordinated contribution',toMemberId:'worker',workItemId:'help-task',requestKind:'reply'});
  const context=send(key,'message.posted',{messageId:'combined-context',body:'Keep the saved contribution as evidence',replyToId:'combined-question',toMemberId:'worker',workItemId:'help-task'});
  send(workerKey,'message.posted',{messageId:'combined-answer',body:'Reviewed the saved contribution',toMemberId:'owner',replyToId:'combined-question',workItemId:'help-task',responseToRequestId:'combined-question',expectedRequestRevision:0,responseOutcome:'answered',contextEventId:context.event.id,contextSequence:context.sequence});
  while(!s.backfillMessages({limit:200}).done){}assert.equal(s.checkMessagesParity({roomId:'legacy-room'}).ok,true);assert.equal(s.archiveMessages('legacy-room',{keepNewest:3,dryRun:false}).ok,true);assert.equal(s.checkMessagesParity({roomId:'legacy-room'}).ok,true);s.migrateMessageAuthority('legacy-room');
 },captureOptions:s=>{const plan=planCanonicalReplayCapture(s,{roomId:'legacy-room',expectedHead:s.headSequence('legacy-room')});assert.equal(plan.certified,false);return{contentBasis:plan.contentBasis,contentPlanHash:plan.planHash};}});
 // A full synthetic checkpoint, with canonical archived messages retained as the
 // existing checkpoint contract requires. No historical proof is overwritten.
 const saved=store.readTransaction(()=>readCurrentRoomForAudit(store,'legacy-room')).state;
 saved.messages=store.readTransaction(()=>withCurrentAuditUnits(store,'legacy-room',reader=>store.db.prepare('SELECT message_id FROM messages WHERE room_id=? ORDER BY seq,message_id').all('legacy-room').map(row=>reader.message(row.message_id).value)));
 store.transaction(()=>store.db.prepare('INSERT INTO projection_checkpoints VALUES(?,?,?)').run('legacy-room',store.headSequence('legacy-room'),JSON.stringify(saved)));
 store.command(f.key,'legacy-room',{id:'combined-current-tail',type:'message.posted',data:{messageId:'combined-tail',body:'Result remains saved after the checkpoint',replyToId:'combined-answer',toMemberId:'worker',workItemId:'help-task'}});
 store.initialize([...initialRoom('second-room','second-owner'),event({id:'second-room-message',roomId:'second-room',actorId:'second-owner',type:'message.posted',data:{messageId:'second-room-message',body:'Separate room and independent owner'}})],{representation:'normalized-current-v1'});
 auditRecovery(store);
 const state=store.readTransaction(()=>readCurrentRoomForAudit(store,'legacy-room')).state;
 return{rooms:2,requests:state.replyRequests,messages:state.messages.map(exactReplyAuditMessage),offers:state.helpOffers,ownerId:state.room.ownerId,historyProvenance:'unknown',certified:false};
}
