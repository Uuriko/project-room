import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
import {operatorNormalization} from '../server/operator-normalization.mjs';import {readCurrentMessage} from '../server/current-room-repository.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
export class ChannelCopyAdoptionRoom extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});}
 async fetch(request){const path=new URL(request.url).pathname,s=this.store,db=this.db;try{
  if(path==='/seed'){
   const events=initialRoom(),append=(id,type,data)=>events.push(event({id,roomId:'commons',actorId:'owner',type,data}));
   for(const memberId of ['alice','bystander'])append('join-'+memberId,'member.added',{memberId,displayName:memberId,kind:'human',permissions:[]});
   append('root','message.posted',{messageId:'root',body:'Public root'});append('reply','message.posted',{messageId:'reply',replyToId:'root',alsoSendToChannel:true,body:'Useful public copied result'});
   append('private','message.posted',{messageId:'private',toMemberId:'alice',body:'Synthetic private text'});
   s.initialize(events);await this.ctx.storage.put('owner',s.issueAccessKey('commons','owner'));await this.ctx.storage.put('bystander',s.issueAccessKey('commons','bystander'));
   const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});return Response.json({plan,parentSequence:events.findIndex(e=>e.id==='reply')+1});
  }
  if(path==='/execute'||path==='/fault'){
   const input=await request.json(),prepare=db.prepare.bind(db);let faulted=false;
   if(path==='/fault')db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('INSERT INTO current_room_record_proofs VALUES'))return statement;return new Proxy(statement,{get(target,key){if(key==='run')return(...args)=>{target.run(...args);faulted=true;throw Error('synthetic proof save interruption');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
   try{return Response.json({result:operatorNormalization(s,input,true)});}catch(error){return Response.json({message:error.message,faulted,heads:prepare('SELECT count(*) n FROM current_room_head').get().n,messages:prepare('SELECT count(*) n FROM messages').get().n},{status:500});}finally{db.prepare=prepare;}
  }
  if(path==='/read'){
   const copy=s.readTransaction(()=>readCurrentMessage(db,'commons','reply:channel'));
   let privateStatus=200;try{readConversation(s,await this.ctx.storage.get('bystander'),'commons',{messageId:'private',limit:1});}catch(error){privateStatus=error.status;}
   return Response.json({sequence:copy.row.seq,message:copy.value,privateStatus,projectionBytes:db.prepare("SELECT octet_length(projection) n FROM rooms WHERE id='commons'").get().n});
  }
  if(path==='/post'){const command={id:'native-next',type:'message.posted',data:{messageId:'native-next',body:'Useful next result'}},key=await this.ctx.storage.get('owner');return Response.json({first:s.command(key,'commons',command),retry:s.command(key,'commons',command)});}
  return new Response('Not found',{status:404});
 }catch(error){return Response.json({error:error.message,code:error.code},{status:error.status??500});}}
}
export default {fetch(request,env){return env.ROOM.getByName('copy-adoption').fetch(request);}};
