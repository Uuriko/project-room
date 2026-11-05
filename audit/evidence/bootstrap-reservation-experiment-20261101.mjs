import {RoomStore} from '../../server/store.mjs';
import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
import {withCurrentReadContext} from '../../server/current-room-repository.mjs';
import {readRoomSnapshot} from '../../server/snapshot-window.mjs';
for(const [members,tasks] of [[1,9],[2,9],[4,32],[4,128],[32,9],[100,9]]) {
 const store=new RoomStore(':memory:'),events=initialRoom();
 for(let i=1;i<members;i++)events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'member-'+i,displayName:'Member '+i,kind:'agent',permissions:[]}}));
 for(let i=0;i<tasks;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'task-'+i,title:'Task '+i,definitionOfDone:'Saved',accountableMemberId:'owner'}}));
 try {
  store.initialize(events,{representation:'normalized-current-v1'});
  let key;try{key=store.issueAccessKey('commons','owner');}catch(error){console.log('BOOTSTRAP_RESERVATION '+JSON.stringify({members,tasks,phase:'key',error:error.code??error.message}));continue;}
  for(const maxRecords of [200,512,1024]) {
   const result=store.readTransaction(()=>withCurrentReadContext(store.db,'commons',budget=>{
    let read,error;try{read=readRoomSnapshot(store,key,'commons',null,{windowed:true});}catch(cause){error=cause.code??cause.message;}
    return {members,tasks,maxRecords,error,records:budget.records,bytes:budget.bytes,shown:read?.workWindow.shown};
   },{maxRecords}));
   console.log('BOOTSTRAP_RESERVATION '+JSON.stringify(result));
  }
 }finally{store.close();}
}
