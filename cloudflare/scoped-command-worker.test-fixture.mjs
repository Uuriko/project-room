import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event,PERMISSIONS} from '../src/events.js';
export class ScopedCommandRoom extends DurableObject{
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
  const url=new URL(request.url),before={...this.stats},rawBefore={...this.raw},cost=()=>({...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),rawRuntime:Object.fromEntries(Object.keys(rawBefore).map(k=>[k,this.raw[k]-rawBefore[k]]))});
  try{
   if(url.pathname==='/seed'){
    const count=Number(url.searchParams.get('count'));if(![2,100].includes(count))throw Error('invalid count');
    const events=initialRoom();if(url.searchParams.has('maxmeta')){events[0].data.title='界'.repeat(4096);events[0].data.purpose='界'.repeat(4096);}for(let i=1;i<count;i++){
     const memberId='member-'+String(i).padStart(3,'0');events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[...PERMISSIONS]}}));
     if(i>2)events.push(event({roomId:'commons',actorId:memberId,type:'capabilities.advertised',data:{capabilities:Array.from({length:30},(_,j)=>String(j).padStart(2,'0')+'x'.repeat(78))}}));
    }
    if(url.searchParams.has('maxmeta'))events.push(event({roomId:'commons',actorId:'owner',type:'room.charter_updated',data:{expectedRevision:0,purpose:'界'.repeat(1000),outputs:'界'.repeat(1000),boundaries:'界'.repeat(1000),escalation:'界'.repeat(1000)}}));
    events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'selected-work',title:'Useful selected task',definitionOfDone:'Save exact useful result',accountableMemberId:'member-001'}}));
    this.store.initialize(events,{representation:'normalized-current-v1'});await this.ctx.storage.put('key',this.store.issueAccessKey('commons','owner'));await this.ctx.storage.put('agent',this.store.issueAccessKey('commons','member-001'));return Response.json({count});
   }
   this.store.room=()=>{throw Error('unbounded room hydration');};const key=await this.ctx.storage.get('key');
   const id=url.searchParams.get('id')??'first';
   const command=url.pathname==='/post'?{id,type:'message.posted',data:{messageId:id,body:'Useful ordinary message'}}:
    url.pathname==='/propose'?{id,type:'work.proposed',data:{workItemId:id,title:'Useful task',definitionOfDone:'A saved result',accountableMemberId:'member-001'}}:
    {id,type:'work.accepted',data:{workItemId:url.searchParams.get('work')??'first',expectedRevision:0}};
   const callerKey = url.pathname === '/accept' ? await this.ctx.storage.get('agent') : key;
   const result=this.store.command(callerKey,'commons',command);
   return Response.json({result,cost:cost()});
  }catch(error){return Response.json({error:{code:error.code,message:error.message,stack:error.stack},cost:cost()},{status:500});}
 }
}
export default{fetch(request,env){const name=new URL(request.url).searchParams.get('surface')??'small';if(!['small','large','maxmeta'].includes(name))return new Response('invalid surface',{status:400});return env.ROOM.getByName(name).fetch(request);}};
