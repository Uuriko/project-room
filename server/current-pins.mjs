import {isCurrentRoom,readCurrentHead,readCurrentRecord,readCurrentMessage,readCurrentHistoryFloor,currentRoomAuthority,currentVisibleHorizon,withCurrentReadContext,chargeCurrentReadBudget} from './current-room-repository.mjs';
import {conversationCursorCodec} from './conversation-sync.mjs';
import {messageVisibleToViewer} from './history-visibility.mjs';
import {PIN_LIMIT,ownMember} from '../src/events.js';
import {MESSAGE_PROOF_SELECT} from './write-integrity.mjs';
import {ServiceError} from './service-error.mjs';
const invalid=()=>{throw new ServiceError(422,'invalid_cursor','Invalid or expired pin cursor; restart GET pins without cursor. A service restart invalidates continuations.');};
const corrupt=()=>{throw Error('Current pin records require reconciliation');};
// Caller holds its authenticated read transaction. The activation pack already
// has a qualified viewer; the same protected member check applies here.
export function readCurrentPinsWindow(store,roomId,viewerId,{cursor=null}={}) {
 if(!isCurrentRoom(store.db,roomId))return null;
 if(!store.db.isTransaction)throw Error('Current pins require a read transaction');
 return withCurrentReadContext(store.db,roomId,b=>{
  const db=store.db,head=readCurrentHead(db,roomId,b),authority=currentRoomAuthority(db,roomId,{memberId:viewerId});
  if(!head||!ownMember(authority.members,viewerId)||ownMember(authority.members,viewerId).active===false)throw new ServiceError(403,'member_required','Viewer must belong to this room');
  const pins=readCurrentRecord(db,roomId,'metadata','pins',b)??[];
  if(!Array.isArray(pins)||pins.length>PIN_LIMIT||pins.some(p=>!p||typeof p.messageId!=='string'||typeof p.pinnedById!=='string'||typeof p.pinnedAt!=='string'))corrupt();
  const codec=conversationCursorCodec(store);let after=0;
  if(cursor!==null){const c=codec.decode(cursor);if(!c||Object.keys(c).sort().join(',')!=='after,head,kind,roomId,v,viewerId'||c.v!==1||c.kind!=='current-pins'||c.roomId!==roomId||c.viewerId!==viewerId||c.head!==head.head_sha256||!Number.isSafeInteger(c.after)||c.after<0||c.after>pins.length)invalid();after=c.after;}
  const sequence=currentVisibleHorizon(store,roomId,viewerId,head.sequence),floor=readCurrentHistoryFloor(db,roomId,viewerId,b),items=[];let next=after;
  for(const pin of pins.slice(after,after+4)) {
   // Point scalar admission leaves room for the selected body and its exact
   // witness/receipt. Never advance over a candidate excluded by the budget.
   const scalar=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT.split(',').map(k=>`coalesce(length(CAST(m.${k} AS BLOB)),0)`).join('+')} bytes,r.payload_bytes witnessBytes,p.receipt_id receiptId,length(CAST(a.counts_json AS BLOB)) receiptBytes
    FROM messages m LEFT JOIN current_room_records r ON r.room_id=m.room_id AND r.domain='messageWitness' AND r.record_key=m.message_id
    LEFT JOIN current_room_record_proofs p ON p.room_id=r.room_id AND p.domain=r.domain AND p.record_key=r.record_key
    LEFT JOIN operator_actions a ON a.id=p.receipt_id WHERE m.room_id=? AND m.message_id=?`).get(roomId,pin.messageId);
   chargeCurrentReadBudget(b,256);
   const reserve=(scalar?.bytes??0)+(scalar?.witnessBytes??0)+(b.receipts.has(scalar?.receiptId)?0:scalar?.receiptBytes??0)+4096;
   if(next>after&&(b.bytes+reserve>256*1024-8192||b.records+16>200))break;
   const message=readCurrentMessage(db,roomId,pin.messageId,b)?.value;next++;
   if(messageVisibleToViewer(message,viewerId,floor))items.push({...pin,message});
  }
  const hasMore=next<pins.length,nextCursor=hasMore?codec.encode({v:1,kind:'current-pins',roomId,viewerId,head:head.head_sha256,after:next}):null;
  return {contractVersion:2,roomId,sequence,limit:PIN_LIMIT,items,sourceWindow:{complete:!hasMore,sourceBound:4},
   page:{hasMore,nextCursor,nextRead:hasMore?{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}/pins?cursor=${encodeURIComponent(nextCursor)}`}:null}};
 });
}
