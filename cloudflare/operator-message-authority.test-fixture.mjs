// Local qualification only. This provisioning fixture is never deployed.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorMessageAuthority } from '../server/operator-message-authority.mjs';
import { DurableDatabase,durableStorage } from './storage.mjs';
export class OperatorAuthorityRoom extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});}
 async fetch(request){
  const s=this.store,url=new URL(request.url),path=url.pathname;
  try {
   if(path==='/seed'){
    s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');
    s.roomFlood={consume(){}};
    const count=Number(url.searchParams.get('count')??3),padding=Number(url.searchParams.get('padding')??0);
    for(let i=0;i<count;i++)s.command(key,'commons',{id:'seed-'+i,type:'message.posted',data:{messageId:'m'+i,body:('Body '+i).padEnd(padding,'x')}});
    while(!s.backfillMessages({limit:100}).done){}
    return Response.json({seeded:true});
   }
   if(path==='/plan'||path==='/execute')return Response.json(operatorMessageAuthority(s,await request.json(),path==='/execute'));
   if(path==='/edit'){
    const key=s.issueAccessKey('commons','owner');
    s.command(key,'commons',{id:'later-edit',type:'message.edited',data:{messageId:'m2',body:'Saved after restart',expectedMessageRevision:0}});
    while(!s.backfillMessages({limit:100}).done){}
    return Response.json({edited:true});
   }
   if(path==='/tamper'){
    this.db.prepare("UPDATE messages SET body='Drifted after restart',record_json=json_set(record_json,'$.body','Drifted after restart') WHERE message_id='m2'").run();
    return Response.json({tampered:true});
   }
   if(path==='/state'){
    const raw=this.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get(),p=JSON.parse(raw.projection);
    return Response.json({sequence:raw.sequence,canonical:Boolean(p.messageAuthority),hasArray:Object.hasOwn(p,'messages'),projectionBytes:new TextEncoder().encode(raw.projection).length,
      bodies:s.room('commons').state.messages.map(m=>m.body),receipts:this.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_execute'").get().n,
      rollingWindow:s.messageProjectionWindow,rollingEntities:s.messageEntityProjection});
   }
   return new Response('Not found',{status:404});
  }catch(e){return Response.json({error:{code:e.code??'internal',message:String(e.message).slice(0,200)}},{status:e.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName('authority-activation').fetch(request);}};
