// Isolated local workerd fixture; never deployed.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { operatorMessageAuthority } from '../server/operator-message-authority.mjs';
import { DurableDatabase,durableStorage } from './storage.mjs';
export class AuthorityPrepareRoom extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});}
  async fetch(request) {
    const path=new URL(request.url).pathname,s=this.store,db=this.db;
    try {
      if(path==='/seed') {
        const events=[...initialRoom()];
        for(let i=0;i<300;i++)events.push(event({id:'post-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'m'+i,body:'Synthetic body '+i}}));
        s.initialize(events);s.initialize(initialRoom('other','other-owner'));
        return Response.json({seeded:true});
      }
      if(['/plan','/prepare','/execute'].includes(path))return Response.json(operatorMessageAuthority(s,await request.json(),path==='/prepare'?'prepare':path==='/execute'));
      if(path==='/append') {
        const key=s.issueAccessKey('commons','owner');
        s.command(key,'commons',{id:'after-step-append',type:'message.posted',data:{messageId:'after-step',body:'Appended after first prepare'}});
        return Response.json({appended:true});
      }
      if(path==='/reorder') {
        s.transaction(()=>{
          db.prepare("UPDATE messages_backfill_cursor SET applied_seq=0,applied_event_id='',state_seq=0,replay_event_id='',parity_at_seq=NULL WHERE room_id='commons'").run();
          db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
          db.prepare("UPDATE events SET sequence=2000 WHERE room_id='commons' AND sequence=3").run();
          db.prepare("UPDATE events SET sequence=3 WHERE room_id='commons' AND sequence=4").run();
          db.prepare("UPDATE events SET sequence=4 WHERE room_id='commons' AND sequence=2000").run();
        });
        return Response.json({reordered:true});
      }
      if(path==='/missing-authority') {
        db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='m0'").run();
        db.prepare("UPDATE events SET body=json_set(body,'$.data.body','Forged') WHERE room_id='commons' AND json_extract(body,'$.data.messageId')='m0'").run();
        return Response.json({damaged:true});
      }
      if(path==='/state') {
        const raw=db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get(),projection=JSON.parse(raw.projection);
        return Response.json({sequence:raw.sequence,canonical:Boolean(projection.messageAuthority),cursor:db.prepare("SELECT applied_seq,state_seq,replay_event_id FROM messages_backfill_cursor WHERE room_id='commons'").get()??null,
          otherCursor:db.prepare("SELECT state_seq FROM messages_backfill_cursor WHERE room_id='other'").get()??null,
          prepareReceipts:db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_prepare'").get().n,
          executeReceipts:db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_execute'").get().n,
          provenance:db.prepare("SELECT message_id,seq,entity_hash FROM messages WHERE room_id='commons' AND message_id IN ('m0','m1') ORDER BY message_id").all(),
          messages:db.prepare("SELECT count(*) AS n FROM messages WHERE room_id='commons'").get().n,
          appended:db.prepare("SELECT body FROM messages WHERE room_id='commons' AND message_id='after-step'").get()?.body??null});
      }
      return new Response('Not found',{status:404});
    } catch(error) {return Response.json({error:{code:error.code??'internal',message:String(error.message).slice(0,200)}},{status:error.status??500});}
  }
}
export default {fetch(request,env){return env.ROOM.getByName('bounded-authority-prepare').fetch(request);}};
