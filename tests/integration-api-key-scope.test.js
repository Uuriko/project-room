import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createRoomServer} from '../server/http.mjs';
import {API_KEY_PREFIX} from '../server/agent-api-keys.mjs';
for(const [route,flag,data] of [['inbound-hooks','ROOM_INBOUND_HOOKS',{}],['automations','ROOM_AUTOMATIONS',{template:'post-deploy-check'}]]) test(`${route} requires rooms:write even for owner API key`,async t=>{
 const prior=process.env[flag], key=process.env.ROOM_INBOUND_HOOK_KEY;process.env[flag]='1';process.env.ROOM_INBOUND_HOOK_KEY='synthetic-only-key-'.repeat(3);
 const store=new RoomStore(':memory:');const rooms=new AgentRooms(store);const owner=store.identities.create('Synthetic owner');
 const {roomId}=rooms.create(owner.secret,{roomId:'scope-test',title:'Synthetic',purpose:'Scope test',kind:'personal',displayName:'Synthetic owner'});
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();if(prior===undefined)delete process.env[flag];else process.env[flag]=prior;if(key===undefined)delete process.env.ROOM_INBOUND_HOOK_KEY;else process.env.ROOM_INBOUND_HOOK_KEY=key;});
 const issue=scopes=>API_KEY_PREFIX+store.agentPlugin.issueApiKey({identityId:owner.identityId,scopes}).secret;
 const post=token=>fetch(`http://127.0.0.1:${server.address().port}/api/rooms/${roomId}/${route}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const refused=await post(issue(['rooms:read']));assert.equal(refused.status,403);assert.equal((await refused.json()).error.code,'insufficient_scope');
 const accepted=await post(issue(['rooms:read','rooms:write']));assert.equal(accepted.status,201);
});
