import{withCurrentRoomWriter}from'../server/current-room-repository.mjs';
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class CurrentAttachmentsRoom extends DurableObject{
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
    events.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'public',body:'Saved result'}}));
    events.push(event({roomId:'commons',actorId:'alice',type:'message.posted',data:{messageId:'private',toMemberId:'bob',body:'Private result'}}));
    this.store.initialize(events,{representation:'normalized-current-v1'});
    this.store.transaction(()=>withCurrentRoomWriter(this.db,'commons',()=>{const insert=this.db.prepare("INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id) VALUES('commons',?,'alice',?,'text/plain',1,?,? ,?,1,2,?)");
      for(let i=0;i<count;i++)insert.run('irrelevant-'+i,'retained metadata', 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',null,'expired','private');
      for(let i=0;i<18;i++)insert.run('selected-'+String(i).padStart(2,'0'),'result.txt','ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',new Uint8Array([97]),'committed','public');}));
    await this.ctx.storage.put('key',this.store.issueAccessKey('commons','reader'));
    return Response.json({count,cost:cost()});
   }
   if(url.pathname==='/read'){
    const key=await this.ctx.storage.get('key'),page=this.store.roomAttachments.list(key,'commons',{messageIds:['public'],cursor:url.searchParams.get('cursor')});return Response.json({page,cost:cost()});
   }
   if(url.pathname==='/private'){
    const key=await this.ctx.storage.get('key');const page=this.store.roomAttachments.get(key,'commons','irrelevant-0');return Response.json({page,cost:cost()});
   }
   if(url.pathname==='/explain')return Response.json({plan:this.db.prepare('EXPLAIN QUERY PLAN SELECT id,message_id FROM room_attachments INDEXED BY current_room_attachments_message WHERE room_id=? AND message_id IN (?) AND (message_id,id)>(?,?) ORDER BY message_id,id LIMIT 9').all('commons','public','',''),cost:cost()});
   return new Response('Not found',{status:404});
  }catch(error){return Response.json({error:{code:error.code??null,message:error.message},cost:cost()},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'small').fetch(request);}};
