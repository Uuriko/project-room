import {httpServerHandler} from 'cloudflare:node';
import {createRoomServer} from '../server/http.mjs';
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class CurrentEventsRoom extends DurableObject{
 constructor(ctx,env){
  super(ctx,env);this.ctx=ctx;this.stats={statements:0,rowsRead:0,rowsWritten:0,unknown:0,returnedSqlTextBytes:0,eventPayloadBytes:0};
  this.raw={statements:0,rowsWritten:0,unknown:0};
  const native=ctx.storage.sql,exec=native.exec.bind(native),sql=new Proxy(native,{get:(target,key)=>{if(key==='exec')return(query,...args)=>{const cursor=exec(query,...args);if(/^UPDATE room_writer_permit SET version=/.test(query)){this.raw.statements++;if(Number.isSafeInteger(cursor.rowsWritten))this.raw.rowsWritten+=cursor.rowsWritten;else this.raw.unknown++;}return cursor;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const storage=new Proxy(ctx.storage,{get:(target,key)=>{if(key==='sql')return sql;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  this.db=new DurableDatabase(storage,{observeStatement:()=>sample=>{this.stats.statements++;for(const k of ['rowsRead','rowsWritten'])this.stats[k]+=sample[k]??0;if(sample.rowsRead===null||sample.rowsWritten===null)this.stats.unknown++;}});
  const prepare=this.db.prepare.bind(this.db);
  this.db.prepare=sql=>new Proxy(prepare(sql),{get:(target,key)=>{
   const fn=Reflect.get(target,key,target);if(typeof fn!=='function')return fn;
   if(!['get','all'].includes(key))return fn.bind(target);
   return(...args)=>{const value=fn.apply(target,args),rows=key==='all'?value:[value];for(const row of rows??[])for(const v of Object.values(row??{}))if(typeof v==='string'){this.stats.returnedSqlTextBytes+=Buffer.byteLength(v);if(sql.startsWith('SELECT id,body FROM events'))this.stats.eventPayloadBytes+=Buffer.byteLength(v);}return value;};
  }});
  this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});this.startup={...this.stats};
 }
 async fetch(request){
  const url=new URL(request.url),before={...this.stats},rawBefore={...this.raw};const cost=()=>({...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),rawRuntime:Object.fromEntries(Object.keys(rawBefore).map(k=>[k,this.raw[k]-rawBefore[k]])),startup:this.startup});
  try{
   if(url.pathname==='/seed'){
    const count=Number(url.searchParams.get('count'));if(![1000,5000].includes(count))throw Error('invalid count');
    const events=initialRoom();
    for(const memberId of ['alice','bob','reader'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[]}}));
    for(let i=0;i<count;i++)events.push(event({id:'private-event-'+i,roomId:'commons',actorId:'alice',type:'message.posted',data:{messageId:'private-'+i,toMemberId:'bob',body:'PRIVATE '+i}}));
    events.push(event({id:'public-event',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'public',body:'Original'}}));
    events.push(event({id:'edited-public',roomId:'commons',actorId:'owner',type:'message.edited',data:{messageId:'public',body:'Saved current',expectedMessageRevision:0}}));
    this.store.initialize(events,{representation:'normalized-current-v1'});
    await this.ctx.storage.put('key',this.store.issueAccessKey('commons','reader'));
    return Response.json({count,cost:cost()});
   }
   if(url.pathname==='/read'){
    const key=await this.ctx.storage.get('key'),after=Number(url.searchParams.get('after')??0);
    const opts=url.searchParams.has('filter')?{types:['message.deleted']}:{},page=this.store.eventsAfter(key,'commons',after,100,opts);
    return Response.json({page,cost:cost()});
   }
   if(url.pathname==='/http'){
    const key=await this.ctx.storage.get('key');
    const server=this.http?null:createRoomServer({store:this.store,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No fixture assets');}});
    this.http??=httpServerHandler(server);
    const response=await this.http.fetch(new Request('http://localhost/api/rooms/commons/events?after='+url.searchParams.get('after'),{headers:{host:'localhost',authorization:'Bearer '+key}}));
    return Response.json({status:response.status,page:await response.json(),cost:cost()});
   }
   if(url.pathname==='/explain')return Response.json({plan:this.db.prepare('EXPLAIN QUERY PLAN SELECT sequence,length(CAST(id AS BLOB)),length(CAST(body AS BLOB)) FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all('commons',5,999999,16),cost:cost()});
   return new Response('Not found',{status:404});
  }catch(error){return Response.json({error:{code:error.code??null,message:error.message},cost:cost()},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'small').fetch(request);}};
