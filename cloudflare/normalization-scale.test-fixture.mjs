// Disposable synthetic scale qualification, no production entrypoint.
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readConversation} from '../server/conversation-sync.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';
import {invokeFromPlainPost,invalidateEditedAssistantInput,roomAssistantSchema} from '../server/room-assistant.mjs';
export class NormalizationScaleRoom extends DurableObject {
 constructor(ctx,env){
  super(ctx,env);this.ctx=ctx;this.active=null;this.pending=null;
  const encodedBytes=value=>value==null?0:typeof value==='string'?new TextEncoder().encode(value).byteLength:value instanceof ArrayBuffer?value.byteLength:ArrayBuffer.isView(value)?value.byteLength:new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const exec=ctx.storage.sql.exec.bind(ctx.storage.sql),finish=()=>{const p=this.pending;if(!p)return;this.pending=null;const g=p.group;try{g.rowsRead+=p.cursor.rowsRead;g.rowsWritten+=p.cursor.rowsWritten;}catch{g.unknown++;}};this.finish=finish;
  ctx.storage.sql.exec=(sql,...params)=>{finish();const cursor=exec(sql,...params);if(!this.active)return cursor;const key=sql.replace(/\s+/g,' ').trim(),g=this.active.get(key)??{sql:key,statements:0,rowsRead:0,rowsWritten:0,materializedBytes:0,sqlTextBytes:0,boundParameterBytes:0,carrierWriteBytes:0,maxProjectionReadBytes:0,unknown:0};this.active.set(key,g);g.statements++;g.sqlTextBytes+=encodedBytes(sql);g.boundParameterBytes+=params.reduce((n,p)=>n+encodedBytes(p),0);if(/^UPDATE rooms SET sequence=\?,projection=\?/.test(key))g.carrierWriteBytes+=encodedBytes(params[1]);this.pending={cursor,group:g};const charge=row=>{g.materializedBytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;if(Object.hasOwn(row,'projection'))g.maxProjectionReadBytes=Math.max(g.maxProjectionReadBytes,encodedBytes(row.projection));};return new Proxy(cursor,{get(target,k){if(k==='toArray')return()=>{const rows=target.toArray();for(const row of rows)charge(row);return rows;};if(k===Symbol.iterator)return function*(){for(const row of target){charge(row);yield row;}};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});};
  this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});
 }
 async fetch(request){
  const url=new URL(request.url);this.active=new Map();const started=performance.now();let phase=url.pathname;
  const cost=()=>{this.finish();const groups=[...this.active.values()];return {maxProjectionReadBytes:Math.max(0,...groups.map(g=>g.maxProjectionReadBytes)),observedWorkerWallMs:performance.now()-started,...Object.fromEntries(['statements','rowsRead','rowsWritten','materializedBytes','sqlTextBytes','boundParameterBytes','carrierWriteBytes','unknown'].map(k=>[k,groups.reduce((n,g)=>n+g[k],0)])),top:groups.sort((a,b)=>b.rowsRead-a.rowsRead).slice(0,8)};};
  try{
   let result;
   if(url.pathname==='/assistant-schema-control'){
    const controls=[];for(const table of ['room_assistant_config','room_assistant_runs']){
      const query=()=>table==='room_assistant_config'?invokeFromPlainPost({db:this.db},'probe',{}, {},{},'probe'):invalidateEditedAssistantInput(this.db,'probe','probe',1);
      this.ctx.storage.sql.exec('DROP TABLE '+table);let missing;try{this.db.prepare('SELECT * FROM '+table).all();}catch(error){missing=error.message;}if(!missing)throw Error('Expected native missing-table error');query();
      this.ctx.storage.sql.exec(table==='room_assistant_config'?'CREATE TABLE room_assistant_config(room_id TEXT PRIMARY KEY,value TEXT NOT NULL)':'CREATE TABLE room_assistant_runs(room_id TEXT NOT NULL,run_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(room_id,run_id))');query();
      const held=this.db.prepare('SELECT value FROM '+table+' WHERE room_id=?');this.ctx.storage.sql.exec('DROP TABLE '+table);this.ctx.storage.sql.exec('CREATE TABLE '+table+'(room_id TEXT,wrong TEXT)');let refused=false,heldRefused=false;try{query();}catch(error){refused=error.message.includes('no such column');}try{held.get('probe');}catch(error){heldRefused=error.message.includes('no such column');}if(!refused||!heldRefused)throw Error('Changed assistant schema was accepted');
      this.ctx.storage.sql.exec('DROP TABLE '+table);for(const sql of roomAssistantSchema.split(';').map(s=>s.trim()).filter(Boolean))this.ctx.storage.sql.exec(sql);controls.push({table,missing,created:true,corruptRefused:refused,heldRefused});
    }result={controls};
   }else if(url.pathname==='/seed'){
    const events=initialRoom(),members=url.searchParams.get('roster')==='64'?64:1;
    if(members===64){events.push(event({id:'history-floor-policy',idempotencyKey:'history-floor-policy',roomId:'commons',actorId:'owner',type:'room.history_visibility_set',at:'2026-01-01T00:00:00.000Z',data:{historyVisibility:'since_join'}}));for(let i=1;i<members;i++)events.push(event({id:'member-'+i,idempotencyKey:'member-key-'+i,roomId:'commons',actorId:'owner',type:'member.added',at:'2026-02-01T00:00:00.000Z',data:{memberId:'reader-'+i,displayName:'Synthetic agent '+i,kind:'agent',permissions:[]}}));}
    const small=url.searchParams.get('surface')==='small',compact=url.searchParams.get('fixture')==='compact',posts=small?100:5000,total=small?1000:50000,bodyBytes=compact?64:1250;
    for(let i=0;i<posts;i++)events.push(event({id:'post-'+i,idempotencyKey:'post-key-'+i,roomId:'commons',actorId:'owner',type:'message.posted',at:'2026-01-01T00:00:00.000Z',data:{messageId:'m'+i,body:i===0?'Small edit target':'S'.repeat(bodyBytes)}}));
    const editStart=events.length;for(let i=editStart;i<total;i++)events.push(event({id:'edit-'+i,idempotencyKey:'edit-key-'+i,roomId:'commons',actorId:'owner',type:'message.edited',at:'2026-01-02T00:00:00.000Z',data:{messageId:'m0',body:'Small edit '+i,expectedMessageRevision:i-editStart}}));
    phase='legacy initialize '+total+' events';console.log('NORMALIZATION_PHASE '+phase);this.store.initialize(events);
    phase='issue owner key';await this.ctx.storage.put('key',this.store.issueAccessKey('commons','owner'));
    if(members===64)await this.ctx.storage.put('reader-key',this.store.issueAccessKey('commons','reader-1'));
    result={events:total,members,posts,editedEvents:total-editStart,...(compact?{fixture:'compact',bodyBytes}:{}),...this.db.prepare("SELECT sequence,octet_length(projection) projectionBytes FROM rooms WHERE id='commons'").get(),eventCount:this.db.prepare('SELECT count(*) n FROM events').get().n};
   }else if(url.pathname==='/plan')result=operatorNormalization(this.store,{roomId:'commons',discardLegacyAssignments:true});
   else if(url.pathname==='/execute'){const input=await request.json();result=operatorNormalization(this.store,input,true);}
   else if(url.pathname==='/post'){const key=await this.ctx.storage.get('key'),id=url.searchParams.get('id');result=this.store.command(key,'commons',{id:'after-'+id,type:'message.posted',data:{messageId:'after-'+id,body:'Useful normalized result'}});}
   else if(url.pathname==='/edit'){const key=await this.ctx.storage.get('key'),second=url.searchParams.get('id')==='two';result=this.store.command(key,'commons',{id:'edit-after-one-'+(second?'two':'one'),type:'message.edited',data:{messageId:'after-one',body:second?'Updated useful normalized result':'First useful edit',expectedMessageRevision:second?1:0}});}
   else if(url.pathname==='/presence')result=this.store.presence(await this.ctx.storage.get('key'),'commons',[]);
   else if(url.pathname==='/privacy-read'){try{readConversation(this.store,await this.ctx.storage.get('reader-key'),'commons',{messageId:'m1',limit:1});throw Error('Pre-join body exposed');}catch(error){if(error.status!==404)throw error;result={hidden:true,status:404};}}
   else if(url.pathname==='/read')result=readConversation(this.store,await this.ctx.storage.get('key'),'commons',{messageId:'after-one',limit:1});
   else if(url.pathname==='/state')result={...this.db.prepare("SELECT sequence,octet_length(projection) projectionBytes FROM rooms WHERE id='commons'").get(),messages:this.db.prepare('SELECT count(*) n FROM messages').get().n,events:this.db.prepare('SELECT count(*) n FROM events').get().n,eventBodyBytes:this.db.prepare('SELECT sum(octet_length(body)) n FROM events').get().n,messageBodyBytes:this.db.prepare('SELECT sum(coalesce(octet_length(body),0)) n FROM messages').get().n,sqliteDatabaseBytes:this.ctx.storage.sql.databaseSize};
   else return new Response('not found',{status:404});
   return Response.json({result,cost:cost()});
  }catch(error){return Response.json({phase,error:{name:error.name,code:error.code,message:error.message},cost:cost()},{status:500});}
  finally{this.finish();this.active=null;}
 }
}
export default {fetch(request,env){return env.ROOM.getByName(['small','optional'].includes(new URL(request.url).searchParams.get('surface'))?new URL(request.url).searchParams.get('surface'):'scale').fetch(request);}};
