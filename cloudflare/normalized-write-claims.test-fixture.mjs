// Synthetic local routes only. The constructor/HTTP command path is production.
import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
export class WriteClaimsRoom extends ProjectRoom {
 async fetch(request){
  const url=new URL(request.url),s=this.store;
  if(url.pathname==='/__seed'){
   const count=Number(url.searchParams.get('expired')??0),active=Number(url.searchParams.get('active')??0);if(![0,100].includes(count)||![0,40].includes(active))throw Error('invalid fixture size');
   const now=Date.now(),at=new Date(now-86400000).toISOString(),es=initialRoom('claims');
   for(let i=0;i<count;i++){const workItemId='old-'+i;es.push(event({roomId:'claims',actorId:'owner',type:'work.proposed',at,data:{workItemId,title:workItemId,definitionOfDone:'Saved',accountableMemberId:'owner',mode:'write'}}),event({roomId:'claims',actorId:'owner',type:'work.accepted',at,data:{workItemId,expectedRevision:0}}),event({roomId:'claims',actorId:'owner',type:'claim.acquired',at,data:{workItemId,expectedRevision:1,repository:'acme/test',ref:'main',paths:['src/**'],expiresAt:new Date(now-86300000).toISOString()}}));}
   for(let i=0;i<active;i++){const workItemId='live-'+i;es.push(event({roomId:'claims',actorId:'owner',type:'work.proposed',at,data:{workItemId,title:workItemId,definitionOfDone:'Saved',accountableMemberId:'owner',mode:'write'}}),event({roomId:'claims',actorId:'owner',type:'work.accepted',at,data:{workItemId,expectedRevision:0}}),event({roomId:'claims',actorId:'owner',type:'claim.acquired',at,data:{workItemId,expectedRevision:1,repository:'acme/test',ref:'main',paths:['old-file-'+i],expiresAt:new Date(now+60000).toISOString()}}));}
   s.initialize(es,{representation:'normalized-current-v1'});s.workClaims.configure('claims',{maxMemberOpenClaims:100,maxOpenClaims:500});const key=s.issueAccessKey('claims','owner');await this.ctx.storage.put('claim-fixture',{key,now});
   return Response.json({key,now,count,active});
  }
  const f=await this.ctx.storage.get('claim-fixture');if(f)s.now=()=>f.now;
  if(url.pathname==='/__verify'){auditRecovery(s);return Response.json({head:s.headSequence('claims'),permit:s.db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled});}
  const originalInfo=console.info,cost=[];console.info=(value,...rest)=>{try{const parsed=typeof value==='string'?JSON.parse(value):null;if(parsed?.event==='room.sql_cost'){cost.push(parsed);return;}}catch{}originalInfo(value,...rest);};
  const originalPrepare=s.db.prepare.bind(s.db),sourceCost={calls:0,rowsRead:0,returnedRows:0};let fired=false;
  s.db.prepare=sql=>{const st=originalPrepare(sql);if(!sql.includes('INDEXED BY current_native_claim_expiry'))return st;return new Proxy(st,{get(target,k){const fn=Reflect.get(target,k,target);if(k!=='all')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const before=s.db.rowsRead;const rows=fn.apply(target,args);sourceCost.calls++;sourceCost.rowsRead+=s.db.rowsRead-before;sourceCost.returnedRows+=rows.length;return rows;};}});};
  if(request.headers.get('x-claim-fault')==='1')s.db.prepare=sql=>new Proxy(originalPrepare(sql),{get(target,k){const fn=Reflect.get(target,k,target);if(k!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const value=fn.apply(target,args);if(/^INSERT INTO current_room_head/.test(sql.trim())){fired=true;throw Error('Native claim save interrupted');}return value;};}});
  try{const response=await this.sqlCosts.run('request','work-claims',()=>super.fetch(request));const headers=new Headers(response.headers);headers.set('x-claim-cost',JSON.stringify(cost));headers.set('x-claim-source',JSON.stringify(sourceCost));headers.set('x-claim-fault-fired',String(fired));return new Response(response.body,{status:response.status,headers});}
  finally{console.info=originalInfo;s.db.prepare=originalPrepare;}
 }
}
export default{fetch(request,env){const h=new Headers(request.headers),url=new URL(request.url),surface=url.searchParams.get('surface');url.searchParams.delete('surface');h.set('Host','room.example');h.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(['large','live'].includes(surface)?surface:'small').fetch(new Request(url,new Request(request,{headers:h})));}};
