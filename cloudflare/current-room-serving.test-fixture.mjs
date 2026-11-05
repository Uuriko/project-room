// Causal synthetic rooms only; the production Store.command/read endpoint.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { readConversation } from '../server/conversation-sync.mjs';
import { readCurrentHead } from '../server/current-room-repository.mjs';
import { sqliteValueLimit } from '../server/storage-limits.mjs';

export class CurrentServingRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.ctx=ctx;this.stats={statements:0,rowsRead:0,rowsWritten:0,unknown:0};
    this.db=new DurableDatabase(ctx.storage,{observeStatement:()=>sample=>{
      this.stats.statements++;this.stats.rowsRead+=sample.rowsRead??0;this.stats.rowsWritten+=sample.rowsWritten??0;
      if(sample.rowsRead===null||sample.rowsWritten===null)this.stats.unknown++;
    }});
    this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});
  }
  async fetch(request){
    const url=new URL(request.url),before={...this.stats};
    const cost=()=>Object.fromEntries(Object.keys(before).map(key=>[key,this.stats[key]-before[key]]));
    try{
      if(url.pathname==='/seed'){
        const count=Number(url.searchParams.get('count'));if(![0,1000,5000].includes(count))throw Error('invalid synthetic count');
        const events=[...initialRoom(),event({id:'limit-history',roomId:'commons',actorId:'owner',type:'room.history_visibility_set',data:{historyVisibility:'since_join'}})];
        for(let i=0;i<count;i++)events.push(event({id:'old-event-'+i,roomId:'commons',actorId:'owner',type:'message.posted',at:'2026-01-01T00:00:00Z',data:{messageId:'old-'+i,body:'Synthetic before join'}}));
        events.push(event({id:'reader-joined',roomId:'commons',actorId:'owner',type:'member.added',at:'2026-02-01T00:00:00Z',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}}));
        this.store.initialize(events,{representation:'normalized-current-v1'});
        await this.ctx.storage.put('owner-key',this.store.issueAccessKey('commons','owner'));
        await this.ctx.storage.put('reader-key',this.store.issueAccessKey('commons','reader'));
        return Response.json({count,head:readCurrentHead(this.db,'commons'),runtime:sqliteValueLimit(this.db),cost:cost()});
      }
      if(url.pathname==='/post'){
        const id=url.searchParams.get('id');if(!/^[a-z0-9-]{1,40}$/.test(id))throw Error('invalid synthetic post');
        const key=await this.ctx.storage.get('owner-key');
        const result=this.store.command(key,'commons',{id:'command-'+id,type:'message.posted',data:{messageId:id,body:'A useful saved message',...(url.searchParams.has('reply')?{replyToId:url.searchParams.get('reply')}:{})}});
        return Response.json({result,cost:cost()});
      }
      if(url.pathname==='/read'){
        const trace=[],prepare=this.db.prepare.bind(this.db);
        if(url.searchParams.has('trace'))this.db.prepare=sql=>new Proxy(prepare(sql),{get:(target,key)=>{
          const fn=Reflect.get(target,key,target);if(!['get','all','run'].includes(key))return typeof fn==='function'?fn.bind(target):fn;
          return(...args)=>{const start={...this.stats};try{return fn.apply(target,args);}finally{trace.push({sql,cost:Object.fromEntries(Object.keys(start).map(k=>[k,this.stats[k]-start[k]]))});}};
        }});
        const key=await this.ctx.storage.get(url.searchParams.get('as')==='reader'?'reader-key':'owner-key');
        try{
          const result=readConversation(this.store,key,'commons',{limit:5,...(url.searchParams.has('message')?{messageId:url.searchParams.get('message')}:{})});
          return Response.json({result,cost:cost(),...(trace.length?{trace}: {})});
        }catch(error){return Response.json({error:{status:error.status??500,message:error.message},cost:cost(),...(trace.length?{trace}: {})});}
        finally{this.db.prepare=prepare;}
      }
      if(url.pathname==='/head-fault'){
        this.db.exec('DROP TRIGGER current_room_guard_current_room_head_delete');
        this.db.exec("DELETE FROM current_room_head WHERE room_id='commons'");
        return Response.json({fault:true,cost:cost()});
      }
      if(url.pathname==='/state')return Response.json({head:readCurrentHead(this.db,'commons'),
        permit:this.db.prepare('SELECT * FROM current_room_writer_permit').get(),
        projection:this.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection,cost:cost()});
      return new Response('Not found',{status:404});
    }catch(error){return Response.json({error:{status:error.status??500,message:error.message},cost:cost()},{status:error.status??500});}
  }
}
export default {fetch(request,env){const surface=new URL(request.url).searchParams.get('surface')??'current';
  if(!/^(?:current|small|large|head-fault)$/.test(surface))return new Response('invalid synthetic surface',{status:400});
  return env.ROOM.getByName(surface).fetch(request);}};
