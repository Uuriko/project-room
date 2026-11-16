import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {withCurrentReadContext,chargeCurrentReadBudget} from '../server/current-room-repository.mjs';
import {runMcpOAuthRequest} from '../server/mcp-oauth.mjs';
import {providerFor,resource} from './helpers/work-linked-post-oauth.mjs';
import {createRoomServer} from '../server/http.mjs';
import {client} from './helpers/work-linked-post-oauth.mjs';
import {seedOAuthWorkRead} from './helpers/oauth-work-read-source.mjs';
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'oauth-work-read-')),filename=join(dir,'room.sqlite');let store=new RoomStore(filename),server,base;
 const saved=seedOAuthWorkRead(store);
 const open=async()=>{store.room=()=>{throw Error('whole-room hydration');};server=createRoomServer({store,origin:'https://room.example',mcpOAuthClients:[client]});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;};
 const close=async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();};await open();t.after(async()=>{await close();rmSync(dir,{recursive:true,force:true});});
 const call=(name,args,token=saved.token)=>new Promise((resolve,reject)=>{const req=request(base+'/mcp',{method:'POST',headers:{Host:'room.example','Content-Type':'application/json',Authorization:'Bearer '+token}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:'test',method:'tools/call',params:{name,arguments:args}}));});
 return {get store(){return store;},saved,call,reopen:async()=>{await close();store=new RoomStore(filename);await open();}};
}
const accepted=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.result,JSON.stringify(r.body));assert.notEqual(r.body.result?.isError,true,JSON.stringify(r.body));return r.body.result.structuredContent;};
test('adopted OAuth reads saved verified work through actual hosted single, batch and result tools after cold reopen',async t=>{
 const f=await setup(t),head=f.store.headSequence('commons');
 const brief=accepted(await f.call('room_read_work',{workItemId:'task',brief:true}));
 assert.equal(brief.revision,4);assert.match(brief.brief,/Independent verification/);assert.equal(brief.brief.includes(f.saved.body),false);
 const batch=accepted(await f.call('room_read_work',{workItemIds:['task','other-task'],brief:true}));assert.equal(batch.items.length,2);
 const result=accepted(await f.call('room_read_result',{workItemId:'task'}));assert.ok(JSON.stringify(result).includes(f.saved.body));
 assert.equal(f.store.headSequence('commons'),head);
 await f.reopen();accepted(await f.call('room_read_work',{workItemId:'task',brief:true}));
 const missing=await f.call('room_read_work',{workItemId:'absent',brief:true});assert.ok(missing.body.result?.isError||missing.status===404);
 f.store.identities.revoke(f.saved.identityId,f.saved.identitySecret);
 const denied=await f.call('room_read_work',{workItemId:'task',brief:true});assert.ok(denied.status===401||denied.body.result?.isError);assert.equal(f.store.headSequence('commons'),head);
});

test('selected work reserves records only, retaining an inherited stricter context',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const saved=seedOAuthWorkRead(s);
 s.room=()=>{throw Error('whole-room hydration');};
 const auth={store:s,provider:providerFor(s),token:saved.token,resource,roomId:'commons'};
 let small,large;
 assert.throws(()=>s.readTransaction(()=>withCurrentReadContext(s.db,'commons',b=>{small=b;chargeCurrentReadBudget(b,0,40);return runMcpOAuthRequest(auth,()=>s.workContext(saved.token,'commons','task'));})),e=>e.code==='current_room_context_unavailable');
 s.readTransaction(()=>withCurrentReadContext(s.db,'commons',b=>{large=b;chargeCurrentReadBudget(b,0,40);assert.equal(runMcpOAuthRequest(auth,()=>s.workContext(saved.token,'commons','task')).work.revision,4);},{maxRecords:512}));
 assert.equal(small.records,202);assert.ok(large.records>200&&large.records<=512);assert.ok(large.bytes<=256*1024);
 t.diagnostic(JSON.stringify({failed:{records:small.records,bytes:small.bytes},accepted:{records:large.records,bytes:large.bytes}}));
});

for(const selection of [{latest:true,limit:1},{after:0,limit:1}])test('OAuth message read matches identity '+JSON.stringify(selection),async t=>{
 const f=await setup(t);
 const args={roomId:'commons',...selection};
 const identity=accepted(await f.call('room_read_messages',args,f.saved.identitySecret));
 const oauth=accepted(await f.call('room_read_messages',args));
 assert.deepEqual(oauth,identity);
 if(selection.latest)assert.equal(oauth.messages.at(-1).messageId,'later-11');
});

test('OAuth selected reply request reads remain bounded and private',async t=>{
 const f=await setup(t);
 f.store.command(f.saved.owner,'commons',{id:'question',type:'message.posted',data:{messageId:'question',body:'Please review this',toMemberId:f.saved.identityId,requestKind:'reply'}});
 const args={roomId:'commons',requestMessageId:'question',limit:1};
 const read=accepted(await f.call('room_read_request',args));
 assert.equal(read.request.id,'question');
 assert.equal(read.viewerId,f.saved.identityId);
 assert.equal(read.current.actions.answer,true);
});
