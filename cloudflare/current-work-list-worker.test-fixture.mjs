import {DurableObject} from 'cloudflare:workers';
import {httpServerHandler} from 'cloudflare:node';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
const delta=(a,b)=>Object.fromEntries(Object.keys(b).map(k=>[k,a[k]-b[k]]));
export class CurrentWorkListProbe extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.stats={statements:0,rowsRead:0,rowsWritten:0,unknown:0};this.sqlErrors=[];this.raw={statements:0,rowsWritten:0,unknown:0};
  const native=ctx.storage.sql,exec=native.exec.bind(native),sql=new Proxy(native,{get:(target,key)=>{if(key==='exec')return(query,...args)=>{let cursor;try{cursor=exec(query,...args);}catch(error){this.sqlErrors.push({sql:query,message:error.message});throw error;}if(/^UPDATE room_writer_permit SET version=/.test(query)){this.raw.statements++;if(Number.isSafeInteger(cursor.rowsWritten))this.raw.rowsWritten+=cursor.rowsWritten;else this.raw.unknown++;}return cursor;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const storage=new Proxy(ctx.storage,{get:(target,key)=>{if(key==='sql')return sql;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  this.db=new DurableDatabase(storage,{observeStatement:()=>sample=>{this.stats.statements++;this.stats.rowsRead+=sample.rowsRead??0;this.stats.rowsWritten+=sample.rowsWritten??0;if(sample.rowsRead===null||sample.rowsWritten===null)this.stats.unknown++;}});this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});this.startup={...this.stats};
 }
 async fetch(request){const u=new URL(request.url),s=this.store,before={...this.stats},rawBefore={...this.raw};
  try{
   let result;
   if(u.pathname==='/seed'){
    const count=Number(u.searchParams.get('count'));if(![32,128].includes(count))throw Error('invalid count');const events=initialRoom();
    for(const id of ['worker','other'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:'agent',permissions:[]}}));
    for(let i=0;i<count;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'task-'+String(i).padStart(4,'0'),title:'Useful '+i,definitionOfDone:'NOT-HYDRATED-DEFINITION',accountableMemberId:i===count-1?(u.searchParams.has('help')?'owner':'worker'):'other'}}));
    if(u.searchParams.has('help')){const workItemId='task-'+String(count-1).padStart(4,'0');events.push(event({roomId:'commons',actorId:'owner',type:'work.accepted',data:{workItemId,expectedRevision:0}}),event({roomId:'commons',actorId:'owner',type:'work.help_updated',data:{workItemId,expectedRevision:1,expectedHelpRevision:0,status:'open',scope:'Suggest a useful improvement',expiresAt:new Date(Date.now()+60000).toISOString()}}));}
    for(let i=0;i<13;i++)events.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'request-'+String(i).padStart(2,'0'),toMemberId:i===12?'worker':'other',requestKind:'reply',requestPolicyVersion:1,body:'NOT-HYDRATED-REQUEST-BODY'}}));
    s.initialize(events,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','worker');await this.ctx.storage.put('key',key);result={count};
   }else if(u.pathname==='/list'){
    s.room=()=>{throw Error('Worker whole-room hydration');};s.snapshot=()=>{throw Error('Worker full work snapshot');};
    const params=new URLSearchParams(u.searchParams);params.delete('surface');params.delete('roomId');
    const headers=new Headers({host:'localhost',authorization:'Bearer '+await this.ctx.storage.get('key')});
    const server=this.http?null:createRoomServer({store:s,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No public assets in fixture');}});
    this.http??=httpServerHandler(server);
    const response=await this.http.fetch(new Request('http://localhost/api/rooms/commons/work-list?'+params,{headers}));
    result={status:response.status,page:await response.json()};
   }else throw Error('missing route');
   return Response.json({result,cost:delta(this.stats,before),rawRuntime:delta(this.raw,rawBefore),startup:this.startup});
  }catch(error){return Response.json({error:{message:error.message,stack:error.stack},cost:delta(this.stats,before),rawRuntime:delta(this.raw,rawBefore)},{status:500});}
 }
}
export default{fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'small').fetch(request);}};
