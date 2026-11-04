import { httpServerHandler } from 'cloudflare:node';
import { CurrentEventsRoom } from './current-events-worker.test-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { readCurrentMessage } from '../server/current-room-repository.mjs';
export class EventSourceRoom extends CurrentEventsRoom {
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/seed'){
   const events=initialRoom();for(const id of ['agent','outsider'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:'agent',permissions:[]}}));
   this.store.initialize(events,{representation:'normalized-current-v1'});
   const key=this.store.issueAccessKey('commons','agent'),outsider=this.store.issueAccessKey('commons','outsider');
   await this.ctx.storage.put('outside',outsider);
   const before={...this.stats},rawBefore={...this.raw};
   const posted=this.store.command(key,'commons',{id:'private-source',type:'message.posted',data:{messageId:'private-source',body:'Private source fixture',toMemberId:'owner'}});
   await this.ctx.storage.put('sequence',posted.sequence);
   return Response.json({source:posted.event.deliverySource,cost:{statements:this.stats.statements-before.statements,rowsWritten:this.stats.rowsWritten-before.rowsWritten,rawRuntimeRowsWritten:this.raw.rowsWritten-rawBefore.rowsWritten}});
  }
  const value=this.store.readTransaction(()=>readCurrentMessage(this.db,'commons','private-source').value);
  this.http??=httpServerHandler(createRoomServer({store:this.store,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No fixture assets');}}));
  const response=await this.http.fetch(new Request('http://localhost/api/rooms/commons/messages/private-source/thread?view=message',{headers:{host:'localhost',authorization:'Bearer '+await this.ctx.storage.get('outside')}}));
  const saved=JSON.parse(this.db.prepare('SELECT body FROM events WHERE room_id=? AND sequence=?').get('commons',await this.ctx.storage.get('sequence')).body);
  return Response.json({source:saved.deliverySource,projectedHasSource:Object.hasOwn(value,'deliverySource'),privateReadStatus:response.status,privateRead:await response.json()});
 }
}
export default {fetch(request,env){return env.ROOM.getByName('source').fetch(request);}};
