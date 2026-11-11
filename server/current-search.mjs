import {createHash} from 'node:crypto';
import {readConversation,conversationCursorCodec} from './conversation-sync.mjs';
import {withCurrentReadContext,readCurrentHead,readCurrentWorkItem} from './current-room-repository.mjs';
import {stampSearch} from './content-trust.mjs';
import {ServiceError} from './service-error.mjs';
const invalid=()=>{throw new ServiceError(422,'invalid_search_cursor','Expired or invalid search cursor. Restart search without before.');};
// A search page admits a fixed source window BEFORE matching. Counts never
// describe excluded private sources; an empty page can still carry more work.
export function readCurrentSearch(store,token,roomId,query,kind,{limit=50,before=null,expectedSessionBinding=null}={}){
 return store.readTransaction(()=>{
  const auth=store.authenticate(token,roomId,expectedSessionBinding),codec=conversationCursorCodec(store),needle=query.trim().toLowerCase();
  const binding=withCurrentReadContext(store.db,roomId,()=>({kind:'search_v2',roomId,viewerId:auth.member.id,credential:createHash('sha256').update(token).digest('hex'),head:readCurrentHead(store.db,roomId).head_sha256,query:needle,selection:kind,limit}));
  const initial={...binding,messageCursor:null,workAfter:'',messagesDone:kind==='work',workDone:kind==='messages'||kind==='pinned'};
  const saved=before===null?initial:codec.decode(before);
  if(!saved||Object.keys(saved).sort().join(' ')!==Object.keys(initial).sort().join(' ')||Object.entries(binding).some(([k,v])=>saved[k]!==v)
   ||!(saved.messageCursor===null||typeof saved.messageCursor==='string')||typeof saved.workAfter!=='string'||Buffer.byteLength(saved.workAfter)>200
   ||typeof saved.messagesDone!=='boolean'||typeof saved.workDone!=='boolean'||saved.messagesDone&&saved.workDone)invalid();
  const next={...saved},messages=[],workItems=[];
  if(!saved.messagesDone){
   const page=readConversation(store,token,roomId,{limit:Math.min(limit,4),cursor:saved.messageCursor,expectedSessionBinding});
   if(page.mode==='reset')invalid();
   const muted=new Set(auth.member.mutedMemberIds??[]);
   const pins=kind==='pinned'?new Set(store.currentOverview(roomId,auth.member.id,{limit:1}).state.pins.map(p=>p.messageId)):null;
   for(const m of page.messages)if(typeof m.body==='string'&&!muted.has(m.authorId)&&(!pins||pins.has(m.id))&&m.body.toLowerCase().includes(needle))
    messages.push({id:m.id,authorId:m.authorId,body:m.body,createdAt:m.createdAt,workItemId:m.workItemId});
   next.messageCursor=page.nextCursor;next.messagesDone=page.nextCursor===null;
  }
  if(!saved.workDone)withCurrentReadContext(store.db,roomId,b=>{
   const page=store.currentOverview(roomId,auth.member.id,{limit:Math.min(limit,2),workAfter:saved.workAfter});
   let examinedAfter=saved.workAfter,examined=0;
   for(const [id,summary]of Object.entries(page.state.workItems)){
    const scalar=store.db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);
    if(examined&&b.bytes+(scalar?.bytes??0)+16384>256*1024)break;
    const item=readCurrentWorkItem(store.db,roomId,id),withheld=summary.title===null;
    const text=(withheld?item.description??'':`${item.title??''} ${item.description??''} ${item.definitionOfDone??''}`).toLowerCase();
    if(text.includes(needle))workItems.push({id,title:summary.title,state:item.state,accountableMemberId:item.accountableMemberId});
    examined++;examinedAfter=id;
   }
   next.workAfter=examinedAfter;next.workDone=examined===Object.keys(page.state.workItems).length&&page.workWindow.nextAfter===null;
  },{maxRecords:1024});
  const hasMore=!next.messagesDone||!next.workDone,nextCursor=hasMore?codec.encode(next):null;
  if(nextCursor&&nextCursor.length>4096)throw new ServiceError(409,'current_search_selection_unavailable','Search continuation exceeds the bounded cursor; search one kind at a time.');
  return stampSearch({contractVersion:2,roomId,query:query.trim(),messages,workItems,total:null,nextCursor,
   sourceWindow:{complete:!hasMore,messages:{complete:next.messagesDone},work:{complete:next.workDone}},
   page:{hasMore,nextCursor,nextRead:hasMore?{query:query.trim(),kind,limit,before:nextCursor}:null}},auth.member.id);
 });
}
