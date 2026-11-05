import {readCurrentEventEnvelope} from './current-event-envelope.mjs';
import {ownMember} from '../src/events.js';
// Normalized event-log compatibility reader. Candidate admission precedes all
// residual/audience filters; an empty visible page can still have more source.
// One call scans forward in bounded candidate windows until it has collected
// `limit` visible events, reaches the selected horizon, exhausts the per-call
// source-byte ledger, or exhausts the shared read budget — in the last two
// cases it returns the partial page with the cursor at the last fully scanned
// sequence and hasMore set, never an advanced-but-undelivered cursor. A caller
// whose own contract bounds how much source one call may examine (the native
// inbox's coverage.examined) passes boundedWindow:true to keep the original
// single-window page.
import {currentRoomAuthority,readCurrentWorkSummaryForViewer,readCurrentRecord,readCurrentHead,readCurrentMessage,readCurrentHistoryFloor,withCurrentReadContext,chargeCurrentReadBudget,CurrentReadBudgetExceeded} from './current-room-repository.mjs';
import {dmEventVisibility,dmConsentEventVisible,DM_FOLLOW_UP_TYPES} from './dm-event-visibility.mjs';
import {peerEventVisible} from './bonds.mjs';
import {rowInHistory,messageInHistory} from './history-visibility.mjs';
import {redactEventPage} from './redact-read.mjs';
import {effectiveMentionState} from './mention-lifecycle.mjs';
import {ServiceError} from './service-error.mjs';

export const CURRENT_EVENT_WINDOW=16;
export const CURRENT_EVENT_SOURCE_BYTES=64*1024;
const contexts=new WeakMap();
const fail=(status,code,message)=>{throw new ServiceError(status,code,message);};
const unavailable=()=>fail(409,'current_room_context_unavailable','Event source exceeds bounded input or is malformed; cursor was not advanced');
export function currentEventRedactionMessages(roomId,page){
 const context=page&&contexts.get(page);
 if(!context||context.roomId!==roomId)fail(409,'current_room_context_unavailable','Normalized event redaction requires its selected event page');
 return context.messages;
}
// Pages assembled from several selected windows (e.g. an event tail) carry the
// union of their windows' redaction contexts, so the HTTP layer can redact the
// combined page exactly like a single-window page.
export function combineCurrentEventPages(roomId,pages){
 const events=[],messages=[],seen=new Set();
 for(const page of pages){
  events.push(...page.events);
  const context=contexts.get(page);
  if(context&&context.roomId===roomId)for(const message of context.messages){
   if(message&&typeof message.id==='string'&&!seen.has(message.id)){seen.add(message.id);messages.push(message);}
  }
 }
 const last=pages.at(-1),combined={events,next:last?last.next:0,hasMore:last?last.hasMore:false};
 contexts.set(combined,{roomId,messages});
 return combined;
}
export function validateCurrentEventSelection(after,limit,opts){
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(422,'invalid_cursor','Invalid event cursor or limit');
 if(opts.actor!=null&&(typeof opts.actor!=='string'||!opts.actor))fail(422,'invalid_cursor','Invalid actor filter');
 for(const name of ['since','until'])if(opts[name]!=null&&(typeof opts[name]!=='string'||Number.isNaN(Date.parse(opts[name]))))fail(422,'invalid_cursor','Invalid '+name+' timestamp');
 if(opts.types!=null&&(!Array.isArray(opts.types)||!opts.types.length||opts.types.length>16||opts.types.some(type=>typeof type!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(type))))fail(422,'invalid_cursor','Invalid type filter');
 if(opts.mentions!=null&&(typeof opts.mentions!=='string'||!opts.mentions||opts.mentions.length>128))fail(422,'invalid_cursor','Invalid mentions filter');
}
function compactEvent(event){
 const out={};for(const [key,value]of Object.entries(event)){
  if(key==='idempotencyKey'||key==='roomId'||(key==='causationId'&&value===null))continue;
  out[key]=key==='mentions'?value.map(({displayName,...rest})=>rest):value;
 }return out;
}
// One bounded candidate window, processed exactly as a whole read used to be:
// admission by scalar lengths, envelope proofs, then all residual/audience
// filters over just this window's rows. `source` carries the call-wide source
// byte ledger ({bytes}) so the 64KiB prefix bound spans the whole call, not
// one window; only the call's first atom may exceed the remaining ledger.
function readCurrentEventChunk(store,roomId,viewerId,ctx,{after,source}){
 const {db,b,ceiling,floor,isOwner,identityId,opts}=ctx;
 // The primary key (room_id,sequence) bounds physical candidates. No JSON
 // predicate occurs before LIMIT. Scalar lengths admit payloads before fetch.
 const candidates=db.prepare('SELECT sequence,length(CAST(id AS BLOB)) AS idBytes,length(CAST(body AS BLOB)) AS bodyBytes FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(roomId,after,ceiling,Math.min(opts.limit,CURRENT_EVENT_WINDOW));
 const selected=[];let firstAtom=source.bytes===0;
 for(const row of candidates){
  if(!Number.isSafeInteger(row.sequence)||!Number.isSafeInteger(row.idBytes)||row.idBytes<1||row.idBytes>512
    ||!Number.isSafeInteger(row.bodyBytes)||row.bodyBytes<2)unavailable();
  const bytes=row.idBytes+row.bodyBytes+32;
  // Raw SQL work retains the 64KiB prefix and one legal first atom. The
  // projected envelope alone is charged to the shared protected JS budget.
  if (!firstAtom && source.bytes + bytes > CURRENT_EVENT_SOURCE_BYTES)break;
  const sourceRow=readCurrentEventEnvelope(db,roomId,row,b);
  source.bytes+=bytes;firstAtom=false;selected.push({sequence:row.sequence,event:sourceRow.event});
 }
 const rows=selected;
 const chipMembers=new Map(),chipMember=id=>{if(!chipMembers.has(id)){const member=readCurrentRecord(db,roomId,'members',id,b);if(member!==undefined&&member.id!==id)unavailable();chipMembers.set(id,member);}return chipMembers.get(id);};
 const messages=new Map(),load=id=>{
  if(typeof id!=='string'||!id||id.length>200)return undefined;
  if(!messages.has(id))messages.set(id,readCurrentMessage(db,roomId,id,b)?.value);
  return messages.get(id);
 };
 // Follow-up party resolution and floor checks use only addressed records.
 for(const {event:e}of rows)if(DM_FOLLOW_UP_TYPES.has(e.type)||e.data.requestMessageId)load(e.data.messageId??e.data.requestMessageId);
 const dm=dmEventVisibility(viewerId,[...messages.values()].filter(Boolean),rows);
 const mentioned=opts.mentions==='me'?viewerId:opts.mentions;
 const visible=rows.filter(row=>{
  const e=row.event;
  if(!rowInHistory(row,floor,messages)||!dm(e)||!dmConsentEventVisible(e,viewerId,isOwner)||!peerEventVisible(e,{memberId:viewerId,identityId,isOwner}))return false;
  if(opts.actor!=null&&e.actorId!==opts.actor||opts.since!=null&&e.at<opts.since||opts.until!=null&&e.at>opts.until||opts.types!=null&&!opts.types.includes(e.type))return false;
  if(mentioned!=null&&!db.prepare('SELECT 1 FROM mention_states WHERE room_id=? AND message_event_id=? AND mentioned_member_id=? LIMIT 1').get(roomId,e.id,mentioned))return false;
  if(e.type==='message.posted'){
   const message=load(e.data.messageId??e.id);
   if(floor&&!messageInHistory(message,floor))return false;
  }
  return true;
 });
 for(const {event:e}of visible){
  if(e.type!=='message.posted')continue;
  const scalars=db.prepare('SELECT length(CAST(mentioned_member_id AS BLOB)) AS memberBytes,length(CAST(state AS BLOB)) AS stateBytes FROM mention_states WHERE room_id=? AND message_event_id=? LIMIT 101').all(roomId,e.id);
  if(scalars.length>100||scalars.some(r=>r.memberBytes>512||r.stateBytes>128))unavailable();
  chargeCurrentReadBudget(b,scalars.reduce((n,r)=>n+r.memberBytes+r.stateBytes+32,0),scalars.length);
  const chips=db.prepare('SELECT mentioned_member_id AS memberId,state,timeout_at AS timeoutAt FROM mention_states WHERE room_id=? AND message_event_id=? LIMIT 101').all(roomId,e.id);
  if(chips.length)e.mentions=chips.map(chip=>({memberId:chip.memberId,state:effectiveMentionState(chip,store.now()),displayName:chipMember(chip.memberId)?.displayName??chip.memberId}));
 }
 const next=selected.length?selected.at(-1).sequence:after;
 const workDefinitions=new Map();
 const privateWorkEvents=visible.map(row=>{
  const e=row.event,id=e.data?.workItemId;
  if(typeof id!=='string'||!Object.hasOwn(e.data,'title')&&!Object.hasOwn(e.data,'definitionOfDone'))return row;
  if(!workDefinitions.has(id))workDefinitions.set(id,readCurrentWorkSummaryForViewer(db,roomId,id,viewerId,b));
  if(workDefinitions.get(id).title!==null)return row;
  return {...row,event:{...e,data:{...e.data,...(Object.hasOwn(e.data,'title')?{title:null}:{}),...(Object.hasOwn(e.data,'definitionOfDone')?{definitionOfDone:null}:{})}}};
 });
 const events=redactEventPage({events:privateWorkEvents,next,hasMore:next<ceiling},[...messages.values()].filter(Boolean)).events;
 return {events,messages:[...messages.values()].filter(Boolean),next,hasMore:next<ceiling};
}
// Caller owns the read transaction/authentication. Nested current contexts reuse
// the same budget, including auth, source envelopes, proofs, messages and chips.
export function readCurrentEventWindow(store,roomId,viewerId,{after=0,limit=100,throughSequence,boundedWindow=false,...opts}={}){
 return withCurrentReadContext(store.db,roomId,b=>{
  validateCurrentEventSelection(after,limit,opts);
  const db=store.db,head=readCurrentHead(db,roomId,b),authority=currentRoomAuthority(db,roomId,{memberId:viewerId});
  if(!head||!ownMember(authority?.members,viewerId)||ownMember(authority.members,viewerId).active===false)fail(403,'member_required','Viewer must belong to this room');
  if(after>head.sequence)fail(409,'cursor_ahead','Cursor exceeds room history; fetch a fresh snapshot');
  const ceiling=throughSequence??head.sequence;if(!Number.isSafeInteger(ceiling)||ceiling<after||ceiling>head.sequence)fail(422,'invalid_cursor','Invalid selected history horizon');
  const floor=readCurrentHistoryFloor(db,roomId,viewerId,b),isOwner=viewerId===authority.ownerId;
  const identityId=store.bonds.identityForMember(roomId,viewerId);
  const ctx={db,b,ceiling,floor,isOwner,identityId,opts:{...opts,limit}};
  // Scan forward window by window. The scan stops when the page is full, the
  // horizon is reached, the source-byte ledger is spent, or the shared read
  // budget trips mid-window; a budget trip after at least one fully scanned
  // window yields the honest partial page instead of refusing the whole read.
  const source={bytes:0},events=[],messages=[],seenMessages=new Set();
  let next=after,scanAfter=after;
  while(true){
   let chunk;
   try{chunk=readCurrentEventChunk(store,roomId,viewerId,ctx,{after:scanAfter,source});}
   catch(error){
    if(error instanceof CurrentReadBudgetExceeded&&next>after)break;
    throw error;
   }
   for(const message of chunk.messages)if(!seenMessages.has(message.id)){seenMessages.add(message.id);messages.push(message);}
   let trimmed=false;
   for(const row of chunk.events){if(events.length>=limit){trimmed=true;break;}events.push(row);}
   next=trimmed?events.at(-1).sequence:chunk.next;
   if(boundedWindow||trimmed||events.length>=limit||!chunk.hasMore||chunk.next<=scanAfter||source.bytes>=CURRENT_EVENT_SOURCE_BYTES)break;
   scanAfter=chunk.next;
  }
  let page=redactEventPage({events,next,hasMore:next<ceiling},messages);
  if(opts.compact===true)page={...page,events:page.events.map(row=>({...row,event:compactEvent(row.event)}))};
  contexts.set(page,{roomId,messages});
  return page;
 });
}

export function redactSelectedEventPage(store,roomId,page){return redactEventPage(page,store.redactionMessages(roomId,page));}
