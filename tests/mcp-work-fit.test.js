// Distinct transport owner: real hosted MCP and a bound stdio process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createRoomServer} from '../server/http.mjs';
import {saveAgentConnection} from '../client/agent-connection.mjs';
import {openMcpTestClient} from '../scripts/mcp-test-client.mjs';
test('work fit is callable through hosted and stdio MCP with a stable shared retry receipt',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mcp-fit-')),store=new RoomStore(join(directory,'room.sqlite')),identity=store.identities.create('Fit tester');
 new AgentRooms(store).create(identity.secret,{roomId:'fit-room',title:'Fit room',purpose:'Tool qualification',kind:'personal',displayName:'Tester'});
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,config=join(directory,'agent');let stdio;
 t.after(async()=>{await stdio?.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(directory,{recursive:true,force:true});});
 const call=async(name,args)=>(await(await fetch(`${origin}/room/mcp?profile=full`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${identity.secret}`},body:JSON.stringify({jsonrpc:'2.0',id:'fit',method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const args={action:'update_self',requestId:'interest-once',expectedRevision:0,preferences:{learn:['research_writing']}};
 const hosted=await call('room_update_work_fit',{roomId:'fit-room',...args});assert.notEqual(hosted.isError,true,JSON.stringify(hosted));
 saveAgentConnection(config,{version:1,origin,roomId:'fit-room',memberId:identity.identityId,token:identity.secret});stdio=await openMcpTestClient(config);
 const replay=(await stdio.call('room_update_work_fit',args)).result;assert.deepEqual(replay.structuredContent,hosted.structuredContent);
 const read=(await stdio.call('room_read_work_fit',{})).result;assert.deepEqual(read.structuredContent.preferences.learn,['research_writing']);
 const hostedRead=await call('room_read_work_fit',{roomId:'fit-room'});assert.deepEqual(hostedRead.structuredContent,read.structuredContent);
 const bad=await fetch(`${origin}/room/mcp?profile=full`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${identity.secret}`},body:JSON.stringify({jsonrpc:'2.0',id:'bad',method:'tools/call',params:{name:'room_update_work_fit',arguments:{roomId:'fit-room',...args,actorMemberId:'spoof'}}})});
 const invalid=await bad.json();assert.equal(invalid.error.code,-32602);assert.equal(store.workFit.profile('fit-room',identity.identityId).selfRevision,1);
});
