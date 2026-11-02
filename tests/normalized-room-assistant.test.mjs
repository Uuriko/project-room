import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {RoomAssistant} from '../server/room-assistant.mjs';
import {createRoomServer} from '../server/http.mjs';
function fixture(t){
 const store=new RoomStore(':memory:');t.after(()=>store.close());store.createAccount('assistant-human');const slot=store.createAccountSessionSlot(),session=store.loginAccountSession(slot.token,store.issueAccountAccessKey('assistant-human'),0);
 const created=store.createAccountRoom(slot.token,session.sessionBinding,{roomId:'assistant-native',title:'Shared assistant',purpose:'Coordinate existing agents',kind:'personal',displayName:'Owner'}),ownerId=created.room.memberId,owner=store.issueAccessKey('assistant-native',ownerId);
 store.command(owner,'assistant-native',{id:'add-coordinator',type:'member.added',data:{memberId:'coordinator',displayName:'Coordinator',kind:'agent',permissions:['accept_work'],accountableHumanId:ownerId}});const coordinator=store.issueAccessKey('assistant-native','coordinator');
 const assistant=new RoomAssistant(store),apply=(token,input)=>assistant.apply('assistant-native',{requestId:randomUUID(),...input},()=>store.authenticate(token,'assistant-native'),token);return{store,ownerId,owner,coordinator,assistant,apply};
}
test('fresh normalized assistant config/read/Connect uses existing members and no whole room',t=>{
 const f=fixture(t);f.store.room=()=>{throw Error('Unexpected whole-room assistant read');};
 const configured=f.apply(f.owner,{action:'configure',requestId:'configure-once',expectedRevision:0,name:'Room',coordinatorMemberId:'coordinator'});assert.equal(configured.result.coordinatorMemberId,'coordinator');assert.deepEqual(f.apply(f.owner,{action:'configure',requestId:'configure-once',expectedRevision:0,name:'Room',coordinatorMemberId:'coordinator'}),configured);
 const read=f.assistant.list('assistant-native',()=>f.store.authenticate(f.owner,'assistant-native'));assert.equal(read.assistant.availability,'awaiting_host');assert.deepEqual(read.runs,[]);assert.throws(()=>f.apply(f.coordinator,{action:'configure',expectedRevision:1,name:'Room',coordinatorMemberId:null}),e=>e.code==='assistant_denied');
});
test('configured normalized room still posts and dispatches to the same authorized coordinator',t=>{
 const f=fixture(t);f.apply(f.owner,{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'coordinator'});f.store.room=()=>{throw Error('Unexpected whole-room assistant read');};
 f.store.command(f.owner,'assistant-native',{id:'native-room-ask',type:'message.posted',data:{messageId:'native-room-ask',body:'Room, coordinate this task'}});const read=f.assistant.list('assistant-native',()=>f.store.authenticate(f.owner,'assistant-native'));assert.equal(read.runs.length,1);assert.equal(read.runs[0].coordinatorMemberId,'coordinator');assert.equal(read.runs[0].sourceMessageId,'native-room-ask');
});
test('actual HTTP normalized assistant configure/read keeps room credentials and authorization',async t=>{
 const f=fixture(t),server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const url=`http://127.0.0.1:${server.address().port}/api/rooms/assistant-native/assistant`,input={action:'configure',requestId:'http-configure',expectedRevision:0,name:'Room',coordinatorMemberId:'coordinator'};
 const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+f.owner,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,200,JSON.stringify(await response.json()));const read=await fetch(url,{headers:{Authorization:'Bearer '+f.owner}});assert.equal(read.status,200);assert.equal((await read.json()).assistant.coordinatorMemberId,'coordinator');
});
