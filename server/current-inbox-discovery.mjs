import {INBOX_WORK_ROLES}from'./current-inbox-indexes.mjs';
import {readCurrentRecord,readCurrentWorkSummaryForViewer,chargeCurrentReadBudget}from'./current-room-repository.mjs';
import{nextWorkStep}from'../src/workflow.js';import{messageInHistory}from'./history-visibility.mjs';
// One addressed source candidate per existing role index. Residual workflow and
// privacy remain shared semantics. This is useful discovery, never a census.
export function readCurrentInboxDiscovery(store,roomId,member,ownerId,floor,b){
 const db=store.db,candidates=new Set();let examinedWork=0;
 for(const[role,path]of INBOX_WORK_ROLES){
  const rows=db.prepare(`SELECT record_key FROM current_room_records INDEXED BY current_inbox_work_${role} WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'${path}')=? ORDER BY record_key DESC LIMIT 1`).all(roomId,member.id);chargeCurrentReadBudget(b,rows.reduce((n,r)=>n+Buffer.byteLength(r.record_key)+32,0),rows.length);for(const row of rows)candidates.add(row.record_key);
 }
 if(member.id===ownerId){const rows=db.prepare("SELECT record_key FROM current_room_records INDEXED BY current_inbox_work_triage WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'$.work.handoff.triageMemberId') IS NULL ORDER BY record_key DESC LIMIT 1").all(roomId);chargeCurrentReadBudget(b,rows.reduce((n,r)=>n+Buffer.byteLength(r.record_key)+32,0),rows.length);for(const row of rows)candidates.add(row.record_key);}
 const work=[];for(const id of candidates){const item=readCurrentWorkSummaryForViewer(db,roomId,id,member.id,b),next=nextWorkStep(item,store.now(),ownerId);examinedWork++;if(member.active!==false&&next.memberId===member.id&&next.needsAttention){work.push({id:item.id,title:item.title,state:item.state,revision:item.revision,next,nextRead:{tool:'room_read_work',arguments:{workItemId:id}},...(item.receipt?.eventId?{nextResultRead:{tool:'room_read_result',arguments:{workItemId:id,completionEventId:item.receipt.eventId}}}:{})});break;}}
 const rows=db.prepare("SELECT record_key FROM current_room_records INDEXED BY current_inbox_open_requests WHERE room_id=? AND domain='replyRequests' AND json_extract(payload,'$.status')='open' AND json_extract(payload,'$.recipientId')=? ORDER BY record_key DESC LIMIT 1").all(roomId,member.id);chargeCurrentReadBudget(b,rows.reduce((n,r)=>n+Buffer.byteLength(r.record_key)+32,0),rows.length);
 const requests=[];for(const row of rows){const request=readCurrentRecord(db,roomId,'replyRequests',row.record_key,b);if(request?.id!==row.record_key||request.status!=='open'||request.recipientId!==member.id)throw Error('current_room_corrupt: inbox request index binding differs');if(messageInHistory({id:request.id,createdAt:request.createdAt},floor))requests.push({id:request.id,requesterId:request.requesterId,workItemId:request.workItemId,revision:request.revision,nextRead:{tool:'room_read_request',arguments:{requestMessageId:request.id}}});}
 return{work,requests,examinedWork,examinedRequests:rows.length,unexamined:true};
}
