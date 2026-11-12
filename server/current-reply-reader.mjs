import { requestRuntimeAccess } from './request-runtime-target.mjs';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {isCurrentRoom,readCurrentHead,readCurrentRecord,readCurrentMessage,readCurrentHistoryFloor,readCurrentReplyRequestWindow,readCurrentWorkItem,withCurrentReadContext,chargeCurrentReadBudget,remainingCurrentReadBytes} from './current-room-repository.mjs';
import {validId} from '../src/events.js';
import {messageInHistory} from './history-visibility.mjs';
import {charterContext} from '../src/room-charter.js';
import {currentWorkRecord} from './work-context.mjs';
import {stampReplyRead} from './content-trust.mjs';
import {ServiceError} from './service-error.mjs';

const keys=new WeakMap(),WINDOW=8,PAGE_BYTES=65536;
const fail=(code,message,status=409)=>{throw new ServiceError(status,code,message);};
const changed=()=>fail('reply_history_changed','Request context changed or lacks its protected source; reconcile before resuming');
const directionMatches=(r,id,d)=>d==='incoming'?r.recipientId===id:d==='outgoing'?r.requesterId===id:[r.requesterId,r.recipientId].includes(id);
const visible=(m,id,floor)=>m&&messageInHistory(m,floor)&&(!m.toMemberId||m.authorId===id||m.toMemberId===id);
const seenKey=id=>createHash('sha256').update(id).digest('base64url').slice(0,16);
function codec(store){
 if(!keys.has(store))keys.set(store,randomBytes(32));
 return {
  encode(value){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keys.get(store),nonce),body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64url');},
  decode(token){try{
   if(typeof token!=='string'||token.length>4096||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();
   const bytes=Buffer.from(token,'base64url');if(bytes.length<29||bytes.toString('base64url')!==token)throw Error();
   const decipher=createDecipheriv('aes-256-gcm',keys.get(store),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
   return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  }catch{fail('invalid_reply_cursor','Continuation expired, is malformed, or belongs to another store. A service restart can expire it. If restarting this read, reconcile earlier pages and checkpoints; do not answer from partial context. No request was changed.');}}
 };
}
const selectionKeys='v mode roomId viewerId accountId authEpoch credentialHash sessionBinding sessionRevision roomCreatedEventId direction status requestMessageId'.split(' ');
function decodeBound(crypto,token,binding){
 const saved=crypto.decode(token);
 if(!saved||!selectionKeys.every(key=>saved[key]===binding[key]))fail('reply_cursor_identity_changed','Continuation belongs to another viewer or selection');
 return saved;
}
export function readCurrentReplies(store,token,roomId,mode,args,shape){
 if(!isCurrentRoom(store.db,roomId))return undefined;
 return store.readTransaction(()=>withCurrentReadContext(store.db,roomId,b=>{
  const auth=store.authenticate(token,roomId,args.expectedSessionBinding??null),db=store.db,head=readCurrentHead(db,roomId,b);
  const floor=readCurrentHistoryFloor(db,roomId,auth.member.id,b),crypto=codec(store);
  // Addressed member reads (requester/recipient only), never the full member
  // census: the census exhausts the shared read budget in rooms of ~20+ members.
  const memberCache=new Map(),memberAt=id=>{if(!validId(id))return undefined;if(!memberCache.has(id)){const m=readCurrentRecord(db,roomId,'members',id,b);if(m!==undefined&&m?.id!==id)changed();memberCache.set(id,m);}return memberCache.get(id);};
  const limit=args.limit??20;if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail('invalid_reply_selection','Choose a page limit from1 to50',422);
  const requestMessageId=mode==='selected'?args.requestMessageId:null,direction=mode==='list'||mode==='history'?args.direction??'incoming':null,status=mode==='list'?args.status??'open':null;
  if(direction!==null&&!['incoming','outgoing','both'].includes(direction)||status!==null&&!['open','answered','declined','cancelled','all'].includes(status))fail('invalid_reply_selection','Choose a request direction and status',422);
  const eventCache=new Map(),messages=new Map(),requests=new Map();let evaluatedThrough=0;
  const eventAt=sequence=>{
   if(eventCache.has(sequence))return eventCache.get(sequence);
   const scalar=db.prepare('SELECT id,length(CAST(body AS BLOB)) AS bytes FROM events WHERE room_id=? AND sequence=?').get(roomId,sequence);
   if(!scalar||!validId(scalar.id)||scalar.bytes>131072)changed();chargeCurrentReadBudget(b,scalar.bytes+128);
   const row=db.prepare("SELECT sequence,id,json_extract(body,'$.id') AS eventId,json_extract(body,'$.roomId') AS roomId,json_type(body,'$.data') AS dataType,json_extract(body,'$.type') AS type,json_extract(body,'$.actorId') AS actorId,json_extract(body,'$.at') AS at,json_extract(body,'$.data.targetRuntimeKeyId') AS targetRuntimeKeyId,json_extract(body,'$.data.messageId') AS messageId,json_extract(body,'$.data.requestMessageId') AS requestMessageId,json_extract(body,'$.data.responseToRequestId') AS responseToRequestId,json_extract(body,'$.data.reason') AS reason FROM events WHERE room_id=? AND sequence=?").get(roomId,sequence);
   if(row.id!==row.eventId||row.roomId!==roomId||typeof row.type!=='string'||!row.type||!validId(row.actorId)||typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at))||row.dataType!=='object')changed();eventCache.set(sequence,row);return row;
  };
  const created=eventAt(1);if(created.type!=='room.created')changed();
  const binding={v:2,mode,roomId,viewerId:auth.member.id,accountId:auth.account?.id??null,authEpoch:auth.account?.authEpoch??null,credentialHash:auth.credentialHash,sessionBinding:auth.sessionBinding??null,sessionRevision:auth.sessionRevision??null,roomCreatedEventId:created.id,direction,status,requestMessageId};
  const base={contractVersion:2,roomId,viewerId:auth.member.id,viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,viewerSessionBinding:auth.sessionBinding,viewerSessionRevision:auth.sessionRevision??null,scope:{...shape.scope,coverage:'bounded-source-window'},evaluationScope:'visible-encountered-anchors'};
  const loadMessage=id=>{
   if(!validId(id)&&!(typeof id==='string'&&id.endsWith(':channel')))changed();
   if(!messages.has(id))messages.set(id,readCurrentMessage(db,roomId,id,b));return messages.get(id);
  };
  const loadRequest=id=>{
   if(!requests.has(id)){const request=readCurrentRecord(db,roomId,'replyRequests',id,b);
    if(request&&(request.id!==id||!validId(request.openingEventId)||!validId(request.requesterId)||!validId(request.recipientId)||request.requesterId===request.recipientId||!['open','answered','declined','cancelled'].includes(request.status)||!Number.isSafeInteger(request.revision)||request.revision<0))changed();requests.set(id,request);}
   return requests.get(id);
  };
  const noteRequest=request=>{
   for(const id of [request.openingEventId,request.contextEventId,request.terminalEventId].filter(Boolean)){
    const row=db.prepare('SELECT sequence FROM events WHERE room_id=? AND id=?').get(roomId,id);chargeCurrentReadBudget(b,128);if(!row)changed();evaluatedThrough=Math.max(evaluatedThrough,row.sequence);
   }
  };
  const ownerCache=new Map();
  const ownerOf=id=>{
   if(ownerCache.has(id))return ownerCache.get(id);
   const path=[];let cursor=id,previous=Number.MAX_SAFE_INTEGER,owner=null;
   for(let depth=0;cursor;depth++){
    if(depth>=32)fail('current_reply_context_unavailable','Reply ancestry exceeds the addressed context budget');
    if(ownerCache.has(cursor)){owner=ownerCache.get(cursor);break;}
    const message=loadMessage(cursor);if(!message)changed();if(message.row.seq>=previous)changed();previous=message.row.seq;
    const explicit=loadRequest(cursor);if(explicit){owner=explicit;ownerCache.set(cursor,owner);break;}
    path.push(message.value);cursor=message.value.replyToId;
   }
   for(const message of path.reverse()){if(owner&&message.workItemId&&message.workItemId!==owner.workItemId)owner=null;ownerCache.set(message.id,owner);}
   return owner;
  };
  if(mode==='list'){
   const saved=args.cursor==null?null:decodeBound(crypto,args.cursor,binding);
   if(saved&&typeof saved.after!=='string')fail('invalid_reply_cursor','Invalid request source continuation');
   // Open-ask fast path: the first open page (incoming, outgoing or both)
   // reads existing indexes, so an open ask is never behind empty pages.
   // It is discovery, not a census: every hit is proof-read and bound, and the
   // witnessed scan still runs to completion as before, skipping only the hits
   // already returned (kept as hashes inside the opaque cursor).
   const seen=new Set(saved?.seen??[]),found=[];
   if(saved?.seen!==undefined&&(!Array.isArray(saved.seen)||saved.seen.length>50||!saved.seen.every(v=>typeof v==='string')))fail('invalid_reply_cursor','Invalid request source continuation');
   if(!saved&&status==='open'){
    // Incoming hits come from the open-request index; outgoing hits from the
    // requester party index filtered to open (B9). Same binding checks either way.
    const sources=[];
    if(direction!=='outgoing')sources.push(["SELECT record_key FROM current_room_records INDEXED BY current_inbox_open_requests WHERE room_id=? AND domain='replyRequests' AND json_extract(payload,'$.status')='open' AND json_extract(payload,'$.recipientId')=? ORDER BY record_key LIMIT ?",'recipientId']);
    if(direction!=='incoming')sources.push(["SELECT record_key FROM current_room_records INDEXED BY current_request_party_requester WHERE room_id=? AND domain='replyRequests' AND json_extract(payload,'$.requesterId')=? AND json_extract(payload,'$.status')='open' ORDER BY record_key LIMIT ?",'requesterId']);
    for(const [sql,role] of sources){
     const rows=db.prepare(sql).all(roomId,auth.member.id,Math.min(limit,WINDOW));
     chargeCurrentReadBudget(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),rows.length);
     for(const {record_key:id} of rows){
      if(found.length>=limit)break;
      // Same headroom rule as the scan below; an unread hit is simply found by the scan.
      if(remainingCurrentReadBytes(b)<=144*1024+384*(found.length+WINDOW)||(b.maxRecords??200)-b.records<=100+3*(found.length+WINDOW))break;
      const r=readCurrentRecord(db,roomId,'replyRequests',id,b);
      if(r?.id!==id||r.status!=='open'||r[role]!==auth.member.id)throw Error('current_room_corrupt: open request index binding differs');
      if(!validId(r.requesterId)||!validId(r.recipientId)||r.requesterId===r.recipientId||r.revision!==0||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))changed();
      requests.set(r.id,r);seen.add(seenKey(id));
      if(messageInHistory({id:r.id,createdAt:r.createdAt},floor))found.push(r);
     }
    }
   }
   // Refill a few witnessed source windows while there is space. The ceiling
   // remains explicit; an empty page with hasMore still means keep reading.
   let source,after=saved?.after??'',windows=0;const selected=[...found];
   if(selected.length>=limit||found.length&&(remainingCurrentReadBytes(b)<=144*1024+384*(selected.length+WINDOW)||(b.maxRecords??200)-b.records<=100+3*(selected.length+WINDOW)))source={requests:[],examinedAfter:after,hasMore:true};
   else do{
    source=readCurrentReplyRequestWindow(store,roomId,{after,limit:Math.min(limit-selected.length,WINDOW)});
    for(const r of source.requests){if(!validId(r.id)||!validId(r.requesterId)||!validId(r.recipientId)||r.requesterId===r.recipientId||!['open','answered','declined','cancelled'].includes(r.status)||r.revision!==(r.status==='open'?0:1)||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))changed();requests.set(r.id,r);}
    selected.push(...source.requests.filter(r=>!seen.has(seenKey(r.id))&&directionMatches(r,auth.member.id,direction)&&messageInHistory({id:r.id,createdAt:r.createdAt},floor)&&(status==='all'||r.status===status)));
    after=source.examinedAfter;windows++;
   }while(source.hasMore&&selected.length<limit&&windows<4
    &&remainingCurrentReadBytes(b)>144*1024+384*(selected.length+WINDOW)
    &&(b.maxRecords??200)-b.records>100+3*(selected.length+WINDOW));
   for(const request of selected)noteRequest(request);
   const nextCursor=source.hasMore?crypto.encode({...binding,after:source.examinedAfter,...(seen.size?{seen:[...seen]}:{})}):null;
   const nextRead=nextCursor?{tool:'room_list_requests',arguments:{direction,status,limit,cursor:nextCursor}}:null;
   return {...base,evaluatedThrough,selection:{direction,status},requests:selected.map(shape.compactRequest),nextReads:selected.map(r=>({requestMessageId:r.id,http:{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}/reply-context?requestMessageId=${encodeURIComponent(r.id)}`},nextRead:{tool:'room_read_request',arguments:{requestMessageId:r.id}}})),sourceWindow:{complete:!source.hasMore,consistency:'current-per-page'},page:{cursor:args.cursor??null,limit,hasMore:source.hasMore,nextCursor,nextRead},nextRead};
  }
  if(mode==='history'){
   const saved=args.cursor!=null?decodeBound(crypto,args.cursor,binding):null;
   const checkpoint=args.checkpoint!=null?decodeBound(crypto,args.checkpoint,binding):null;
   if(saved?.kind!=='page'&&saved||checkpoint?.kind!=='checkpoint'&&checkpoint)fail('invalid_reply_cursor','Choose the matching history continuation');
   const horizon=saved?.horizon??head.sequence,anchor=saved?.anchor??eventAt(horizon).id,after=saved?.after??checkpoint?.through??0;
   if(!Number.isSafeInteger(horizon)||horizon>head.sequence||!Number.isSafeInteger(after)||after<0||after>horizon||eventAt(horizon).id!==anchor)changed();
   if(checkpoint&&(checkpoint.through>head.sequence||eventAt(checkpoint.through).id!==checkpoint.anchor))changed();
   const source=db.prepare('SELECT sequence FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(roomId,after,horizon,Math.min(limit,WINDOW));
   chargeCurrentReadBudget(b,source.length*32,source.length);const items=[];let rowBytes=0,last=after;
   for(const point of source){
    const e=eventAt(point.sequence);let owner,message,kind;
    if(e.type==='message.posted'){
     message=loadMessage(e.messageId);if(!message||message.row.seq!==point.sequence)changed();owner=ownerOf(e.messageId);
     if(owner)kind=e.id===owner.openingEventId?'opened':e.id===owner.terminalEventId?owner.status:'context';
    }else if(e.type==='reply_request.cancelled'){owner=loadRequest(e.requestMessageId);kind='cancelled';}
    let item=null;
    if(owner&&directionMatches(owner,auth.member.id,direction)&&messageInHistory({id:owner.id,createdAt:owner.createdAt},floor)){
     if(kind==='cancelled'){
      if(owner.status!=='cancelled'||e.id!==owner.terminalEventId||e.actorId!==owner.terminalActorId||e.reason!==owner.reason||e.at!==owner.closedAt)changed();
      item={sequence:point.sequence,eventId:e.id,requestMessageId:owner.id,kind,requesterId:owner.requesterId,recipientId:owner.recipientId,workItemId:owner.workItemId,actorId:e.actorId,at:e.at,reason:owner.reason};
     }else if(visible(message.value,auth.member.id,floor)){
      if(e.actorId!==message.value.authorId||e.at!==message.value.createdAt)changed();
      item={sequence:point.sequence,eventId:e.id,requestMessageId:owner.id,kind,requesterId:owner.requesterId,recipientId:owner.recipientId,workItemId:owner.workItemId,actorId:e.actorId,at:e.at,message:shape.readMessage({...message.value,body:message.value.deletedAt?null:message.value.body})};
     }
    }
    if(item){const bytes=Buffer.byteLength(JSON.stringify(item));if(rowBytes+bytes>PAGE_BYTES){if(!items.length)fail('reply_entry_too_large','One request entry exceeds the page budget',413);break;}items.push(item);rowBytes+=bytes;evaluatedThrough=Math.max(evaluatedThrough,point.sequence);}
    last=point.sequence;
   }
   if(last===after&&after<horizon&&!source.length)changed();
   const hasMore=last<horizon,nextCursor=hasMore?crypto.encode({...binding,kind:'page',horizon,anchor,after:last}):null;
   const completedCheckpoint=hasMore?null:crypto.encode({...binding,kind:'checkpoint',through:horizon,anchor});
   const nextRead=nextCursor?{tool:'room_request_history',arguments:{direction,limit,cursor:nextCursor}}:null;
   return stampReplyRead({...base,evaluatedThrough,selection:{direction,requestMessageId:null},roomCreatedEventId:created.id,sourceWindow:{complete:!hasMore,consistency:'frozen-history-current-bodies'},page:{cursor:args.cursor??null,checkpoint:args.checkpoint??null,items,rowBytes,limit,hasMore,nextCursor,completedCheckpoint,nextRead},nextRead},auth.member.id);
  }

  const request=loadRequest(requestMessageId);
  if(!request||!directionMatches(request,auth.member.id,'both')||!messageInHistory({id:request.id,createdAt:request.createdAt},floor))fail('reply_request_not_found','Request not found in this Room',404);
  const opening=loadMessage(request.id),context=loadMessage(request.contextMessageId);
  if(!opening||!context)changed();
  const openingEvent=eventAt(opening.row.seq),contextEvent=eventAt(context.row.seq);
  if((openingEvent.targetRuntimeKeyId??null)!==(request.targetRuntimeKeyId??null)||openingEvent.type!=='message.posted'||openingEvent.id!==request.openingEventId||openingEvent.messageId!==request.id||opening.value.authorId!==request.requesterId||opening.value.toMemberId!==request.recipientId||openingEvent.actorId!==opening.value.authorId||openingEvent.at!==opening.value.createdAt||opening.value.createdAt!==request.createdAt||contextEvent.type!=='message.posted'||contextEvent.id!==request.contextEventId||contextEvent.messageId!==request.contextMessageId||contextEvent.actorId!==context.value.authorId||contextEvent.at!==context.value.createdAt)changed();
  if(!visible(context.value,auth.member.id,floor))fail('reply_context_unavailable','Latest request context is outside the visible conversation; ask for a new request');
  evaluatedThrough=Math.max(opening.row.seq,context.row.seq);
  if(ownerOf(context.value.id)?.id!==request.id)changed();
  // Follow-up preparation keeps the established eight-exchange/100-message
  // contract. Both source admission and addressed proof reads stay bounded;
  // unavailable/withdrawn required context is a refusal, never an empty array.
  const previousExchanges=[],seen=new Set([request.id]);let previous=request,priorCount=0;
  while(true){
   const currentOpening=loadMessage(previous.id),parent=currentOpening?.value.replyToId&&loadMessage(currentOpening.value.replyToId);
   const prior=parent?.value.replyToId&&loadRequest(parent.value.replyToId);
   if(!prior||prior.status!=='answered'||prior.responseMessageId!==parent.value.id||prior.requesterId!==request.requesterId||prior.recipientId!==request.recipientId||prior.workItemId!==request.workItemId)break;
   if(seen.has(prior.id))changed();seen.add(prior.id);
   if(previousExchanges.length===8)fail('reply_follow_up_too_large','Earlier exchange exceeds bounded preparation; start a new request with the relevant context',413);
   if(!messageInHistory({id:prior.id,createdAt:prior.createdAt},floor))fail('reply_follow_up_unavailable','Earlier exchange is outside visible history');
   const priorOpening=loadMessage(prior.id);if(!priorOpening||eventAt(parent.row.seq).id!==prior.terminalEventId||ownerOf(parent.value.id)?.id!==prior.id)changed();
   const rows=db.prepare('SELECT message_id,seq FROM messages INDEXED BY messages_room_thread_seq WHERE room_id=? AND thread_root_id=? AND seq>=? AND seq<=? ORDER BY seq,message_id LIMIT 101').all(roomId,priorOpening.row.thread_root_id??prior.id,priorOpening.row.seq,parent.row.seq);
   if(priorOpening.row.thread_root_id===null)rows.unshift({message_id:prior.id,seq:priorOpening.row.seq});
   if(rows.length>100)fail('reply_follow_up_too_large','Earlier exchange exceeds bounded preparation; start a new request with the relevant context',413);
   chargeCurrentReadBudget(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.message_id)+32,0),rows.length);
   const priorMessages=[];
   for(const row of rows){
    const message=loadMessage(row.message_id);if(!message||message.row.seq!==row.seq)changed();
    if(ownerOf(row.message_id)?.id!==prior.id||message.value.toMemberId&&![prior.requesterId,prior.recipientId].every(id=>id===message.value.authorId||id===message.value.toMemberId))continue;
    if(!messageInHistory(message.value,floor)||message.value.deletedAt||message.value.body===null)fail('reply_follow_up_unavailable','Earlier exchange contains unavailable or withdrawn context');
    priorMessages.push(shape.readMessage(message.value));
   }
   if(!priorMessages.some(m=>m.id===prior.id)||!priorMessages.some(m=>m.id===prior.responseMessageId))changed();
   previousExchanges.unshift({requestMessageId:prior.id,responseMessageId:prior.responseMessageId,messages:priorMessages});priorCount+=priorMessages.length;
   if(priorCount>100||Buffer.byteLength(JSON.stringify(previousExchanges))>PAGE_BYTES)fail('reply_follow_up_too_large','Earlier exchange exceeds bounded preparation',413);
   previous=prior;
  }
  const saved=args.cursor==null?null:decodeBound(crypto,args.cursor,binding);
  if(saved&&saved.requestRevision!==request.revision)fail('reply_history_changed','Request revision changed; reconcile before resuming');
  const horizon=saved?.horizon??head.sequence,anchor=saved?.anchor??eventAt(horizon).id;
  if(!Number.isSafeInteger(horizon)||horizon>head.sequence||eventAt(horizon).id!==anchor)changed();
  const after=saved?.after??{sequence:opening.row.seq-1,id:'\uffff'};
  if(!Number.isSafeInteger(after.sequence)||typeof after.id!=='string')fail('invalid_reply_cursor','Invalid request source continuation');
  const count=Math.min(limit,WINDOW),indexed=db.prepare('SELECT message_id,seq FROM messages INDEXED BY messages_room_thread_seq WHERE room_id=? AND thread_root_id=? AND (seq,message_id)>(?,?) AND seq<=? ORDER BY seq,message_id LIMIT ?').all(roomId,opening.row.thread_root_id??opening.value.id,after.sequence,after.id,horizon,count+1);
  // Root posts have NULL thread_root_id; descendants name that root. Merge
  // the one addressed root with its bounded indexed descendant stream.
  const root=opening.row.thread_root_id===null&&(opening.row.seq>after.sequence||opening.row.seq===after.sequence&&opening.value.id>after.id)&&opening.row.seq<=horizon?[{message_id:opening.value.id,seq:opening.row.seq}]:[];
  const cancelled=request.status==='cancelled'?db.prepare('SELECT id,sequence FROM events WHERE room_id=? AND id=?').get(roomId,request.terminalEventId):null;
  if(request.status==='cancelled'&&!cancelled)changed();
  const cancelledSource=cancelled&&cancelled.sequence<=horizon&&(cancelled.sequence>after.sequence||cancelled.sequence===after.sequence&&cancelled.id>after.id)?[{message_id:cancelled.id,seq:cancelled.sequence,cancelled:true}]:[];
  const source=[...root,...indexed,...cancelledSource].sort((a,c)=>a.seq-c.seq||Buffer.compare(Buffer.from(a.message_id),Buffer.from(c.message_id))).slice(0,count+1);
  chargeCurrentReadBudget(b,source.reduce((n,row)=>n+Buffer.byteLength(row.message_id)+32,0),source.length);
  const items=[];let rowBytes=0,last=after,examined=0;
  for(const row of source.slice(0,count)){
   if(row.cancelled){
    const event=eventAt(row.seq);if(event.type!=='reply_request.cancelled'||event.requestMessageId!==request.id||event.actorId!==request.terminalActorId||event.reason!==request.reason||event.at!==request.closedAt)changed();
    const item={sequence:row.seq,eventId:event.id,requestMessageId:request.id,kind:'cancelled',requesterId:request.requesterId,recipientId:request.recipientId,workItemId:request.workItemId,actorId:event.actorId,at:event.at,reason:request.reason},bytes=Buffer.byteLength(JSON.stringify(item));
    if(rowBytes+bytes>PAGE_BYTES)break;items.push(item);rowBytes+=bytes;evaluatedThrough=Math.max(evaluatedThrough,row.seq);last={sequence:row.seq,id:row.message_id};examined++;continue;
   }
   const message=loadMessage(row.message_id);if(!message||message.row.seq!==row.seq)changed();
   const owner=ownerOf(row.message_id);let item=null;
   if(owner?.id===request.id&&visible(message.value,auth.member.id,floor)){
    const event=eventAt(row.seq);if(event.type!=='message.posted'||event.messageId!==row.message_id||event.actorId!==message.value.authorId||event.at!==message.value.createdAt)changed();
    const kind=event.id===request.openingEventId?'opened':event.id===request.terminalEventId?request.status:'context';
    item={sequence:row.seq,eventId:event.id,requestMessageId:request.id,kind,requesterId:request.requesterId,recipientId:request.recipientId,workItemId:request.workItemId,actorId:event.actorId,at:event.at,message:shape.readMessage({...message.value,body:message.value.deletedAt?null:message.value.body})};
    const bytes=Buffer.byteLength(JSON.stringify(item));if(rowBytes+bytes>PAGE_BYTES){if(!items.length)fail('reply_entry_too_large','One request entry exceeds the page budget',413);break;}rowBytes+=bytes;items.push(item);evaluatedThrough=Math.max(evaluatedThrough,row.seq);
   }
   last={sequence:row.seq,id:row.message_id};examined++;
  }
  const hasMore=source.length>examined;
  const nextCursor=hasMore?crypto.encode({...binding,requestRevision:request.revision,horizon,anchor,after:last}):null;
  const nextRead=nextCursor?{tool:'room_read_request',arguments:{requestMessageId,limit,cursor:nextCursor}}:null;
  if(request.terminalEventId){
   if(request.status==='cancelled'){
    const point=db.prepare('SELECT sequence FROM events WHERE room_id=? AND id=?').get(roomId,request.terminalEventId);if(!point)changed();
    const terminal=eventAt(point.sequence);if(terminal.type!=='reply_request.cancelled'||terminal.requestMessageId!==request.id||terminal.actorId!==request.terminalActorId||terminal.reason!==request.reason||terminal.at!==request.closedAt)changed();
    evaluatedThrough=Math.max(evaluatedThrough,point.sequence);
   }else{
    const terminal=loadMessage(request.responseMessageId);if(!terminal)changed();const terminalEvent=eventAt(terminal.row.seq);
    if(terminalEvent.id!==request.terminalEventId||terminalEvent.type!=='message.posted'||terminalEvent.responseToRequestId!==request.id||terminalEvent.actorId!==request.recipientId||terminal.value.authorId!==request.recipientId||terminal.value.toMemberId!==request.requesterId||terminal.value.replyToId!==request.id||terminal.value.workItemId!==request.workItemId||request.responseContextSequence!==context.row.seq)changed();
    evaluatedThrough=Math.max(evaluatedThrough,terminal.row.seq);
   }
  }
  const requester=memberAt(request.requesterId),recipient=memberAt(request.recipientId),room=readCurrentRecord(db,roomId,'metadata','room',b);
  const denied=store.dmConsents.deniedDirection(roomId,auth.member.id,auth.member.id===request.requesterId?request.recipientId:request.requesterId);
  const canReply=!denied&&requester?.active===true&&recipient?.active===true;
  const runtimeAccess = requestRuntimeAccess(store, roomId, request, auth);
  const answerBasis = (!runtimeAccess || runtimeAccess.authorized) && request.status === 'open' && auth.member.id === request.recipientId && canReply && !hasMore && context.row.seq <= horizon ? {expectedRequestRevision: request.revision, contextEventId: contextEvent.id, contextSequence: context.row.seq} : null;
  const instructions=charterContext(room),work=request.workItemId?readCurrentWorkItem(db,roomId,request.workItemId):null;
  return stampReplyRead({...base,evaluatedThrough,selection:{direction:null,requestMessageId},request:structuredClone(request),roomCreatedEventId:created.id,sourceWindow:{complete:!hasMore,consistency:'frozen-conversation-current-preparation'},page:{cursor:args.cursor??null,checkpoint:null,items,rowBytes,limit,hasMore,nextCursor,completedCheckpoint:null,nextRead},nextRead,
   ...shape.responseTemplates(roomId,auth.member.id,request,answerBasis),
   current:{...(runtimeAccess ? {runtimeAccess} : {}),evaluatedThrough,requesterAvailable:requester?.active===true,recipientAvailable:recipient?.active===true,contextEventId:contextEvent.id,contextSequence:context.row.seq,answerBasis,actions:{reply:canReply,answer:Boolean(answerBasis),decline:Boolean(answerBasis),cancel:request.status==='open'&&(auth.member.id===request.requesterId||auth.member.kind==='human'&&auth.member.id===room.ownerId)},blockedBy:denied?[denied]:[],workItemId:request.workItemId,instructionsRevision:room.charter?.revision??0},
   preparation:{version:1,evaluatedThrough,room:{id:room.id,title:room.title,purpose:instructions.charter?.purpose??room.purpose??''},instructions,previousExchanges,work:work?currentWorkRecord(work):null,omitted:['other_work','other_messages','private_inbox','external_resources'],externalExecution:false}},auth.member.id);
 },{maxRecords:512}));
}
