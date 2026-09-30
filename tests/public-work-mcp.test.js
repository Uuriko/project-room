// Exercises server/mcp-public-work.mjs through the actual hosted HTTP boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { PUBLIC_WORK_MCP_TOOLS } from '../src/room-mcp-join.js';

async function fixture(t) {
 const store = new RoomStore(':memory:'); store.initialize(initialRoom());
 store.projectOffers.create('commons','owner',{requestId:'create',offerId:'mcp:task',reviewerMemberIds:['owner'],terms:{kind:'task',title:'JavaScript volunteer task',summary:'Synthetic public work',acceptanceCriteria:['Return exact bytes'],repositoryUrl:'https://github.com/example/project',reward:{kind:'unpaid'},approvalPolicy:{mode:'human'}}});
 store.projectOffers.transition('commons','owner','mcp:task','publish',{requestId:'publish',expectedRevision:1});
 store.publicWorkClaims.enable('commons','owner','mcp:task',{requestId:'enable',expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:['result.js']});
 const first=store.identities.create('Synthetic MCP one'),second=store.identities.create('Synthetic MCP two');
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const rpc=async(message,secret,path='/mcp')=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})},body:JSON.stringify(message)});return {status:response.status,body:response.status===202?null:await response.json()};};
 const call=(name,args={},secret)=>rpc({jsonrpc:'2.0',id:'transport-id',method:'tools/call',params:{name,arguments:args}},secret);
 return {store,server,origin,first,second,rpc,call};
}
const value=reply=>{assert.ok(!reply.body.error,JSON.stringify(reply.body));assert.ok(!reply.body.result.isError,JSON.stringify(reply.body));return reply.body.result.structuredContent;};
const state=store=>JSON.stringify(['work_claims','public_work_requests','public_work_receipts','identity_links','bounty_journal','public_work_claim_writer_permit'].map(name=>store.db.prepare('SELECT * FROM '+name).all()));
const claim={taskId:'mcp:task',requestId:'claim',expectedTermsVersion:1};

test('actual MCP anonymous recommendations and task reads discover auth without writing or room enrollment',async t=>{
 const f=await fixture(t),before=state(f.store);
 const listed=await f.rpc({jsonrpc:'2.0',id:1,method:'tools/list'});
 assert.deepEqual(listed.body.result.tools.map(tool=>tool.name),['room_join_packet','room_join_kits','room_join_prompt','room_mcp_snippet','public_work_recommend','public_work_read_task']);
 const recommendation=value(await f.call('public_work_recommend',{skills:['JavaScript']}));assert.equal(recommendation.claim,null);assert.equal(recommendation.recommendations[0].task.taskId,'mcp:task');
 assert.equal(value(await f.call('public_work_read_task',{taskId:'mcp:task'})).claim.state,'unclaimed');
 const unauthorized=await f.call('public_work_claim',claim);assert.equal(unauthorized.body.error.code,-32001);
 assert.equal(state(f.store),before);
 for(const name of ['room_join_packet','room_join_kits','room_join_prompt','room_mcp_snippet'])assert.ok((await f.call(name)).body.result.content.length);
 const all=await f.rpc({jsonrpc:'2.0',id:2,method:'tools/list'},f.first.secret);assert.ok(PUBLIC_WORK_MCP_TOOLS.every(name=>all.body.result.tools.some(tool=>tool.name===name)));
 assert.equal(all.body.result.tools.find(tool=>tool.name==='public_work_claim')._meta.authorization,'saved-identity-secret');
 const bad=await f.call('public_work_recommend',{},f.first.secret.slice(0,-1)+(f.first.secret.endsWith('a')?'b':'a'));assert.equal(bad.status,401);assert.equal(bad.body.error.code,-32001);assert.equal(state(f.store),before);
 const badRead=await f.call('public_work_read_task',{taskId:'mcp:task'},f.first.secret.slice(0,-1)+(f.first.secret.endsWith('a')?'b':'a'));assert.equal(badRead.status,401);assert.equal(badRead.body.error.code,-32001);
});

test('actual outside MCP claim/renew/release/finish and own feedback reuse HTTP receipts and preserve zero membership/credits',async t=>{
 const f=await fixture(t),credits=f.store.db.prepare('SELECT * FROM bounty_journal').all();
 const claimed=value(await f.call('public_work_claim',claim,f.first.secret));assert.deepEqual(value(await f.call('public_work_claim',claim,f.first.secret)),claimed);
 const httpClaim={requestId:claim.requestId,expectedTermsVersion:claim.expectedTermsVersion};
 const httpRetry=await fetch(f.origin+'/api/public-work/tasks/'+encodeURIComponent(claim.taskId)+'/claim',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.first.secret},body:JSON.stringify(httpClaim)});
 assert.equal(httpRetry.status,200);assert.deepEqual(await httpRetry.json(),claimed,'HTTP and MCP share the exact persisted request outcome');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM public_work_requests WHERE actor_id=? AND request_id=?').get(f.first.identityId,claim.requestId).n,1);
 const competing=await f.call('public_work_claim',{...claim,requestId:'competitor'},f.second.secret);assert.equal(competing.body.result.structuredContent.code,'public_work_claim_conflict');
 const bound={taskId:'mcp:task',expectedTermsVersion:1,generation:1};
 const renewed=value(await f.call('public_work_renew',{...bound,requestId:'renew',leaseHours:0.5},f.first.secret));assert.deepEqual(value(await f.call('public_work_renew',{...bound,requestId:'renew',leaseHours:0.5},f.first.secret)),renewed);
 value(await f.call('public_work_release',{...bound,requestId:'release'},f.first.secret));
 const reclaimed=value(await f.call('public_work_claim',{...claim,requestId:'claim-again'},f.first.secret));assert.equal(reclaimed.task.claim.generation,2);
 const stale=await f.call('public_work_finish',{...bound,requestId:'stale-finish',artifactText:'stale',checksReported:[]},f.first.secret);assert.equal(stale.body.result.structuredContent.code,'stale_public_claim');
 const finish={...bound,generation:2,requestId:'finish',artifactText:'Result ✓',checksReported:['Producer-reported check']};
 const completed=value(await f.call('public_work_finish',finish,f.first.secret));assert.deepEqual(value(await f.call('public_work_finish',finish,f.first.secret)),completed);
 assert.equal(completed.receipt.verification,'hash_only');assert.equal(completed.receipt.state,'submitted');
 const receipt=await fetch(f.origin+'/api/public-work/receipts/'+completed.receipt.receiptId);assert.deepEqual(await receipt.json(),completed.receipt);
 const artifact=await fetch(f.origin+'/api/public-work/receipts/'+completed.receipt.receiptId+'/artifact');const bytes=Buffer.from(await artifact.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),completed.receipt.artifact.sha256);
 f.store.publicWorkReviews.decide('commons','owner',completed.receipt.receiptId,{requestId:'owner-accept',expectedReviewRevision:0,taskId:'mcp:task',expectedTermsVersion:1,generation:2,artifactSha256:completed.receipt.artifact.sha256,decision:'accepted',reason:'Public contributor feedback'});
 const feedback=value(await f.call('public_work_my_review',{receiptId:completed.receipt.receiptId},f.first.secret));assert.equal(feedback.review.state,'accepted');assert.equal(feedback.review.reason,'Public contributor feedback');assert.equal(JSON.stringify(feedback).includes('roomId'),false);assert.equal(JSON.stringify(feedback).includes('actorId'),false);
 const denied=await f.call('public_work_my_review',{receiptId:completed.receipt.receiptId},f.second.secret);assert.equal(denied.body.result.structuredContent.status,404);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM identity_links').get().n,0);assert.deepEqual(f.store.db.prepare('SELECT * FROM bounty_journal').all(),credits);assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled,0);
 const changed=await f.call('public_work_finish',{...finish,artifactText:'changed'},f.first.secret);assert.equal(changed.body.result.structuredContent.code,'request_id_reused');
});

test('strict MCP schemas reject excessive arguments and notifications never mutate',async t=>{
 const f=await fixture(t),before=state(f.store);
 for(const [name,args] of [['public_work_recommend',{autoClaim:true}],['public_work_recommend',{skills:Array(21).fill('x')}],['public_work_claim',{...claim,roomId:'commons'}],['public_work_claim',{...claim,secret:'unchecked'}],['public_work_claim',{...claim,leaseHours:0}],['public_work_read_task',null]]){
  const reply=await f.call(name,args,f.first.secret);assert.equal(reply.body.error.code,-32602,JSON.stringify(reply));
 }
 const notification=await f.rpc({jsonrpc:'2.0',method:'tools/call',params:{name:'public_work_claim',arguments:claim}},f.first.secret);assert.equal(notification.status,202);
 const malformed=await f.rpc({jsonrpc:'1.0',id:3,method:'tools/call',params:{name:'public_work_claim',arguments:claim}},f.first.secret);assert.equal(malformed.body.error.code,-32600);
 assert.equal(state(f.store),before);
});

test('credential revoked while MCP body uploads cannot claim even with a saved prior connection',async t=>{
 const f=await fixture(t),payload=JSON.stringify({jsonrpc:'2.0',id:'held',method:'tools/call',params:{name:'public_work_claim',arguments:claim}});
 let arrival;const arrived=new Promise(resolve=>{arrival=resolve;});f.server.once('request',arrival);let connection;
 const result=new Promise((resolve,reject)=>{connection=request(f.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),Authorization:'Bearer '+f.first.secret}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});connection.on('error',reject);connection.write(payload.slice(0,10));});
 await arrived;f.store.identities.revoke(f.first.identityId,f.first.secret);connection.end(payload.slice(10));
 const reply=await result;assert.equal(reply.status,401);assert.equal(reply.body.error.code,-32001);assert.equal(f.store.publicWorkClaims.read('mcp:task').claim.state,'unclaimed');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM public_work_requests WHERE actor_id=?").get(f.first.identityId).n,0);
});

test('maximum legal escaped UTF-8 artifact and checks fit the actual hosted MCP transport',async t=>{
 const f=await fixture(t);value(await f.call('public_work_claim',claim,f.first.secret));
 const artifactText='\0'.repeat(65536),checksReported=Array.from({length:20},()=> '\0'.repeat(1000));
 const completed=value(await f.call('public_work_finish',{taskId:'mcp:task',requestId:'max-finish',expectedTermsVersion:1,generation:1,artifactText,checksReported},f.first.secret));assert.equal(completed.receipt.artifact.bytes,65536);
 assert.equal(f.store.publicWorkClaims.artifact(completed.receipt.receiptId).artifactText,artifactText);
});

test('an unrelated scoped guest membership cannot disable public contribution authority or grant private room writes',async t=>{
 const f=await fixture(t),guest='guest-agent-outside';
 const room=f.store.room('commons').state;room.members[guest]={id:guest,displayName:'Unrelated guest',kind:'agent',active:true,permissions:[]};
 f.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(room),'commons');
 f.store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',f.first.identityId,guest,Date.now());
 const list=await f.rpc({jsonrpc:'2.0',id:1,method:'tools/list',params:{focus:'public_work'}},f.first.secret);assert.ok(list.body.result.tools.some(tool=>tool.name==='public_work_claim'));const roomCatalog=await f.rpc({jsonrpc:'2.0',id:2,method:'tools/list'},f.first.secret);assert.ok(!roomCatalog.body.result.tools.some(tool=>tool.name==='room_put_file'));
 value(await f.call('public_work_claim',claim,f.first.secret));
 const roomWrite=await f.call('room_put_file',{roomId:'commons',id:'private-write',filename:'private.txt',mediaType:'text/plain',data:Buffer.from('private').toString('base64')},f.first.secret);assert.equal(roomWrite.body.result.structuredContent.status,403);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM identity_links').get().n,1);
});

test('catalog selection uses live usable membership, preserves Room core size and exposes an explicit stateless public-work focus',async t=>{
 const f=await fixture(t),room=f.store.room('commons').state,member='outside-member';
 room.members[member]={id:member,displayName:'Outside member',kind:'agent',active:true,permissions:['read']};f.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(room),'commons');f.store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',f.first.identityId,member,Date.now());
 const list=params=>f.rpc({jsonrpc:'2.0',id:1,method:'tools/list',...(params?{params}:{})},f.first.secret);
 const normal=(await list()).body;assert.ok(normal.result.tools.some(tool=>tool.name==='room_needs_me'));assert.ok(!normal.result.tools.some(tool=>tool.name==='public_work_claim'));assert.ok(Buffer.byteLength(JSON.stringify(normal))<16384);
 const publicFocus=(await list({focus:'public_work'})).body;assert.deepEqual(publicFocus.result.tools.map(tool=>tool.name),['room_join_packet','room_join_kits','room_join_prompt','room_mcp_snippet',...PUBLIC_WORK_MCP_TOOLS]);assert.ok(Buffer.byteLength(JSON.stringify(publicFocus))<16384);
 assert.deepEqual((await list()).body.result.tools,normal.result.tools);
 room.members[member].active=false;f.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(room),'commons');
 const inactive=(await list()).body;assert.deepEqual(inactive.result.tools.map(tool=>tool.name),publicFocus.result.tools.map(tool=>tool.name));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM identity_links').get().n,1,'inactive link remains but is not authority');
});
