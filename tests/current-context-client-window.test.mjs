import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';
import {RoomAgentClient} from '../client/room-agent.mjs';
import {serveRoomMcp,MCP_VERSION,roomTools} from '../client/mcp-stdio.mjs';

async function fixture(t) {
 const store=new RoomStore(':memory:'),identity=store.identities.create('Context client fixture');
 const events=initialRoom();events[1].data.kind='agent';events[1].data.identityId=identity.identityId;store.initialize(events,{representation:'normalized-current-v1'});
 // Synthetic initial-seat registration, not an onboarding or link-authority test.
 store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',identity.identityId,'owner',new Date(store.now()).toISOString());
 const token=identity.secret;store.room=()=>{throw Error('whole room hydration');};
 for(let i=0;i<19;i++)store.command(token,'commons',{id:'propose-'+i,type:'work.proposed',data:{workItemId:'task-'+String(i).padStart(2,'0'),title:'Useful '+i,definitionOfDone:'OMITTED-DEFINITION-SENTINEL',accountableMemberId:'owner'}});
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 let requests=0;const client=new RoomAgentClient({origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'owner',token,fetchImpl:(...args)=>{requests++;return fetch(...args);}});
 return {client,requests:()=>requests};
}
function harness(t,client) {
 const input=new PassThrough(),output=new PassThrough(),pending=new Map();let buffer='',id=0;
 const server=serveRoomMcp({client,roomId:'commons',memberId:'owner',input,output});
 output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const reply=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(reply.id)?.(reply);pending.delete(reply.id);}});
 const rpc=(method,params)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
 t.after(()=>{server.stop();input.destroy();output.destroy();});
 return {rpc,async ready(){const r=await rpc('initialize',{protocolVersion:MCP_VERSION,capabilities:{},clientInfo:{name:'window-test',version:'1'}});assert.equal(r.result.protocolVersion,MCP_VERSION);input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}};
}

test('RoomAgentClient traverses actual bounded context windows and binds conditional versions to the window',async t=>{
 const {client}=await fixture(t),ids=[];let after,first;
 for(let i=0;i<3;i++){const page=await client.roomContext(after===undefined?{}:{workAfter:after});first??=page;assert.equal(page.workWindow.total,19);assert.ok(page.workWindow.shown<=8);ids.push(...page.focusWork.map(x=>x.id));assert.equal(JSON.stringify(page).includes('OMITTED-DEFINITION-SENTINEL'),false);after=page.workWindow.nextAfter;}
 assert.equal(after,null);assert.equal(ids.length,19);assert.equal(new Set(ids).size,19);
 assert.equal((await client.roomContext({sinceVersion:first.context_version})).not_modified,true);
 const second=await client.roomContext({sinceVersion:first.context_version,workAfter:first.workWindow.nextAfter});
 assert.notEqual(second.not_modified,true);assert.equal(second.workWindow.after,first.workWindow.nextAfter);
});

test('stdio follows the exact context continuation pointer without dropping or widening its room binding',async t=>{
 const f=await fixture(t),h=harness(t,f.client);await h.ready();
 const definition=roomTools.find(x=>x.name==='get_room_context');assert.ok(definition.inputSchema.properties.work_after);
 const ids=[];let pointer={tool:'get_room_context',arguments:{}};
 for(let i=0;i<3;i++){const reply=await h.rpc('tools/call',{name:pointer.tool,arguments:pointer.arguments});assert.equal(reply.error,undefined,JSON.stringify(reply));assert.notEqual(reply.result.isError,true,JSON.stringify(reply));const page=reply.result.structuredContent;ids.push(...page.focusWork.map(x=>x.id));pointer=page.workWindow.nextRead;}
 assert.equal(pointer,null);assert.equal(ids.length,19);assert.equal(new Set(ids).size,19);
 const before=f.requests();const wrong=await h.rpc('tools/call',{name:'get_room_context',arguments:{roomId:'another-room',work_after:'task-07'}});assert.equal(wrong.error.code,-32602);assert.equal(f.requests(),before);
 for(const value of ['',null,[],true,'../other','constructor','a'.repeat(129)]){const reply=await h.rpc('tools/call',{name:'get_room_context',arguments:{work_after:value}});assert.equal(reply.error.code,-32602);}
 assert.equal(f.requests(),before);
});

test('SDK refuses malformed context cursors before sending a request',async()=>{
 let sent=0;const client=new RoomAgentClient({origin:'https://room.example.test',roomId:'commons',memberId:'owner',token:'a'.repeat(43),fetchImpl:()=>{sent++;throw Error('unexpected network');}});
 for(const workAfter of ['',null,[],true,'../other','constructor','a'.repeat(129)])assert.throws(()=>client.roomContext({workAfter}),error=>error.code==='invalid_context_cursor');
 assert.equal(sent,0);
});
