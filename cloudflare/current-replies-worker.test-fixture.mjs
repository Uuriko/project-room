import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class CurrentRepliesRoom extends DurableObject{
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
  const url=new URL(request.url),before={...this.stats},rawBefore={...this.raw};
  const cost=()=>({...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),rawRuntime:Object.fromEntries(Object.keys(rawBefore).map(k=>[k,this.raw[k]-rawBefore[k]]))});
  try{
   if(url.pathname==='/seed'){
    const count=Number(url.searchParams.get('count'));if(![1000,5000].includes(count))throw Error('invalid synthetic count');
    const events=initialRoom(),add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
    for(const memberId of ['reader','other'])add('member.added',{memberId,displayName:memberId,kind:'agent',permissions:[]});
    for(let i=0;i<count;i++)add('message.posted',{messageId:'old-private-'+String(i).padStart(6,'0'),toMemberId:'other',body:'PRIVATE background '+i});
    for(let i=0;i<499;i++)add('message.posted',{messageId:'a-hidden-'+String(i).padStart(6,'0'),toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'PRIVATE obligation '+i});
    add('message.posted',{messageId:'zz-question',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Save useful work'});
    for(let i=0;i<12;i++)add('message.posted',{messageId:'context-'+i,replyToId:'zz-question',toMemberId:'reader',body:'Relevant clarification '+i});
    this.store.initialize(events,{representation:'normalized-current-v1'});await this.ctx.storage.put('key',this.store.issueAccessKey('commons','reader'));return Response.json({seeded:count});
   }
   this.store.room=()=>{throw Error('legacy room hydration');};
   const key=await this.ctx.storage.get('key'),mode=url.pathname==='/list'?'list':url.pathname==='/history'?'history':'selected';
   const result=mode==='list'?this.store.replyRequests.list(key,'commons',{limit:2}):mode==='history'?this.store.replyRequests.history(key,'commons',{limit:2}):this.store.replyRequests.selected(key,'commons','zz-question',{limit:2});
   const measured=cost();
   const plans={list:this.db.prepare("EXPLAIN QUERY PLAN SELECT record_key FROM current_room_record_proofs INDEXED BY current_reply_request_keys WHERE room_id=? AND domain='replyRequests' AND present=1 AND record_key>? ORDER BY record_key LIMIT ?").all('commons','',3),selected:this.db.prepare('EXPLAIN QUERY PLAN SELECT message_id,seq FROM messages INDEXED BY messages_room_thread_seq WHERE room_id=? AND thread_root_id=? AND (seq,message_id)>(?,?) AND seq<=? ORDER BY seq,message_id LIMIT ?').all('commons','zz-question',0,'',Number.MAX_SAFE_INTEGER,3),history:this.db.prepare('EXPLAIN QUERY PLAN SELECT sequence FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all('commons',0,Number.MAX_SAFE_INTEGER,2)};
   return Response.json({result,cost:measured,plans});
  }catch(error){return Response.json({error:{code:error.code,message:error.message,stack:error.stack}},{status:500});}
 }
}
export default{fetch(request,env){const surface=new URL(request.url).searchParams.get('surface')??'small';if(!['small','large'].includes(surface))return new Response('invalid surface',{status:400});return env.ROOM.getByName(surface).fetch(request);}};
