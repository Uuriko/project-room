// Normalized needs-me composes the existing bounded inbox and standing-work
// readers. Private source positions live only inside the server-owned codec.
import {createHash} from 'node:crypto';
import {readCurrentNativeInbox} from './current-native-inbox.mjs';
import {conversationCursorCodec} from './conversation-sync.mjs';
import {withCurrentReadContext,readCurrentHead,readCurrentRecord,currentVisibleHorizon,chargeCurrentReadBudget} from './current-room-repository.mjs';
import {ServiceError} from './service-error.mjs';
const fail=()=>{throw new ServiceError(409,'stale_needs_me_cursor','Attention source or service changed. Restart needs-me without since.');};
const clip=value=>String(value??'').replace(/\s+/g,' ').slice(0,140);
const keys='kind roomId memberId credential head mode minimum after older workCursor conversationDone workDone'.split(' ');
const MAX_NEEDS_ME_WORK_PAGES=8;
export function readCurrentNeedsMePage(store,secret,roomId,options={}){
 return store.readTransaction(()=>readPage(store,secret,roomId,options));
}
function readPage(store,secret,roomId,{cursor,after,freshWindow=500,expectedMode,expectedSessionBinding=null}={}){
 const binding=store.readTransaction(()=>withCurrentReadContext(store.db,roomId,()=>{
  const auth=store.authenticate(secret,roomId,expectedSessionBinding),head=readCurrentHead(store.db,roomId);
  return{kind:'needs_me_native_v1',roomId,memberId:auth.member.id,credential:createHash('sha256').update(secret).digest('hex'),head:head.head_sha256,sequence:head.sequence};
 }));
 let state;
 if(cursor!==undefined){
  if(typeof cursor!=='string'||!cursor||Buffer.byteLength(cursor)>12288)fail();
  state=conversationCursorCodec(store).decode(cursor);
  if(!state||Object.keys(state).join(' ')!==keys.join(' ')||['kind','roomId','memberId','credential','head'].some(key=>state[key]!==binding[key])
   ||!['recent','catch_up'].includes(state.mode)||!Number.isSafeInteger(state.minimum)||state.minimum<0||!Number.isSafeInteger(state.after)||state.after<0
   ||typeof state.conversationDone!=='boolean'||typeof state.workDone!=='boolean'
   ||state.older!==null&&typeof state.older!=='string'||state.workCursor!==null&&typeof state.workCursor!=='string')fail();
 }else{
  if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))fail();
  const recent=after===undefined;
  state={kind:binding.kind,roomId,memberId:binding.memberId,credential:binding.credential,head:binding.head,mode:recent?'recent':'catch_up',minimum:recent?Math.max(0,binding.sequence-freshWindow):Math.min(after,binding.sequence),after:Math.min(after??0,binding.sequence),older:null,workCursor:null,conversationDone:false,workDone:false};
 }
 if(expectedMode!==undefined&&state.mode!==expectedMode||cursor!==undefined&&state.mode==='catch_up'&&after!==undefined&&state.minimum!==Math.min(after,binding.sequence))fail();
 const items=[];let examined=0,conversationComplete=state.conversationDone,workComplete=state.workDone,visibleThrough=0;
 if(!state.conversationDone){
  const inbox=readCurrentNativeInbox(store,secret,roomId,state.mode==='recent'?{limit:4,expectedSessionBinding,...(state.older?{olderCursor:state.older}:{})}:{limit:4,after:state.after,expectedSessionBinding});
  for(const [kind,rows]of [['mention',inbox.directMentions],['dm',inbox.directMessages],['reply',inbox.replies]])for(const row of rows){
   if(row.requestKind==='reply'||row.sequence<=state.minimum||kind==='reply'&&[...inbox.directMentions,...inbox.directMessages].some(other=>other.messageId===row.messageId))continue;
   items.push({kind,roomId,seq:row.sequence,id:row.messageId,...(kind==='dm'?{channel:'room'}:{}),...(kind==='reply'?{replyToId:row.inReplyTo}:{}),summary:clip(row.body),next:{tool:'room_reply',arguments:{roomId,requestId:`needs-me-${roomId}-${row.messageId}`,replyToId:row.messageId,...(row.replyToMemberId?{toMemberId:row.replyToMemberId}:{})}}});
  }
  examined=inbox.coverage.conversation.examined;
  if(state.mode==='recent'){
   state.older=inbox.older.nextRead?.arguments.olderCursor??null;
   // The source continuation is encrypted. Decode only this server-produced
   // token to stop at the originally requested recent range, never expose it.
   const source=state.older?conversationCursorCodec(store).decode(state.older):null;
   state.conversationDone=!inbox.older.hasMore||source?.before<=state.minimum;
  }else{state.after=inbox.cursor.after;state.conversationDone=!inbox.cursor.hasMore;}
  conversationComplete=state.conversationDone;
 }
 if(!state.workDone){
  // Drain filtered work pages inside this one needs-me page: the listing
  // filters after paginating at limit 1, so a non-attention candidate can
  // eat a whole page while addressed work waits behind it. Reuse the same
  // cursor machinery, viewer-scoped summary reader, and next-step filter
  // per iteration — no new source, no new visibility, no budget raise.
  // Bounded at MAX_NEEDS_ME_WORK_PAGES; hitting the bound with work left
  // returns an honest incomplete page (see the complete field), never a
  // forced complete.
  let workPages=0;
  while (!state.workDone && workPages < MAX_NEEDS_ME_WORK_PAGES) {
   workPages++;
   const itemsBefore=items.length;
   const page=store.currentWorkListing(secret,roomId,{focus:'needs_me',limit:1,expectedSessionBinding,...(state.workCursor?{cursor:state.workCursor}:{})});
   for(const item of page.work)items.push({kind:'work',roomId,seq:item.revision,id:item.id,summary:clip(item.title),next:{...item.nextRead,arguments:{roomId,...item.nextRead.arguments}}});
   for(const request of page.replyRequests??[]){
    const seq=store.readTransaction(()=>withCurrentReadContext(store.db,roomId,b=>{
     const value=readCurrentRecord(store.db,roomId,'replyRequests',request.id);chargeCurrentReadBudget(b,256);
     return store.db.prepare('SELECT sequence FROM events WHERE room_id=? AND id=?').get(roomId,value.openingEventId)?.sequence;
    }));
    if(!Number.isSafeInteger(seq))throw Error('current_room_corrupt: request opening is missing');
    items.push({kind:'direct_ask',roomId,seq,id:request.id,summary:clip(`Reply requested by ${request.requesterId}`),next:{...request.nextRead,arguments:{roomId,...request.nextRead.arguments}}});
   }
   state.workCursor=page.page.nextCursor;state.workDone=!page.page.hasMore;workComplete=state.workDone;visibleThrough=page.evaluatedThrough;
   // Stop as soon as this page has yielded a standing obligation.
   if(items.length>itemsBefore)break;
  }
 }
 const complete=state.conversationDone&&state.workDone;
 if(complete&&!visibleThrough)visibleThrough=withCurrentReadContext(store.db,roomId,()=>currentVisibleHorizon(store,roomId,binding.memberId,binding.sequence));
 const nextCursor=complete?null:conversationCursorCodec(store).encode(state);
 if(nextCursor&&nextCursor.length>4096)throw new ServiceError(409,'current_room_context_unavailable','Attention continuation exceeds the existing cursor codec bound; inspect inbox and work separately.');
 return{items,complete,cursor:nextCursor,visibleThrough,coverage:{available:true,mode:'native_bounded',complete,conversation:{complete:conversationComplete,examined,direction:state.mode,range:state.mode==='recent'?{recentEventWindow:freshWindow}:{afterProvided:true}},standingWorkAndRequests:{complete:workComplete},omitted:['ambient bond and peer routing presentation','legacy board presentation'],globalAttentionComplete:false}};
}
