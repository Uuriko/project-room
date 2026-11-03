import {createHash} from 'node:crypto';
import {isCurrentRoom,withCurrentReadContext,readCurrentHead,readCurrentSelectedWorkState,readCurrentMessage,readCurrentHistoryFloor,readCurrentRecord,chargeCurrentReadBudget} from './current-room-repository.mjs';
import {readCurrentEventEnvelope} from './current-event-envelope.mjs';
import {CURRENT_EVENT_SOURCE_BYTES} from './current-room-events.mjs';
import {affectedMessageIds} from './messages-store.mjs';
import {conversationCursorCodec} from './conversation-sync.mjs';
import {messageInHistory} from './history-visibility.mjs';
import {stampDiscussion} from './content-trust.mjs';
import {nextWorkStep} from '../src/workflow.js';
import {validId} from '../src/events.js';
import {DiscussionError,DISCUSSION_BYTE_LIMIT,DISCUSSION_MAX_LIMIT} from './work-discussion.mjs';

const SOURCE_LIMIT=4, MESSAGE_LIMIT=12, ANCESTRY_LIMIT=8;
const fail=(code,message,status=422)=>{throw new DiscussionError(status,code,message);};
const reset=()=>fail('discussion_reset_required','Discussion source, authority or service changed; discard this continuation and restart without cursor or resumeToken',409);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick=(value,keys)=>Object.fromEntries(keys.split(' ').filter(key=>Object.hasOwn(value,key)).map(key=>[key,structuredClone(value[key])]));

// A fixed room-message source window is examined BEFORE relation/privacy filters.
// It is deliberately not an indexed work-history enumeration. Empty-more pages
// remain incomplete; no cursor contains a client-readable private source offset.
export function readCurrentWorkDiscussion(store,token,roomId,workItemId,{cursor=null,since,limit=20,consistent=false,resumeToken=null,expectedSessionBinding=null}={}){
 if(!isCurrentRoom(store.db,roomId))return undefined;
 return store.readTransaction(()=>withCurrentReadContext(store.db,roomId,b=>{
  const auth=store.authenticate(token,roomId,expectedSessionBinding);
  if(!validId(workItemId)||!integer(limit)||limit<1||limit>DISCUSSION_MAX_LIMIT||typeof consistent!=='boolean'
   ||cursor!==null&&since!==undefined||resumeToken!==null&&(cursor!==null||since!==undefined)||consistent&&since!==undefined
   ||since!==undefined&&!integer(since))fail('invalid_discussion','Choose one work item and bounded page; use a cursor, checkpoint, or since separately');
  const selected=readCurrentSelectedWorkState(store,roomId,workItemId,auth.member.id);
  const item=Object.hasOwn(selected.state.workItems,workItemId)?selected.state.workItems[workItemId]:null;
  if(!item)fail('work_not_found','Work item not found in this Room',404);
  const head=readCurrentHead(store.db,roomId,b),floor=readCurrentHistoryFloor(store.db,roomId,auth.member.id);
  const scope=digest([roomId,workItemId,auth.member.id,auth.member.revision,auth.credentialHash??null,auth.account?.id??null,
   auth.account?.authEpoch??null,auth.sessionBinding??null,auth.sessionRevision??null,head.head_sha256,item.revision,
   floor?[floor.version??1,floor.sequence,floor.at,floor.sameInstant?.size??null]:null]);
  const codec=conversationCursorCodec(store),given=resumeToken??cursor;
  let saved=null;
  if(given!==null){
   if(typeof given!=='string'||given.length>2048||!/^[A-Za-z0-9_-]+$/.test(given))fail('invalid_discussion','Malformed discussion continuation');
   saved=codec.decode(given);
   if(!saved||saved.v!==1||saved.type!=='current_work_discussion'||saved.scope!==scope
    ||saved.kind!==(resumeToken!==null?'checkpoint':'page')||!integer(saved.sourceAfter)||!integer(saved.visibleAfter)
    ||typeof saved.sourceAfterId!=='string'||Buffer.byteLength(saved.sourceAfterId)>200||!integer(saved.since)||saved.since>saved.visibleAfter||saved.visibleAfter>saved.sourceAfter||saved.sourceAfter>head.sequence)reset();
  }
  const start=resumeToken!==null?saved.sourceAfter:since??saved?.since??0;
  if(start>head.sequence)fail('discussion_ahead','Discussion checkpoint exceeds current history; restart without a checkpoint',409);
  let sourceAfter=resumeToken!==null?start:saved?.sourceAfter??start,visibleAfter=resumeToken!==null?start:saved?.visibleAfter??start;
  let sourceAfterId=resumeToken!==null?'':saved?.sourceAfterId??'';
  const pageAfter=visibleAfter,cache=new Map(),members=new Map();
  const read=id=>{
   if(cache.has(id))return cache.get(id);
   if(cache.size===MESSAGE_LIMIT)fail('current_room_context_unavailable','Discussion ancestry exceeds this bounded page; select a nearer message or restart with a newer checkpoint',409);
   const record=readCurrentMessage(store.db,roomId,id,b);
   if(!record)fail('discussion_history_changed','Discussion ancestry is unavailable; restart after recovery',409);
   cache.set(id,record);return record;
  };
  const relation=record=>{
   let current=record;const seen=new Set();
   for(let depth=0;depth<=ANCESTRY_LIMIT;depth++){
    const message=current.value;
    if(seen.has(message.id))throw Error('current_room_corrupt: discussion ancestry cycle');seen.add(message.id);
    if(message.id===item.sourceMessageId)return message.id===record.value.id?'source':'reply';
    if(message.workItemId)return message.workItemId===workItemId?(message.id===record.value.id?'linked':'reply'):null;
    if(!message.replyToId)return null;
    if(depth===ANCESTRY_LIMIT)fail('current_room_context_unavailable','Discussion reply ancestry exceeds bounded selection; use a nearer message',409);
    const parent=read(message.replyToId);if(parent.row.seq>=current.row.seq)throw Error('current_room_corrupt: discussion parent sequence');current=parent;
   }
  };
  // Reuse the existing code-owned visibility indexes: hidden DMs never
  // consume a source slot or affect empty-page/continuation boundaries.
  const sources=[
   ['current_messages_public_seq',"(to_member_id IS NULL OR to_member_id='')",[]],
   ['current_messages_incoming_seq','to_member_id=?',[auth.member.id]],
   ['current_messages_outgoing_seq',"author_id=? AND to_member_id IS NOT NULL AND to_member_id<>''",[auth.member.id]]
  ],unique=new Map();
  for(const [index,where,args] of sources){
   const admitted=store.db.prepare(`SELECT CASE WHEN length(CAST(message_id AS BLOB))<=200 THEN message_id END AS message_id,seq
    FROM messages INDEXED BY ${index} WHERE room_id=? AND (seq,message_id)>(?,?) AND seq<=? AND ${where}
    ORDER BY seq,message_id LIMIT ?`).all(roomId,sourceAfter,saved&&resumeToken===null?sourceAfterId:'\uffff',head.sequence,...args,SOURCE_LIMIT+1);
   chargeCurrentReadBudget(b,admitted.reduce((n,row)=>n+Buffer.byteLength(row.message_id??'')+32,0),admitted.length);
   for(const row of admitted){if(!validId(row.message_id))fail('current_room_context_unavailable','Discussion source identity exceeds bounded input',409);unique.set(row.message_id,row);}
  }
  const rows=[...unique.values()].sort((a,c)=>a.seq-c.seq||Buffer.compare(Buffer.from(a.message_id),Buffer.from(c.message_id))).slice(0,SOURCE_LIMIT+1);
  const items=[];let bytes=0,sourceBytes=0,hasMore = rows.length > SOURCE_LIMIT;
  for(const row of rows.slice(0,SOURCE_LIMIT)){
   if(!validId(row.message_id))fail('current_room_context_unavailable','Discussion source identity exceeds bounded input',409);
   const record=read(row.message_id),message=record.value;if(record.row.seq!==row.seq)throw Error('current_room_corrupt: discussion source sequence');
   const kind=relation(record),visible=(!message.toMemberId||message.toMemberId===auth.member.id||message.authorId===auth.member.id)&&messageInHistory(message,floor);
   // Removed text never enters a discussion cache, in either read mode.
   if(!kind||!visible||message.deletedAt||message.redacted||typeof message.body!=='string'){sourceAfter=row.seq;sourceAfterId=row.message_id;continue;}
   const scalar=store.db.prepare('SELECT sequence,length(CAST(id AS BLOB)) AS idBytes,length(CAST(body AS BLOB)) AS bodyBytes FROM events WHERE room_id=? AND sequence=?').get(roomId,row.seq);
   if(!scalar||!Number.isSafeInteger(scalar.idBytes)||scalar.idBytes<1||!Number.isSafeInteger(scalar.bodyBytes)||scalar.bodyBytes<2)
    fail('current_room_context_unavailable','Discussion opening metadata is unavailable',409);
   const rawBytes=scalar.idBytes+scalar.bodyBytes+32;
   // Same raw-SQL prefix policy as the qualified current event reader: one
   // legal large first atom, then stop BEFORE an unexamined opening. Only
   // the projected envelope crosses into JS and consumes protected bytes.
   if (sourceBytes && sourceBytes + rawBytes > CURRENT_EVENT_SOURCE_BYTES){hasMore=true;break;}
   const opening=readCurrentEventEnvelope(store.db,roomId,scalar,b),event=opening.event;
   sourceBytes+=rawBytes;
   if(event.roomId!==roomId||event.type!=='message.posted'||!affectedMessageIds(event).includes(message.id)||event.actorId!==message.authorId)
    throw Error('current_room_corrupt: discussion opening identity');
   const entry={sequence:row.seq,eventId:opening.id,relation:kind,message:pick(message,'id authorId body createdAt replyToId toMemberId workItemId')};
   if(message.proposal)entry.message.proposal=pick(message.proposal,'packetId basisRevision submittedAtRevision attribution');
   const size=Buffer.byteLength(JSON.stringify(entry));
   if (items.length === limit || bytes + size > DISCUSSION_BYTE_LIMIT){if(!items.length)fail('discussion_entry_too_large','Selected message exceeds discussion page budget',413);hasMore=true;break;}
   items.push(entry);bytes+=size;sourceAfter=row.seq;sourceAfterId=row.message_id;visibleAfter=row.seq;
  }
  if(!hasMore)sourceAfter=head.sequence;
  for(const id of new Set(items.flatMap(row=>[row.message.authorId,row.message.toMemberId]).filter(Boolean))){
   const member=readCurrentRecord(store.db,roomId,'members',id,b);members.set(id,member?pick(member,'id displayName kind active'):{id,unavailable:true});
  }
  const durable=consistent||resumeToken!==null||saved?.durable===true;
  const encode=kind=>codec.encode({v:1,type:'current_work_discussion',kind,scope,since:kind==='checkpoint'?head.sequence:start,
   sourceAfter:kind==='checkpoint'?head.sequence:sourceAfter,sourceAfterId:kind==='checkpoint'?'':sourceAfterId,visibleAfter:kind==='checkpoint'?head.sequence:visibleAfter,durable});
  return stampDiscussion({contractVersion:2,roomId,workItemId,viewerId:auth.member.id,
   viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,viewerSessionBinding:auth.sessionBinding,viewerSessionRevision:auth.sessionRevision??null,
   selection:{sourceMessageId:item.sourceMessageId??null,rule:'source-linked-descendants-v1'},
   discussion:{horizon:head.sequence,since:start,after:pageAfter,cursor,items,hasMore,nextCursor:hasMore?encode('page'):null,
    checkpoint:hasMore?null:head.sequence,limit,rowBytes:bytes,cursorMode:'opaque-head-bound-v1',
    sourceWindow:{complete:!hasMore,maxSources:SOURCE_LIMIT},...(durable?{consistent:true,resumeToken:hasMore?null:encode('checkpoint')}: {})},
   current:{evaluatedThrough:head.sequence,evaluatedAt:new Date(store.now()).toISOString(),workRevision:item.revision,workState:item.state,next:nextWorkStep(item,store.now()),participants:[...members.values()]},
   scope:{membership:'room',targetedMessages:'room-visible',externalExecution:false,messageVisibility:{publicMessages:'room-members',directedMessages:'participants-only'},
    omitted:['unrelated_messages','other_work','reactions','raw_events','private_reminders','read_marker'],
    guidance:'Bounded source pages can be empty with more remaining. Follow nextCursor until checkpoint. Continuations are bound to this current head and authority; any room write or service restart requires restarting without cursor/resumeToken. This is not a historical snapshot. Numeric checkpoints are unanchored; discard after recovery. Reads neither acknowledge nor authorize work.'}});
 },{maxRecords:512}));
}
