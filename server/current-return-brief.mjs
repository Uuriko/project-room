import{withCurrentReadContext,readCurrentHead,currentVisibleHorizon}from'./current-room-repository.mjs';
import{readCurrentEventWindow,currentEventRedactionMessages}from'./current-room-events.mjs';
import{resolveHistoryWindow,RETURN_BRIEF_DEFAULT_LIMIT}from'./return-brief.mjs';
const contexts=new WeakMap();
export function currentReturnBriefMessages(roomId,brief){const saved=contexts.get(brief);if(!saved||saved.roomId!==roomId)throw Error('Current return brief requires its selected event page');return currentEventRedactionMessages(roomId,saved.page);}
// Fixed history and current actionable state are different facts. This reader
// never manufactures a complete work aggregate from a partial room window.
export function readCurrentReturnBrief(store,token,roomId,{horizon=null,after=null,cursor=null,limit=RETURN_BRIEF_DEFAULT_LIMIT,expectedSessionBinding=null}={}){
 return store.readTransaction(()=>withCurrentReadContext(store.db,roomId,()=>{
  const auth=store.authenticate(token,roomId,expectedSessionBinding),head=readCurrentHead(store.db,roomId),visible=currentVisibleHorizon(store,roomId,auth.member.id,head.sequence),floor=store.historyFloor(roomId,auth.member.id,head.sequence),stored=store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get(roomId,auth.member.id)?.sequence??0;
  const position=Math.min(visible,Math.max(stored,floor?floor.sequence-1:0)),{H,startAfter,C,limit:pageLimit}=resolveHistoryWindow({sequence:visible,storedCursor:position,horizon,after,continuationCursor:cursor,limit}),page=readCurrentEventWindow(store,roomId,auth.member.id,{after:startAfter,limit:pageLimit,throughSequence:H,boundedWindow:true});
  const brief={contractVersion:2,roomId,viewerId:auth.member.id,viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,viewerSessionBinding:auth.sessionBinding,viewerSessionRevision:auth.sessionRevision??null,
   history:{cursor:C,evaluatedThrough:H,items:page.events,examinedThrough:page.next,hasMore:page.hasMore,continuation:page.hasMore?{horizon:H,after:page.next,cursor:C}:null},
   current:{evaluatedThrough:visible,complete:false,coverage:'addressed-current-reads',needsAttention:null,workInvolvingMe:null,nextRead:{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}/needs-me`},workNextRead:{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}/work-list?focus=needs_me`}}};contexts.set(brief,{roomId,page});return brief;
 },{maxRecords:512}));
}
