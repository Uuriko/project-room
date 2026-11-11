import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountClient} from '../src/account-client.js';
import {createAgentRoom} from '../client/room-agent.mjs';
import {RoomStore} from '../server/store.mjs';
import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';
import {hostedRoomTools} from '../server/mcp-hosted-tools.mjs';
const response=value=>({ok:true,status:200,json:async()=>value});

test('account blank and template creation preserve open/private choices and session proof',async()=>{
  const calls=[],client=new AccountClient({fetcher:async(path,options)=>{calls.push({path,options});return response({room:{id:'new-room'}});}});
  client.session={authenticated:true,account:{id:'creator'},sessionRevision:1,csrf:'csrf',sessionBinding:'binding'};
  for(const visibility of ['open','private']) {
    await client.createRoom({roomId:'blank-'+visibility,title:'Room',purpose:'Work',visibility});
    await client.createRoomFromTemplate({roomId:'template-'+visibility,template:'project',ref:'referrer',visibility});
  }
  assert.deepEqual(calls.map(c=>c.path),['/api/account-rooms','/api/account-rooms/from-template','/api/account-rooms','/api/account-rooms/from-template']);
  assert.deepEqual(calls.map(c=>JSON.parse(c.options.body).visibility),['open','open','private','private']);
  assert.equal(JSON.parse(calls[1].options.body).ref,'referrer');
  for(const {options} of calls){assert.equal(options.method,'POST');assert.equal(options.headers['X-CSRF-Token'],'csrf');assert.equal(options.headers['X-Session-Binding'],'binding');}
});

test('agent client forwards explicit visibility and leaves omitted default to server',async()=>{
  for(const visibility of [undefined,'open','private']) {
    let sent;
    await createAgentRoom('http://127.0.0.1:8080','pri_'+'a'.repeat(32),{title:'Room',purpose:'Work',visibility},{fetchImpl:async(url,options)=>{sent={url,options};return response({roomId:'new-room',ownerMemberId:'creator'});}});
    const body=JSON.parse(sent.options.body);
    assert.equal(body.visibility,visibility);assert.equal(Object.hasOwn(body,'visibility'),visibility!==undefined);
    assert.equal(sent.options.headers.Authorization,'Bearer pri_'+'a'.repeat(32));
    assert.equal(sent.options.credentials,'omit');
  }
});

test('hosted MCP exposes, validates and forwards room_create visibility without changing omitted requests',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mcp-create-visibility-')),store=new RoomStore(join(directory,'db'));
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const identity=store.identities.create('Room creator'),calls=[];
  const mcp=createHostedRoomMcp(store,{agentRooms:{create(secret,args){calls.push({secret,args});return{roomId:'new-room',ownerMemberId:identity.identityId};}}});
  const call=visibility=>mcp({jsonrpc:'2.0',id:'create',method:'tools/call',params:{name:'room_create',arguments:{title:'Room',purpose:'Work',...(visibility===undefined?{}:{visibility})}}},{authorization:`Bearer ${identity.secret}`});
  assert.deepEqual(hostedRoomTools.find(t=>t.name==='room_create').inputSchema.properties.visibility.enum,['open','private']);
  for(const visibility of [undefined,'open','private']) {const result=await call(visibility);assert.notEqual(result.result?.isError,true,JSON.stringify(result));assert.equal(calls.at(-1).args.visibility,visibility);assert.equal(calls.at(-1).secret,identity.secret);}
  const count=calls.length;
  for(const visibility of ['public',null,42]) {const result=await call(visibility);assert.equal(result.error?.code,-32602,JSON.stringify(result));}
  assert.equal(calls.length,count);
});
