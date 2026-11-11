import {httpServerHandler} from 'cloudflare:node';
import {CurrentEventsRoom} from './current-events-worker.test-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class ThreadHistoryRoom extends CurrentEventsRoom {
 async fetch(request){const u=new URL(request.url),s=this.store;
  if(u.pathname==='/seed'){const es=initialRoom(),add=(type,data,at)=>es.push(event({roomId:'commons',actorId:'owner',type,data,at}));
   add('room.history_visibility_set',{historyVisibility:'since_join'},'2026-11-03T08:00:00.000Z');
   add('message.posted',{messageId:'tie-before',body:'hidden'},'2026-11-03T08:00:02.000Z');
   add('member.added',{memberId:'late',displayName:'Late',kind:'agent',permissions:[]},'2026-11-03T08:00:02.000Z');
   add('message.posted',{messageId:'tie-after',body:'visible'},'2026-11-03T08:00:02.000Z');
   add('message.posted',{messageId:'offset-after',body:'visible'},'2026-11-03T00:00:03.000-08:00');
   s.initialize(es,{representation:'normalized-current-v1'});return Response.json({late:s.issueAccessKey('commons','late')});}
  this.http??=httpServerHandler(createRoomServer({store:s,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No fixture assets')}}));const forwarded=new Request('http://localhost'+u.pathname+u.search,request);forwarded.headers.set('host','localhost');return this.http.fetch(forwarded);
 }
}
export default{fetch:(request,env)=>env.ROOM.getByName('history').fetch(request)};
