import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createRoomServer} from '../server/http.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
import {ServiceError} from '../server/service-error.mjs';
import {MAX_BODY_CHARS} from '../server/public-face.mjs';

test('a failed optional public preview cannot hide committed lobby admission or duplicate its seat',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'public-context-recovery-')),store=new RoomStore(join(dir,'db'));
 const roomId='project-room-lobby',owner=store.identities.create('Lobby founder');
 new AgentRooms(store).create(owner.secret,{roomId,title:'Public lobby',purpose:'Coordinate',starter:false,visibility:'private'});
 const command=(id,type,data)=>store.command(owner.secret,roomId,{id,type,data});
 command('open-page','room.public_page_set',{enabled:true});command('open-join','room.join_link_set',{enabled:true});
 const ownerId=store.authenticate(owner.secret,roomId).member.id;
 command('private','message.posted',{messageId:'private',body:'PRIVATE OWNER CONTEXT',toMemberId:ownerId});
 command('large','message.posted',{messageId:'large',body:'界'.repeat(65536)});
 const published=store.publicFace.enable(roomId,ownerId);
 // Max accepted bodies are now readable; their old refusal is not a reliable
 // fault fixture. Prove that real path, then inject the exact optional failure.
 const readable=store.publicFace.faceByCode(published.publicCode);assert.equal(readable.messages.length,1);assert.equal(readable.messages[0].body,'界'.repeat(MAX_BODY_CHARS)+' …');assert.doesNotMatch(JSON.stringify(readable),/PRIVATE OWNER CONTEXT/);
 store.publicFace.faceByCode=()=>{throw new ServiceError(409,'current_room_context_unavailable','Synthetic bounded preview refusal');};
 const peer=store.identities.create('Recovery collaborator');
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 store.room=()=>{throw Error('whole room hydration forbidden');};
 const call=async()=>{
  const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+peer.secret},body:JSON.stringify({jsonrpc:'2.0',id:'join',method:'tools/call',params:{name:'room_join',arguments:{roomId}}})});return (await response.json()).result;
 };
 const first=await call();assert.notEqual(first.isError,true,JSON.stringify(first.structuredContent));
 const value=first.structuredContent;assert.equal(value.status,'approved');assert.equal(value.memberId,peer.identityId);assert.deepEqual(value.grantedPermissions,[]);
 assert.equal(value.publicContext.available,false);assert.equal(value.publicContext.source,'/watch');assert.equal(value.publicContext.reason,'current_room_context_unavailable');assert.deepEqual(value.publicContext.messages,[]);
 assert.equal(value.publicContext.untrusted,true);assert.doesNotMatch(JSON.stringify(value),/PRIVATE OWNER CONTEXT|界|pri_/);
 assert.equal(value.next[0].tool,'room_activation_pack');
 assert.equal(store.authenticate(peer.secret,roomId).member.historyGuest,true);
 assert.throws(()=>readConversation(store,peer.secret,roomId,{messageId:'private'}),e=>e.status===404);
 const seq=store.headSequence(roomId),again=(await call()).structuredContent;
 assert.equal(again.alreadyMember,true);assert.equal(again.memberId,peer.identityId);assert.equal(again.publicContext.available,false);assert.equal(store.headSequence(roomId),seq);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId,peer.identityId).n,1);
 // Unexpected programming/storage failures must remain errors, not be hidden
 // behind the optional-preview fallback or leak their raw diagnostic text.
 store.publicFace.faceByCode=()=>{throw Error('PRIVATE DIAGNOSTIC');};
 const unknown=await call();assert.equal(unknown.isError,true);assert.equal(unknown.structuredContent.code,'internal');
 assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE DIAGNOSTIC/);assert.equal(store.headSequence(roomId),seq);
});
