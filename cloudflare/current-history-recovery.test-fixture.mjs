import {RedactionNativeRoom} from './current-message-redaction-native.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
export class HistoryRecoveryRoom extends RedactionNativeRoom {
 async fetch(request){if(new URL(request.url).pathname==='/__history-seed'){
  const at='2026-11-01T00:00:00.000Z',es=initialRoom();for(const e of es)e.at=at;
  es.push(event({roomId:'commons',actorId:'owner',at,type:'room.history_visibility_set',data:{historyVisibility:'since_join'}}),event({roomId:'commons',actorId:'owner',at:'2026-11-01T01:00:00+01:00',type:'message.posted',data:{messageId:'before',body:'Hidden before activation'}}),event({roomId:'commons',actorId:'owner',at,type:'member.added',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}}),event({roomId:'commons',actorId:'owner',at,type:'message.posted',data:{messageId:'after',body:'Visible after activation'}}));
  this.store.initialize(es,{representation:'normalized-current-v1'});return Response.json({key:this.store.issueAccessKey('commons','reader')});
 }return super.fetch(request);}
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'source';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
