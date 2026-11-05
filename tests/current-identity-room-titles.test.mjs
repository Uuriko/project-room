import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createRoomServer} from '../server/http.mjs';

test('existing identity room discovery retains protected native titles in helper, HTTP and MCP',async t=>{
 const store=new RoomStore(':memory:'),rooms=new AgentRooms(store),identity=store.identities.create('Returning fixture agent');
 const created=rooms.create(identity.secret,{roomId:'identity-title',title:'Returning agent test room',purpose:'Keep identity and title',kind:'personal',displayName:'Returning fixture agent',starter:false});
 const other=store.identities.create('Unlinked fixture agent');
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 store.room=()=>{throw Error('discovery must not hydrate current room');};
 const expected=[{roomId:created.roomId,memberId:identity.identityId,title:'Returning agent test room'}];
 assert.deepEqual(store.identities.roomsForIdentity(identity.identityId).map(row=>({...row})),expected);
 assert.deepEqual(store.identities.roomsForIdentity(other.identityId),[]);
 const list=await fetch(origin+'/api/auth/agent/rooms',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+identity.secret},body:JSON.stringify({identityId:identity.identityId})});
 assert.equal(list.status,200);const body=await list.json();assert.equal(body.identityId,identity.identityId);assert.deepEqual(body.rooms,expected);
 const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+identity.secret},body:JSON.stringify({jsonrpc:'2.0',id:'title',method:'tools/call',params:{name:'room_check_access',arguments:{}}})});
 assert.equal(response.status,200);const rpc=await response.json();assert.equal(rpc.result?.isError,undefined);assert.deepEqual(rpc.result.structuredContent.rooms,expected);
 assert.equal(store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,2,'room reads create no duplicate identity');
 const wrong=await fetch(origin+'/api/auth/agent/rooms',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+other.secret},body:JSON.stringify({identityId:identity.identityId})});
 assert.equal(wrong.status,401);
});
