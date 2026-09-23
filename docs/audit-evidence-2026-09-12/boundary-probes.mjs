// Read-only source audit. Uses only in-memory synthetic data and loopback HTTP.
// Run: node /absolute/path/to/boundary-probes.mjs /absolute/path/to/frozen-source
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root=resolve(process.argv[2]??'.');
const imp=p=>import(pathToFileURL(join(root,p)).href);
const {RoomStore}=await imp('server/store.mjs');
const {createRoomServer}=await imp('server/http.mjs');
const {initialRoom}=await imp('server/bootstrap.mjs');
const {EVENT_TYPES:T}=await imp('src/events.js');
const {DiagnosticsLog}=await imp('server/diagnostics.mjs');
const results={runtime:process.version,sourceHashes:Object.fromEntries(['server/http.mjs','server/store.mjs','src/events.js','src/work-item-session.js'].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))};
let now=Date.parse('2026-09-12T18:00:00Z');
const s=new RoomStore(':memory:',{now:()=>now});
s.initialize(initialRoom());s.initialize(initialRoom('other'));
const owner=s.issueAccessKey('commons','owner');
const cmd=(key,type,data)=>s.command(key,'commons',{id:randomUUID(),type,data});
for(const [id,permissions] of [['worker',['accept_work','complete_work']],['steerer',['steer']],['revoked',[]]])cmd(owner,T.MEMBER_ADDED,{memberId:id,displayName:id,kind:'agent',permissions});
const worker=s.issueAccessKey('commons','worker'),steerer=s.issueAccessKey('commons','steerer');
const revoked=s.issueAccessKey('commons','revoked');s.revoke(revoked);
const roomSession=s.createSession(owner);
const account=s.authenticate(owner,'commons').account;
const slot=s.createAccountSessionSlot();const accountSession=s.loginAccountSession(slot.token,s.issueAccountAccessKey(account.id),0);
const identity=s.identities.create('Synthetic identity');s.identities.link(owner,'commons',{identityId:identity.identityId,permissions:['accept_work']});
cmd(owner,T.MESSAGE_POSTED,{messageId:'root',body:'Synthetic thread'});
const server=createRoomServer({store:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const request=async(path,{headers={},data,method=data===undefined?'GET':'POST'}={})=>{
 const res=await fetch(origin+path,{method,headers:{Origin:origin,...headers,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const body=await res.text();let json;try{json=JSON.parse(body);}catch{}
 return {status:res.status,code:json?.error?.code??null,json};
};
const bearer=token=>({Authorization:`Bearer ${token}`});
const oldWarn=console.warn;console.warn=()=>{};
try{
 const credentials={anonymous:{},malformed:bearer('invalid'),owner:bearer(owner),worker:bearer(worker),revoked:bearer(revoked),wrongRoom:bearer(s.issueAccessKey('other','owner')),identity:bearer(identity.secret),roomCookie:{Cookie:`room_session=${roomSession.token}`,'X-Session-Binding':roomSession.session.sessionBinding},accountCookie:{Cookie:`account_session=${slot.token}`,'X-Project-Room-Auth':'account','X-Session-Binding':accountSession.sessionBinding},accountAsBearer:bearer(slot.token)};
 const paths=['','events','cursor','return-brief','work-context?workItemId=missing','work-discussion?workItemId=missing','work-result?workItemId=missing','work-sessions','presence','capabilities','onboarding-funnel','export','charter','reply-requests','reply-context?requestMessageId=missing','reply-history','reminders','agent-connections','diagnostics','diagnostics-export','search?q=Synthetic','provider-heartbeats','identity-links','agent-invites','share-links','messages/root/thread'];
 results.routeMatrix=[];
 for(const route of paths){const row={route:route||'(snapshot)',credentials:{}};for(const [name,headers]of Object.entries(credentials)){const r=await request('/api/rooms/commons'+(route?'/'+route:''),{headers});row.credentials[name]={status:r.status,code:r.code};}results.routeMatrix.push(row);}
 const propose=id=>cmd(owner,T.WORK_PROPOSED,{workItemId:id,title:'Synthetic '+id,definitionOfDone:'Fixture',accountableMemberId:'worker',mode:'read'});
 const session=(key,id,revision,status,extra={})=>request('/api/rooms/commons/work-sessions',{headers:bearer(key),data:{requestId:randomUUID(),workItemId:id,expectedRevision:revision,action:'set_status',status,...extra}});
 const generic=(key,type,data)=>request('/api/rooms/commons/commands',{headers:bearer(key),data:{id:randomUUID(),type,data}});
 propose('one');propose('two');
 const start=await session(worker,'one',0,'processing',{budget:{maxConcurrent:1,maxRuntimeMs:1000,maxSpendCents:100}});
 const normalSecond=await session(worker,'two',0,'processing');
 const bypassSecond=await generic(worker,T.SESSION_STARTED,{workItemId:'two',expectedRevision:0});
 results.concurrency={first:start.status,sessionRoute:normalSecond.status,sessionCode:normalSecond.code,genericRoute:bypassSecond.status,secondStatus:s.room('commons').state.workItems.two.status};
 const claimed=await session(steerer,'one',1,'active');
 const stolen=await generic(steerer,T.SESSION_STATUS_CHANGED,{workItemId:'one',expectedRevision:1,status:'active'});
 results.workerOwnership={sessionRoute:claimed.status,sessionCode:claimed.code,genericRoute:stolen.status,worker:s.room('commons').state.workItems.one.worker_member_id};
 now+=2000;
 const over=await generic(steerer,T.SESSION_STATUS_CHANGED,{workItemId:'one',expectedRevision:2,status:'processing',spendCents:150});
 results.expiredBudget={genericStatus:over.status,state:s.room('commons').state.workItems.one.status,reportedSpend:s.room('commons').state.workItems.one.spend_cents};
 const fabricated=await generic(worker,T.SESSION_STOPPED,{workItemId:'two',expectedRevision:1,status:'failed',budgetEnforced:true,reason:'budget_exceeded',limit:'maxSpendCents'});
 results.claimedEnforcement={status:fabricated.status,acceptedMarker:fabricated.json?.event?.data?.budgetEnforced,budget:s.room('commons').state.workItems.two.budget};
 let captured=[];const original=DiagnosticsLog.prototype.record;
 DiagnosticsLog.prototype.record=function(entry){captured.push(entry);return original.call(this,entry);};
 try{await request('/api/rooms/commons/messages/private-customer-project/thread',{headers:bearer(worker)});}finally{DiagnosticsLog.prototype.record=original;}
 results.diagnosticPath=captured.map(x=>({route:x.route,status:x.status}));
 const allPaths=s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name);
 results.storageTables=allPaths;
}finally{console.warn=oldWarn;server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();}
console.log(JSON.stringify(results,null,2));
