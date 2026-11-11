import {buildOrient} from '../server/orient.mjs';
import {buildActivationPack} from '../server/room-activation-pack.mjs';
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readConversation} from '../server/conversation-sync.mjs';
import {readCurrentHead} from '../server/current-room-repository.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../server/replay-cutover.mjs';
const delta=(a,b)=>Object.fromEntries(Object.keys(b).map(k=>[k,a[k]-b[k]]));
export class CanonicalMigrationProbe extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.stats={statements:0,rowsRead:0,rowsWritten:0,unknown:0};this.sqlErrors=[];this.raw={statements:0,rowsWritten:0,unknown:0};
  const native=ctx.storage.sql,exec=native.exec.bind(native),sql=new Proxy(native,{get:(target,key)=>{if(key==='exec')return(query,...args)=>{let cursor;try{cursor=exec(query,...args);}catch(error){this.sqlErrors.push({sql:query,message:error.message});throw error;}if(/^UPDATE room_writer_permit SET version=/.test(query)){this.raw.statements++;if(Number.isSafeInteger(cursor.rowsWritten))this.raw.rowsWritten+=cursor.rowsWritten;else this.raw.unknown++;}return cursor;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const storage=new Proxy(ctx.storage,{get:(target,key)=>{if(key==='sql')return sql;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  this.db=new DurableDatabase(storage,{observeStatement:()=>sample=>{this.stats.statements++;this.stats.rowsRead+=sample.rowsRead??0;this.stats.rowsWritten+=sample.rowsWritten??0;if(sample.rowsRead===null||sample.rowsWritten===null)this.stats.unknown++;}});this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});this.startup={...this.stats};
 }
 async fetch(request){const u=new URL(request.url),s=this.store,db=this.db,before={...this.stats},rawBefore={...this.raw};let result;
  const snapshot=()=>Object.fromEntries(['rooms','events','messages','operator_actions','message_replay_units','current_room_head','current_room_records'].map(table=>[table,db.prepare('SELECT count(*) n FROM '+table).get().n]));
  try{
   if(u.pathname==='/seed'){const count=Number(u.searchParams.get('count'));if(![32,128].includes(count))throw Error('invalid count');const events=initialRoom();for(let i=0;i<count;i++)events.push(event({id:'seed-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'root-'+String(i).padStart(4,'0'),body:'Existing message '+i}}));s.initialize(events);while(!s.backfillMessages({limit:200}).done){}s.checkMessagesParity({roomId:'commons'});const key=s.issueAccessKey('commons','owner');s.command(key,'commons',{id:'keep-root',type:'message.pinned',data:{messageId:'root-0000'}});while(!s.backfillMessages({limit:200}).done){}s.checkMessagesParity({roomId:'commons'});const archive=s.archiveMessages('commons',{keepNewest:2,dryRun:false});if(!archive.ok)throw Error('archive preparation failed '+JSON.stringify(archive));s.checkMessagesParity({roomId:'commons'});s.migrateMessageAuthority('commons');await s.verifyRoomIntegrity();await this.ctx.storage.put('key',key);db.exec(replayCutoverSchema({durable:true}));result={count};}
   else if(u.pathname==='/capture'){result=captureReplayWitness(s,{roomId:'commons',requestId:'capture',expectedHead:s.headSequence('commons'),reason:'Synthetic Worker migration qualification'});await this.ctx.storage.put('generation',result.generation);}
   else if(u.pathname==='/step'){
    const stage=u.searchParams.get('stage'),n=Number(u.searchParams.get('n')),position=Number(u.searchParams.get('position')),generation=await this.ctx.storage.get('generation'),input={roomId:'commons',generation,requestId:stage+'-'+n};
    const invoke=()=>stage==='hash'?advanceReplayWitness(s,{...input,expectedBytes:position}):stage==='codec'?partitionReplayWitness(s,{...input,expectedBytes:position}):stage==='work'?qualifyReplayHWork(s,{...input,expectedWorkCount:0}):stage==='messages'?qualifyReplayHMessages(s,{...input,expectedSteps:position}):advanceCurrentRoomConversion(s,{...input,expectedSteps:position});
    if(u.searchParams.has('fault')){const prior={counts:snapshot(),rooms:db.prepare('SELECT * FROM rooms').all(),heads:db.prepare('SELECT * FROM current_room_head').all(),units:db.prepare('SELECT domain,unit_key,payload_sha256 FROM message_replay_units ORDER BY room_id,generation,domain,unit_key').all()},prepare=db.prepare.bind(db);let fired=false;db.prepare=query=>new Proxy(prepare(query),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const value=fn.apply(target,args);if(!fired&&(u.searchParams.get('fault')==='publish'?/^INSERT INTO current_room_head/.test(query.trim()):/^INSERT INTO operator_actions/.test(query.trim()))){fired=true;throw Error('synthetic interrupted receipt save');}return value;};}});try{invoke();throw Error('fault not reached');}catch(error){result={fault:error.message,fired};}finally{db.prepare=prepare;}result.unchanged=JSON.stringify({counts:snapshot(),rooms:db.prepare('SELECT * FROM rooms').all(),heads:db.prepare('SELECT * FROM current_room_head').all(),units:db.prepare('SELECT domain,unit_key,payload_sha256 FROM message_replay_units ORDER BY room_id,generation,domain,unit_key').all()})===JSON.stringify(prior);}
    else result=invoke();
   }
   else if(u.pathname==='/post'){const id=u.searchParams.get('id'),key=await this.ctx.storage.get('key');result=s.command(key,'commons',{id:'post-'+id,type:'message.posted',data:{messageId:id,body:'Useful admitted '+id,replyToId:'root-0000'}});}
   else if(u.pathname==='/state'){result={head:readCurrentHead(db,'commons'),sourceHead:s.headSequence('commons'),projection:JSON.parse(db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection),permit:db.prepare('SELECT * FROM current_room_writer_permit').get(),counts:snapshot()};}
   else if(u.pathname==='/workflow') {
    const key=await this.ctx.storage.get('key');s.room=()=>{throw Error('actualWorker fullblob hydration');};
    for(let i=0;i<19;i++)s.command(key,'commons',{id:'work-'+i,type:'work.proposed',data:{workItemId:'task-'+String(i).padStart(2,'0'),title:'Useful '+i,definitionOfDone:'Saved evidence',accountableMemberId:'owner'}});
    result={context:s.roomContext(key,'commons'),orient:buildOrient(s,'commons','owner'),begin:buildActivationPack(s,'commons','owner')};
   }
   else if(u.pathname==='/context') {s.room=()=>{throw Error('actualWorker fullblob hydration');};result=s.roomContext(await this.ctx.storage.get('key'),'commons',{workAfter:u.searchParams.get('after')??''});}
   else if(u.pathname==='/read'){result=readConversation(s,await this.ctx.storage.get('key'),'commons',{messageId:u.searchParams.get('id'),limit:5});}
   else return new Response('missing',{status:404});
   return Response.json({result,cost:delta(this.stats,before),rawRuntime:delta(this.raw,rawBefore),sqlErrors:this.sqlErrors,startup:this.startup});
  }catch(error){return Response.json({error:{message:error.message,stack:error.stack,code:error.code??null},cost:delta(this.stats,before),rawRuntime:delta(this.raw,rawBefore),sqlErrors:this.sqlErrors,startup:this.startup},{status:500});}
 }
}
export default{fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'small').fetch(request);}};
