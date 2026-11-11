import {CurrentAttachmentsRoom} from './current-attachments-worker.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readCurrentRecord} from '../server/current-room-repository.mjs';
export class SettingsRoom extends CurrentAttachmentsRoom {
  async fetch(request) {
    const path=new URL(request.url).pathname,s=this.store;
    try {
      if(path==='/seed') {
        const events=initialRoom();
        events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'peer',displayName:'Peer',kind:'agent',permissions:[]}}));
        s.initialize(events,{representation:'normalized-current-v1'});
        await this.ctx.storage.put({owner:s.issueAccessKey('commons','owner'),peer:s.issueAccessKey('commons','peer')});
        return Response.json({seeded:true});
      }
      const owner=await this.ctx.storage.get('owner'),peer=await this.ctx.storage.get('peer');
      if(path==='/change') {
        const before=s.headSequence('commons'); let denied;
        try {s.command(peer,'commons',{id:'denied',type:'room.policy_set',data:{requireIndependentReview:true,requireOwnerDecision:true}});}
        catch(e){denied={code:e.code,message:e.message};}
        const after=s.headSequence('commons');
        s.command(owner,'commons',{id:'policy',type:'room.policy_set',data:{requireIndependentReview:true,requireOwnerDecision:true}});
        s.command(owner,'commons',{id:'trust',type:'room.trust_set',data:{enabled:false}});
        return Response.json({denied,before,after});
      }
      if(path==='/read') {
        const room=readCurrentRecord(this.db,'commons','metadata','room');
        return Response.json({policy:room.policy,trust:room.trust});
      }
      return new Response('not found',{status:404});
    } catch(e) {return Response.json({code:e.code,message:e.message},{status:e.status??500});}
  }
}
export default {fetch(request,env){return env.ROOM.getByName('settings').fetch(request);}};
