import {ProjectRoom} from './room.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
const realNow=Date.now.bind(Date);let offset=0;
export class RetryHintRoom extends ProjectRoom {
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/__seed'){
   const owner=this.store.identities.create('Retry owner');
   new AgentRooms(this.store).create(owner.secret,{roomId:'retry-room',title:'Retry',purpose:'test',starter:false,visibility:'private'});
   return Response.json({secret:owner.secret});
  }
  if(url.pathname==='/__advance'){
   offset=Number(url.searchParams.get('ms'));Date.now=()=>realNow()+offset;
   return Response.json({ok:true});
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('retry').fetch(new Request(request,{headers}));}};
