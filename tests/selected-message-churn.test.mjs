import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { withCurrentReadContext, withCurrentRoomWriter } from '../server/current-room-repository.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t, added = 105) {
 const store = new RoomStore(':memory:');
 const events = initialRoom();
 const add = (type, data, actorId = 'owner') => events.push(event({roomId:'commons', actorId, type, data}));
 for (let i=0;i<added;i++) add('member.added',{memberId:'member-'+i,displayName:'Member '+i,kind:'agent',permissions:[]});
 for (let i=0;i<10;i++) add('member.access_changed',{memberId:'member-'+i,expectedMemberRevision:0,permissions:[],active:false});
 add('message.posted',{messageId:'public-at',body:'@Member please inspect this.'});
 add('message.posted',{messageId:'public-plain',body:'Please inspect this.'});
 add('message.posted',{messageId:'private-other',body:'@Member private',toMemberId:'member-11'});
 add('message.posted',{messageId:'formal-at',body:'@Member please review.',toMemberId:'member-10',requestKind:'reply'});
 store.initialize(events,{representation:'normalized-current-v1'});
 const token=store.issueAccessKey('commons','member-10');
 const server=createRoomServer({store});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const read=async(id,query='?view=message')=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/messages/${id}/thread${query}`,{headers:{authorization:'Bearer '+token}});
  return {status:r.status,value:await r.json()};
 };
 return {store,read,token};
}

test('selected message routing survives roster churn without resolving unused mentions',async t=>{
 const {store,read,token}=await fixture(t);
 assert.equal((await read('public-plain')).status,200);
 const selected=await read('public-at');
 assert.equal(selected.status,200,JSON.stringify(selected.value));
 assert.equal(selected.value.messageContextVersion,1);
 assert.equal(selected.value.thread.id,'public-at');
 assert.deepEqual(selected.value.thread.replies,[]);
 const formal=await read('formal-at');
 assert.equal(formal.status,200,JSON.stringify(formal.value));
 assert.equal(formal.value.thread.id,'formal-at');
 assert.equal((await read('private-other')).status,404);
 assert.equal((await read('missing')).status,404);
 assert.throws(()=>readConversation(store,token,'commons',{messageId:'public-at'}),
  error=>error.code==='current_room_context_unavailable', 'public conversation addressing keeps its full-roster contract');
});

test('selected message avoids aggregate roster proof budget even below the member cap',async t=>{
 const {store,read,token}=await fixture(t,75);
 assert.throws(()=>withCurrentReadContext(store.db,'commons',()=>readConversation(store,token,'commons',{messageId:'public-at'})),
  error=>error.code==='current_room_context_unavailable' && error.message==='Current record context exceeds bounded input; use a smaller addressed request');
 const selected=await read('public-at');
 assert.equal(selected.status,200,JSON.stringify(selected.value));
 assert.equal(selected.value.thread.id,'public-at');
});

test('selected routing retains protected message integrity checks',async t=>{
 const {store,read}=await fixture(t);
 store.transaction(()=>withCurrentRoomWriter(store.db,'commons',()=>store.db.prepare("UPDATE messages SET body='tampered' WHERE room_id='commons' AND message_id='public-at'").run()));
 const selected=await read('public-at');
 assert.equal(selected.status,500);
 assert.notEqual(selected.value.thread?.body,'tampered');
});
