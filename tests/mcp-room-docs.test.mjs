import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';
import {mcpOAuthToolAllowed} from '../server/mcp-oauth.mjs';
function fixture(t, enabled=true) {
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  const identity=store.identities.create('Docs MCP owner');
  new AgentRooms(store).create(identity.secret,{roomId:'docs-mcp',title:'Docs',purpose:'Test',kind:'personal'});
  const mcp=createHostedRoomMcp(store,{roomDocsEnabled:enabled});
  const rpc=(method,params,secret=identity.secret)=>mcp({jsonrpc:'2.0',id:1,method,params},{authorization:`Bearer ${secret}`});
  const call=(name,args={},secret)=>rpc('tools/call',{name,arguments:{roomId:'docs-mcp',...args}},secret);
  return {store,identity,rpc,call};
}
test('MCP docs discovery, write, historical read and stale conflict share the HTTP contract',async t=>{
  const f=fixture(t), args={docId:'spec',title:'Spec',body:'original',baseRev:0};
  const full=await f.rpc('tools/list',{profile:'full'});
  assert.ok(full.result.tools.some(x=>x.name==='room_docs'&&x.annotations.readOnlyHint));
  assert.ok(full.result.tools.some(x=>x.name==='room_write_doc'&&!x.annotations.readOnlyHint));
  const found=await f.rpc('tools/call',{name:'room_search_actions',arguments:{query:'wiki documents'}});
  assert.ok(JSON.stringify(found).includes('room_docs'));
  const created=await f.call('room_write_doc',args);assert.equal(created.result.structuredContent.doc.rev,1,JSON.stringify(created));
  const updated=await f.call('room_write_doc',{...args,body:'updated',baseRev:1});assert.equal(updated.result.structuredContent.doc.rev,2);
  const old=await f.call('room_docs',{docId:'spec',rev:1});assert.equal(old.result.structuredContent.doc.body,'original');
  const stale=await f.call('room_write_doc',{...args,baseRev:1});assert.equal(stale.result.structuredContent.code,'doc_rev_conflict');
  const wrapped=await f.rpc('tools/call',{name:'room_run_action',arguments:{name:'room_docs',arguments:{roomId:'docs-mcp',limit:1}}});
  assert.equal(wrapped.result.structuredContent.docs[0].rev,2);
});
test('disabled docs are absent from discovery and direct/wrapped calls refuse',async t=>{
  const f=fixture(t,false);
  const list=await f.rpc('tools/list',{profile:'full'});assert.ok(!list.result.tools.some(x=>['room_docs','room_write_doc'].includes(x.name)));
  const search=await f.rpc('tools/call',{name:'room_search_actions',arguments:{query:'wiki documents'}});assert.ok(!JSON.stringify(search).includes('"name":"room_docs"'));
  for(const name of ['room_docs','room_write_doc']){
    const args=name==='room_docs'?{}:{docId:'spec',title:'Spec',body:'no',baseRev:0};
    const result=await f.call(name,args);assert.equal(result.result.structuredContent.code,'not_found',JSON.stringify(result));
  }
  const wrapped=await f.rpc('tools/call',{name:'room_run_action',arguments:{name:'room_docs',arguments:{roomId:'docs-mcp'}}});assert.equal(wrapped.result.structuredContent.code,'not_found');
});
test('scoped keys cannot write with read scope or read another room; historical reads require membership',async t=>{
  const f=fixture(t);
  await f.call('room_write_doc',{docId:'spec',title:'Spec',body:'private',baseRev:0});
  const token='rak_'+f.store.agentPlugin.issueApiKey({identityId:f.identity.identityId,scopes:['rooms:read','mcp:room:docs-mcp']}).secret;
  assert.equal((await f.call('room_docs',{docId:'spec'},token)).result.structuredContent.doc.body,'private');
  assert.equal((await f.call('room_write_doc',{docId:'spec',title:'Spec',body:'bad',baseRev:1},token)).result.structuredContent.code,'insufficient_scope');
  assert.equal((await f.call('room_docs',{roomId:'other',docId:'spec'},token)).result.isError,true);
  const outsider=f.store.identities.create('Outside');
  const denied=await f.call('room_docs',{docId:'spec',rev:1},outsider.secret);assert.equal(denied.result.isError,true);assert.ok(!JSON.stringify(denied).includes('private'));
  assert.equal(mcpOAuthToolAllowed('room_docs',['rooms:read']),true);
  assert.equal(mcpOAuthToolAllowed('room_write_doc',['rooms:read','chat:write','work:write']),false);
  assert.equal(mcpOAuthToolAllowed('room_write_doc',['docs:write']),true);
  assert.equal(mcpOAuthToolAllowed('room_post_message',['docs:write']),false);
});
