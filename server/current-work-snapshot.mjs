import {createHash} from 'node:crypto';
import {conversationCursorCodec} from './conversation-sync.mjs';
import {withCurrentReadContext,readCurrentHead,readCurrentWorkItem} from './current-room-repository.mjs';
import {currentWorkRecord} from './work-context.mjs';
import {charterContext} from '../src/room-charter.js';
import {ServiceError} from './service-error.mjs';
const invalid=()=>{throw new ServiceError(409,'stale_work_snapshot_cursor','Work or access changed. Restart the work snapshot without cursor.');};
export function readCurrentWorkSnapshot(store,token,roomId,{expectedSessionBinding=null,view='work',cursor=null}={}){
 return store.readTransaction(()=>{
  const auth=store.authenticate(token,roomId,expectedSessionBinding),codec=conversationCursorCodec(store);
  const binding=withCurrentReadContext(store.db,roomId,()=>({kind:'work_snapshot_v2',roomId,viewerId:auth.member.id,credential:createHash('sha256').update(token).digest('hex'),head:readCurrentHead(store.db,roomId).head_sha256,view}));
  const saved=cursor===null?{...binding,after:''}:codec.decode(cursor);
  if(!saved||Object.keys(saved).sort().join(' ')!==[...Object.keys(binding),'after'].sort().join(' ')||Object.entries(binding).some(([k,v])=>saved[k]!==v)||typeof saved.after!=='string'||Buffer.byteLength(saved.after)>200)invalid();
  return withCurrentReadContext(store.db,roomId,b=>{
   const overview=store.currentOverview(roomId,auth.member.id,{limit:4,workAfter:saved.after});
   const parties=store.privateWorkParties(roomId,{workIds:Object.keys(overview.state.workItems)}),workItems=Object.create(null);
   let examinedAfter=saved.after;
   for(const [id,summary]of Object.entries(overview.state.workItems)){
    const scalar=store.db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);
    if(Object.keys(workItems).length&&b.bytes+(scalar?.bytes??0)+16384>256*1024)break;
    const item=readCurrentWorkItem(store.db,roomId,id),withheld=parties.has(id)&&summary.title===null;
    workItems[id]=currentWorkRecord(withheld?{...item,title:null,definitionOfDone:null}:item);examinedAfter=id;
   }
   const more=Object.keys(workItems).length<Object.keys(overview.state.workItems).length||overview.workWindow.nextAfter!==null;
   const nextCursor=more?codec.encode({...binding,after:examinedAfter}):null;
   return {snapshotView:view,snapshotVersion:2,representation:'normalized-current-v1',roomId,sequence:overview.sequence,
    state:{room:overview.state.room,members:store.withIdentityRevoked(roomId,overview).state.members,workItems},
    charter:charterContext(overview.state.room),viewerId:auth.member.id,viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,
    viewerSessionBinding:auth.sessionBinding,viewerSessionRevision:auth.sessionRevision??null,
    workWindow:{shown:Object.keys(workItems).length,complete:cursor===null&&nextCursor===null,hasMore:nextCursor!==null,nextCursor,
     nextRead:nextCursor?{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}?view=${view}&work_cursor=${encodeURIComponent(nextCursor)}`}:null}};
  },{maxRecords:1024});
 });
}
