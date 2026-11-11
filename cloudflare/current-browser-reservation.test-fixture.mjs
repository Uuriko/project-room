import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readRoomSnapshot} from '../server/snapshot-window.mjs';
import {withCurrentReadContext} from '../server/current-room-repository.mjs';
export class CurrentBrowserReservationRoom extends ProjectRoom {
 async fetch(request){
  if(new URL(request.url).pathname!=='/__run')return super.fetch(request);
  const store=this.store,events=initialRoom();
  for(let i=1;i<100;i++)events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'roster-'+i,displayName:'Member '+i,kind:'agent',permissions:[]}}));
  for(let i=0;i<9;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'roster-task-'+i,title:'Useful task',definitionOfDone:'Saved result',accountableMemberId:'owner'}}));
  store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner');
  store.room=()=>{throw Error('browser must not hydrate room');};
  const snapshot=readRoomSnapshot(store,key,'commons',null,{windowed:true}),next=store.roomContext(key,'commons',{workAfter:snapshot.workWindow.nextAfter});
  let nestedCode=null;try{store.readTransaction(()=>withCurrentReadContext(store.db,'commons',()=>readRoomSnapshot(store,key,'commons',null,{windowed:true}),{maxRecords:200}));}catch(error){nestedCode=error.code;}
  return Response.json({members:Object.keys(snapshot.state.members).length,first:snapshot.workWindow,next:next.workWindow,nestedCode});
 }
}
export default {fetch(request,env){return env.ROOM.getByName('browser-reservation').fetch(request);}};
