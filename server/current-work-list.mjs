import {createHmac,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {INBOX_WORK_ROLES} from './current-inbox-indexes.mjs';
import {readCurrentRecord,readCurrentWorkSummaryForViewer,chargeCurrentReadBudget,isCurrentRoom,readCurrentHead,readCurrentWorkItem,readCurrentOverviewWindow,currentVisibleHorizon,withCurrentReadContext} from './current-room-repository.mjs';
import {ownMember} from '../src/events.js';
import {validWorkPage} from './work-list-page.mjs';
import {nextWorkStep} from '../src/workflow.js';
import {currentResult} from '../src/work-selectors.js';
import {workHelpContext} from '../src/work-help.js';
import {charterContext} from '../src/room-charter.js';
import {messageInHistory} from './history-visibility.mjs';
import {ServiceError} from './service-error.mjs';

const fail=(code,message,status=422)=>{throw new ServiceError(status,code,message);};
const keys='v roomId viewerId head focus limit at workAfter requestAfter workDone requestsDone'.split(' ');
const storeCursorKeys=new WeakMap();
const cursorKey = (store, secret) => {
  if (!storeCursorKeys.has(store)) storeCursorKeys.set(store, randomBytes(32));
  return createHmac('sha256', storeCursorKeys.get(store)).update('current-work-source-v2:' + secret).digest();
};
function encode(value,store,secret) {
  // Source keys include excluded private requests. The random server-owned
  // key cannot be derived by their credential holder. Restarts invalidate it.
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey(store,secret),nonce);  return Buffer.concat([nonce,cipher.update(JSON.stringify(value),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64url');
}
function decode(cursor,store,secret) {
  try {
    const bytes=Buffer.from(cursor,'base64url');if(bytes.toString('base64url')!==cursor||bytes.length<29)throw Error();
    const decipher=createDecipheriv('aes-256-gcm',cursorKey(store,secret),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));
    const text=Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8'),value=JSON.parse(text);
    if(JSON.stringify(value)!==text||Object.keys(value).join(' ')!==keys.join(' '))throw Error();
    return value;
  } catch {fail('invalid_work_cursor','Expired or invalid work cursor. A service restart invalidates source continuations; restart room_list_work without cursor.');}
}

// Each indexed stream is independently capped before workflow/history filters.
// Merging their source keys keeps a complete id-ordered continuation even when
// one task names this viewer in several roles or a page has no actionable work.
function addressedWorkWindow(store,roomId,memberId,ownerId,after,limit,b) {
  const candidates=new Set(); let examinedKeys=0;
  for (const [role,path] of INBOX_WORK_ROLES) {
    const rows=store.db.prepare(`SELECT record_key FROM current_room_records INDEXED BY current_inbox_work_${role}
      WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'${path}')=? AND record_key>?
      ORDER BY record_key LIMIT ?`).all(roomId,memberId,after,limit+1);
    chargeCurrentReadBudget(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),rows.length);
    examinedKeys+=rows.length; for(const row of rows)candidates.add(row.record_key);
  }
  if(memberId===ownerId) {
    const rows=store.db.prepare(`SELECT record_key FROM current_room_records INDEXED BY current_inbox_owner_handoffs
      WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'$.work.handoff.open')=1
        AND json_extract(payload,'$.work.handoff.triageMemberId') IS NULL AND record_key>?
      ORDER BY record_key LIMIT ?`).all(roomId,after,limit+1);
    chargeCurrentReadBudget(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),rows.length);
    examinedKeys+=rows.length; for(const row of rows)candidates.add(row.record_key);
  }
  const keys=[...candidates].sort((a,c)=>Buffer.compare(Buffer.from(a),Buffer.from(c)));
  const selected=keys.slice(0,limit),items=selected.map(id=>readCurrentWorkSummaryForViewer(store.db,roomId,id,memberId,b));
  return {items,hasMore:keys.length>selected.length,after:selected.at(-1)??after,examinedKeys};
}
function addressedRequestWindow(store,roomId,memberId,after,limit,b) {
  const rows=store.db.prepare(`SELECT record_key FROM current_room_records INDEXED BY current_inbox_open_requests
    WHERE room_id=? AND domain='replyRequests' AND json_extract(payload,'$.status')='open'
      AND json_extract(payload,'$.recipientId')=? AND record_key>? ORDER BY record_key LIMIT ?`)
    .all(roomId,memberId,after,limit+1);
  chargeCurrentReadBudget(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),rows.length);
  const selected=rows.slice(0,limit),requests=selected.map(({record_key:id})=>{
    const request=readCurrentRecord(store.db,roomId,'replyRequests',id,b);
    if(request?.id!==id||request.recipientId!==memberId||request.status!=='open')throw Error('current_room_corrupt: addressed request index binding differs');
    return request;
  });
  return {requests,hasMore:rows.length>selected.length,examinedAfter:selected.at(-1)?.record_key??after};
}

// The cursor walks source keys, including excluded records. A filtered empty
// page is not completion. No complete filtered count or global ranking is claimed.
export function readCurrentWorkListing(store,secret,roomId,args={}) {
  return store.readTransaction(()=>{
    const auth=store.authenticate(secret,roomId,args.expectedSessionBinding??null);
    if(!isCurrentRoom(store.db,roomId))return null;
    if(!validWorkPage(args))fail('invalid_work_page','Use limit 1–100 and a returned cursor.');
    const focus=args.focus??'all';
    if(!['all','needs_me','results','help_wanted'].includes(focus))fail('invalid_focus','Choose a supported work focus.');
    if(args.query!==undefined||args.sort!==undefined)
      fail('current_work_selection_unavailable','This bounded listing supports all, needs_me, results, and help_wanted. Global search and ranking require a qualified reader.',409);
    return withCurrentReadContext(store.db,roomId,b=>{
      // Invitation evaluation reads one proven full item; retain the same read budget.
      const head=readCurrentHead(store.db,roomId),limit=Math.min(args.limit??4,focus==='help_wanted'?1:4);
      const initial={v:2,roomId,viewerId:auth.member.id,head:head.head_sha256,focus,limit,at:store.now(),workAfter:'',requestAfter:'',workDone:false,requestsDone:focus!=='needs_me'};
      const saved=args.cursor===undefined?initial:decode(args.cursor,store,secret);
      if(saved.v!==2||saved.roomId!==roomId||saved.viewerId!==auth.member.id||saved.head!==initial.head||saved.focus!==focus||saved.limit!==limit)
        fail('stale_work_cursor','Work, access, or selection changed. Restart room_list_work without cursor.',409);
      if(!Number.isSafeInteger(saved.at)||saved.at<0||typeof saved.workAfter!=='string'||typeof saved.requestAfter!=='string'
        ||typeof saved.workDone!=='boolean'||typeof saved.requestsDone!=='boolean'||saved.workDone&&saved.requestsDone)
        fail('invalid_work_cursor','Invalid source continuation. Restart without cursor.');
      const addressed=focus==='needs_me';
      const room=addressed?readCurrentRecord(store.db,roomId,'metadata','room',b):null;
      const source=addressed&&!saved.workDone?addressedWorkWindow(store,roomId,auth.member.id,room.ownerId,saved.workAfter,limit,b):null;
      const overview=addressed?{state:{members:{[auth.member.id]:auth.member},room,workItems:{}},workWindow:{nextAfter:source?.hasMore?source.after:null}}
        :readCurrentOverviewWindow(store,roomId,{viewerId:auth.member.id,workAfter:saved.workAfter,limit:saved.workDone?1:limit});
      const member=ownMember(overview.state.members,auth.member.id),now=focus==='help_wanted'?store.now():saved.at;
      const items=saved.workDone?[]:source?.items??Object.values(overview.state.workItems);
      const invitations=new Map();
      if(focus==='help_wanted')for(const item of items) {
        // Private work titles are already masked by the proven summary reader.
        // Do not expose its invitation scope to an unrelated viewer.
        if(item.title===null||!['accepted','working','blocked'].includes(item.state))continue;
        const full=readCurrentWorkItem(store.db,roomId,item.id,b);
        const help=workHelpContext({...overview.state,workItems:{[item.id]:full}},item.id,member.id,new Date(now).toISOString());
        if(help.canOffer)invitations.set(item.id,help);
      }
      const work=items.filter(item=>focus==='all'||focus==='results'&&currentResult(item)||focus==='help_wanted'&&invitations.has(item.id)
        ||focus==='needs_me'&&member.active!==false&&nextWorkStep(item,now,overview.state.room.ownerId).memberId===member.id
          &&nextWorkStep(item,now,overview.state.room.ownerId).needsAttention).map(item=>({
        id:item.id,title:item.title,state:item.state,revision:item.revision,mode:item.mode,
        next:nextWorkStep(item,now,overview.state.room.ownerId),
        nextRead:{tool:'room_read_work',arguments:{workItemId:item.id}},
        ...(focus==='help_wanted'?{help:invitations.get(item.id),offerEligibility:{status:'unavailable',reason:'current_offer_context_unavailable'}}:{}),
        ...(focus==='results'?(()=>{const current=readCurrentWorkItem(store.db,roomId,item.id);return {
          result:currentResult(current),nextResultRead:current.receipt.nativeText
            ?{tool:'room_read_result',arguments:{workItemId:item.id,completionEventId:current.receipt.eventId}}:null};})():{})
      }));
      const requests=saved.requestsDone?null:addressedRequestWindow(store,roomId,member.id,saved.requestAfter,limit,b);
      const floor=requests?store.historyFloor(roomId,member.id,head.sequence):null;
      const replyRequests=requests?.requests.filter(request=>request.recipientId===member.id&&request.status==='open'
        &&messageInHistory({id:request.id,createdAt:request.createdAt},floor)).map(request=>({
        id:request.id,requesterId:request.requesterId,workItemId:request.workItemId,revision:request.revision,
        nextRead:{tool:'room_read_request',arguments:{requestMessageId:request.id}}
      }))??[];
      const workDone=saved.workDone||overview.workWindow.nextAfter===null,requestsDone=saved.requestsDone||!requests.hasMore;
      const next={...saved,workAfter:saved.workDone?saved.workAfter:overview.workWindow.nextAfter??items.at(-1)?.id??saved.workAfter,
        requestAfter:requests?.examinedAfter??saved.requestAfter,workDone,requestsDone};
      const hasMore=!workDone||!requestsDone,nextCursor=hasMore?encode(next,store,secret):null;
      const evaluatedThrough=currentVisibleHorizon(store,roomId,member.id,head.sequence);
      return {contractVersion:1,roomId,viewerId:member.id,viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,
        viewerSessionBinding:auth.sessionBinding??null,viewerSessionRevision:auth.sessionRevision??null,
        evaluatedThrough,evaluatedAt:new Date(now).toISOString(),clockSource:'service',focus,
        member:{id:member.id,kind:member.kind,permissions:[...member.permissions]},charter:charterContext(overview.state.room),
        scope:{kind:"room",permissions:[...member.permissions],externalExecution:false},
        work,...(focus==='needs_me'?{replyRequests,replyRequestsEvaluatedThrough:evaluatedThrough}:{}),
        workScope:'bounded_source_window',selection:{order:'id',...(addressed?{source:'addressed-role-indexes',examinedWorkKeys:source?.examinedKeys??0}:{}),examinedWork:items.length,examinedRequests:requests?.requests.length??0,
          matches:null,guidance:'Follow every page, including empty filtered pages. Counts describe examined sources, not all matches. Read selected work or request before acting.'
          +(focus==='help_wanted'?' Explicit invitations only. Read selected work for scope and discussion. Offer queue eligibility is unavailable on this storage representation; this is not offer, assignment, claim or execution authority.':'')},
        page:{limit,totalWork:null,totalReplyRequests:null,hasMore,nextCursor,consistency:'restart_on_change',
          nextRead:hasMore?{tool:'room_list_work',arguments:{roomId,focus,...(args.limit===undefined?{}:{limit:args.limit}),cursor:nextCursor}}:null}};
    });
  });
}
