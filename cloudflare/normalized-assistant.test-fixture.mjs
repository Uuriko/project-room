// Synthetic local-only qualification; never exported from the deployed Worker.
import {ProjectRoom} from './room.mjs';
import {RoomAssistant} from '../server/room-assistant.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class NormalizedAssistantRoom extends ProjectRoom{
 async fetch(request){const path=new URL(request.url).pathname,s=this.store;
  if(path==='/__seed'){
   const {terminalRows}=await request.json();if(!Number.isInteger(terminalRows)||terminalRows<0||terminalRows>3000)throw Error('Invalid fixture size');
   s.createAccount('assistant-human');const slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,s.issueAccountAccessKey('assistant-human'),0),created=s.createAccountRoom(slot.token,session.sessionBinding,{roomId:'assistant-native',title:'Shared assistant',purpose:'Coordinate existing agents',kind:'personal',displayName:'Owner'}),ownerId=created.room.memberId,owner=s.issueAccessKey('assistant-native',ownerId);
   s.command(owner,'assistant-native',{id:'add-coordinator',type:'member.added',data:{memberId:'coordinator',displayName:'Coordinator',kind:'agent',permissions:['accept_work'],accountableHumanId:ownerId}});const coordinator=s.issueAccessKey('assistant-native','coordinator');
   s.command(owner,'assistant-native',{id:'history-source',type:'message.posted',data:{messageId:'history-source',body:'Synthetic historical source'}});
   s.transaction(()=>{for(let n=0;n<terminalRows;n++){const run={id:'terminal-'+n,sourceMessageId:'history-source',initiatorId:ownerId,coordinatorMemberId:'coordinator',status:'done',revision:0,attemptId:null,createdAt:1,updatedAt:1,inputs:[],activity:[]};s.db.prepare('INSERT INTO room_assistant_runs VALUES(?,?,?)').run('assistant-native',run.id,JSON.stringify(run));}});await this.ctx.storage.put('assistant-fixture',{owner,ownerId,coordinator});return Response.json({terminalRows});
  }
  const facts=await this.ctx.storage.get('assistant-fixture');
  if(path==='/__post'){s.command(facts.owner,'assistant-native',{id:'native-ask',type:'message.posted',data:{messageId:'native-ask',body:'@Room please coordinate'}});return Response.json({ok:true});}
  if(path==='/__proof'){auditRecovery(s);return Response.json({runs:s.db.prepare("SELECT count(*) n FROM room_assistant_runs WHERE room_id='assistant-native'").get().n,config:new RoomAssistant(s).config('assistant-native')});}
  if(path==='/__assistant'){
   const observe=s.db.observeStatement,cost={rowsRead:0,rowsWritten:0,statements:0,unknown:0};s.db.observeStatement=()=>record=>{cost.statements++;for(const key of ['rowsRead','rowsWritten'])if(record[key]===null)cost.unknown++;else cost[key]+=record[key];};const started=performance.now();
   try{const h=new Headers(request.headers);h.set('Authorization','Bearer '+(request.headers.get('x-fixture-actor')==='coordinator'?facts.coordinator:facts.owner));const response=await super.fetch(new Request('https://room.example/api/rooms/assistant-native/assistant',{method:request.method,headers:h,body:['GET','HEAD'].includes(request.method)?undefined:request.body,duplex:'half'}));return Response.json({status:response.status,body:await response.json(),cost,elapsedMs:performance.now()-started,clockOnly:true});}finally{s.db.observeStatement=observe;}
  }
  return super.fetch(request);
 }
}
export default{fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.4');return env.ROOM.getByName('assistant').fetch(new Request(request,{headers}));}};
