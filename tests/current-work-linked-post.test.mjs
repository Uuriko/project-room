import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {readCurrentMessage} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {seedPostOAuth,client} from './helpers/work-linked-post-oauth.mjs';
async function setup(t,options){
 const dir=mkdtempSync(join(tmpdir(),'work-linked-post-')),filename=join(dir,'room.sqlite');let store=new RoomStore(filename),now=store.now();store.now=()=>now;
 const saved=seedPostOAuth(store,options);let server,base;
 const open=async()=>{store.room=()=>{throw Error('whole-room hydration');};server=createRoomServer({store,origin:'https://room.example',mcpOAuthClients:[client]});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;};
 const close=async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();};await open();
 t.after(async()=>{await close();rmSync(dir,{recursive:true,force:true});});
 const post=(args,token=saved.token)=>new Promise((resolve,reject)=>{now+=3000;const req=request(base+'/mcp',{method:'POST',headers:{Host:'room.example','Content-Type':'application/json',Authorization:'Bearer '+token}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:'test',method:'tools/call',params:{name:'room_post_message',arguments:args}}));});
 return {get store(){return store;},saved,post,reopen:async()=>{await close();store=new RoomStore(filename);store.now=()=>now;await open();}};
}
const accepted=response=>{assert.equal(response.status,200);assert.notEqual(response.body.result?.isError,true,JSON.stringify(response.body));return response.body.result.structuredContent;};
const snapshot=s=>JSON.stringify(Object.fromEntries(['rooms','events','commands','current_room_records','current_room_record_proofs','current_room_head','operator_actions'].map(table=>[table,s.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()])));
test('five-member adopted OAuth saves plain and work-linked posts; cold exact retry and revocation preserve authority',async t=>{
 const f=await setup(t);accepted(await f.post({id:'plain',body:'Plain result'}));
 const input={id:'linked',messageId:'linked',body:'x'.repeat(1648),workItemId:'task'},first=accepted(await f.post(input));
 assert.equal(first.event.data.workItemId,'task');assert.equal(first.event.actorId,f.saved.identityId);
 const before=snapshot(f.store);assert.equal(accepted(await f.post(input)).duplicate,true);assert.equal(snapshot(f.store),before);
 await f.reopen();const cold=accepted(await f.post(input));assert.equal(cold.duplicate,true);assert.equal(cold.sequence,first.sequence);
 assert.equal(f.store.readTransaction(()=>readCurrentMessage(f.store.db,'commons','linked').value.body),input.body);
 assert.ok(Buffer.byteLength(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection)<512);
 assert.doesNotThrow(()=>auditRecovery(f.store));
 f.store.identities.revoke(f.saved.identityId,f.saved.identitySecret);const head=f.store.headSequence('commons'),denied=await f.post(input);assert.ok(denied.status===401||denied.body.result?.isError);assert.equal(f.store.headSequence('commons'),head);
});
test('work-linked OAuth fault rolls back and exact retry saves once; bounded ancestry admits useful replies',async t=>{
 const f=await setup(t),input={id:'faulted',messageId:'faulted',body:'Saved after failure',workItemId:'task'},before=snapshot(f.store),prepare=f.store.db.prepare.bind(f.store.db);let fired=false;
 f.store.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const result=fn.apply(target,args);if(/^INSERT INTO current_room_head/.test(sql)){fired=true;throw Error('post save fault');}return result;};}});
 try{const failed=await f.post(input);assert.equal(failed.body.result?.isError,true);}finally{f.store.db.prepare=prepare;}
 assert.equal(fired,true);assert.equal(snapshot(f.store),before);accepted(await f.post(input));

 for(let i=0;i<3;i++)f.store.command(f.saved.owner,'commons',{id:'ancestor-'+i,type:'message.posted',data:{messageId:'ancestor-'+i,body:'D'.repeat(35000),...(i?{replyToId:'ancestor-'+(i-1)}:{})}});
 const head=f.store.headSequence('commons'),reply={id:'oversized',body:'Result',workItemId:'task',replyToId:'ancestor-2'},large=accepted(await f.post(reply));
 assert.equal(large.event.data.replyToId,'ancestor-2');assert.equal(large.event.data.workItemId,'task');assert.equal(f.store.headSequence('commons'),head+1);
 assert.equal(accepted(await f.post(reply)).duplicate,true);assert.equal(f.store.headSequence('commons'),head+1);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM commands WHERE id='oversized'").get().n,1);
});
