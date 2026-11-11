import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
const execute=promisify(execFile);
async function cli(origin,args,overrides={}){
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('ROOM_AGENT_'))delete env[key];
 try{const {stdout,stderr}=await execute(process.execPath,['scripts/agent-inbox.mjs',...args],{env:{...env,...(overrides.ROOM_AGENT_CONFIG?{}:{ROOM_AGENT_ORIGIN:origin}),...overrides},timeout:30000,maxBuffer:1024*1024});return {status:0,value:JSON.parse(stdout),stderr};}
 catch(error){return {status:error.code??1,stderr:error.stderr};}
}
test('saved CLI connection checks and orients native work without full-room hydration; legacy orientation stays full',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cli-native-orient-')),store=new RoomStore(join(dir,'room.sqlite'));
 store.initialize([...initialRoom('legacy'),event({roomId:'legacy',actorId:'owner',type:'member.added',data:{memberId:'peer',displayName:'Legacy peer',kind:'agent',permissions:[]}})]);
 const legacyKey=store.issueAccessKey('legacy','peer'),identity=store.identities.create('Native owner');
 new AgentRooms(store).create(identity.secret,{roomId:'native',title:'Native collaboration',purpose:'Saved CLI connection test',displayName:'Native owner',kind:'personal'});
 for(let i=0;i<8;i++)store.command(identity.secret,'native',{id:'work-'+i,type:'work.proposed',data:{workItemId:'task-'+i,title:'Useful task '+i,definitionOfDone:'Save useful result',accountableMemberId:identity.identityId,mode:'read'}});
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
 for(const [roomId,memberId,token]of[['legacy','peer',legacyKey],['native',identity.identityId,identity.secret]]){
  const config=join(dir,roomId+'-connection'),connected=await cli(origin,['connect',config],{ROOM_AGENT_ROOM:roomId,ROOM_AGENT_MEMBER:memberId,ROOM_AGENT_TOKEN:token});assert.equal(connected.status,0,connected.stderr);
  const checked=await cli(origin,['check'],{ROOM_AGENT_CONFIG:config});assert.equal(checked.status,0,checked.stderr);assert.equal(checked.value.status,'verified');
  const oriented=await cli(origin,['orient'],{ROOM_AGENT_CONFIG:config});assert.equal(oriented.status,0,oriented.stderr);assert.equal(oriented.value.roomId,roomId);
  if(roomId==='native'){assert.equal(oriented.value.page.hasMore,true);assert.equal(oriented.value.page.nextRead.tool,'room_list_work');assert.ok(oriented.value.work.length>0);assert.equal(oriented.value.viewerId,memberId);}
  else{assert.ok(Array.isArray(oriented.value.work));assert.equal(oriented.value.page,undefined);}
 }
});

test('CLI orientation fallback only handles the explicit unsupported full current-room contract',async()=>{
 const {orientAgentRoom}=await import('../scripts/bootstrap-agent-room.mjs');
 const {RoomClientError}=await import('../client/room-agent.mjs');
 const calls=[],page={roomId:'native',page:{hasMore:true,nextRead:{tool:'room_list_work'}}};
 assert.equal(await orientAgentRoom({async orient(options){calls.push(options);if(calls.length===1)throw new RoomClientError(409,'current_room_context_unavailable','Use bounded current read');return page;}}),page);
 assert.deepEqual(calls,[{},{paginate:true}]);
 for(const error of [new RoomClientError(401,'unauthenticated','Revoked'),new RoomClientError(409,'storage_integrity_failed','Corrupt'),new RoomClientError(200,'identity_mismatch','Wrong principal'),new Error('Transport')]){
  let count=0;await assert.rejects(()=>orientAgentRoom({async orient(){count++;throw error;}}),actual=>actual===error);assert.equal(count,1);
 }
 let count=0;const unavailable=new RoomClientError(409,'current_room_context_unavailable','Still unavailable');await assert.rejects(()=>orientAgentRoom({async orient(){count++;throw unavailable;}},{paginate:true}),actual=>actual===unavailable);assert.equal(count,1);
});
