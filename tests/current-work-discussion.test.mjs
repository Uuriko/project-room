import test from 'node:test';
import {request} from 'node:http';
import {readWorkSelection} from '../client/work-preparation.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {client as oauthClient} from './helpers/work-linked-post-oauth.mjs';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {RoomAgentClient} from '../client/room-agent.mjs';
import {seedOAuthWorkRead} from './helpers/oauth-work-read-source.mjs';
import {readCurrentWorkDiscussion} from '../server/current-work-discussion.mjs';

async function fixture(t,{oauth=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'current-discussion-')),filename=join(dir,'room.sqlite');let store=new RoomStore(filename),server,origin;
 const saved=seedOAuthWorkRead(store);
 const open=async()=>{store.room=()=>{throw Error('whole-room hydration');};server=createRoomServer({store,...(oauth?{origin:'https://room.example',mcpOAuthClients:[oauthClient]}:{})});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;};
 const close=async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();};await open();
 t.after(async()=>{await close();rmSync(dir,{recursive:true,force:true});});
 const call=async(flags,token=saved.identitySecret)=>{
  const packet={jsonrpc:'2.0',id:'test',method:'tools/call',params:{name:'room_read_work',arguments:{roomId:'commons',workItemId:'task',...flags}}};
  const {status,body}=await new Promise((resolve,reject)=>{const req=request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,...(oauth?{Host:'room.example'}:{}),'Content-Type':'application/json'}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify(packet));});
  assert.equal(status,200,JSON.stringify(body));assert.ok(body.result,JSON.stringify(body));assert.notEqual(body.result.isError,true,JSON.stringify(body));return body.result.structuredContent;
 };
 return {saved,call,get store(){return store;},get origin(){return origin;},get client(){return new RoomAgentClient({origin,roomId:'commons',token:saved.identitySecret,memberId:saved.identityId});},
  send:(id,data,token=saved.owner)=>store.command(token,'commons',{id,type:'message.posted',data:{messageId:id,...data}}),
  reopen:async()=>{await close();store=new RoomStore(filename);await open();}};
}
const ids=page=>page.discussion.items.map(row=>row.message.id);
async function pages(client,options={}){const out=[];let cursor=null,count=0,page;do{page=await client.workDiscussion('task',{...options,...(cursor?{cursor}:{})});out.push(...page.discussion.items);cursor=page.discussion.nextCursor;assert.ok(++count<100);}while(page.discussion.hasMore);return {out,page,count};}

test('current hosted exact-result +discussion and REST SDK compose without hydration',async t=>{
 const f=await fixture(t),head=f.store.headSequence('commons');
 assert.equal((await f.call({})).work.state,'completed');
 assert.equal((await f.call({includeResult:true})).review.result.text.body,f.saved.body);
 const prepared=await f.call({includeResult:true,includeDiscussion:true});
 assert.equal(prepared.review.result.text.body,f.saved.body);assert.ok(prepared.preparation.discussion.items.some(row=>row.message.id==='saved-result'));
 assert.ok(prepared.preparation.discussion.items.every(row=>!row.message.id.startsWith('later-')));
 await assert.rejects(f.client.workDiscussion('toString'),{code:'work_not_found'});
 const first=await f.client.workDiscussion('task',{limit:25});assert.equal(first.contractVersion,2);assert.ok(ids(first).includes('saved-result'));
 assert.equal(f.store.headSequence('commons'),head);
});

test('bounded empty-more source pages preserve linked descendants and private subtree boundaries',async t=>{
 const f=await fixture(t);
 f.send('hidden-linked',{body:'PRIVATE-SECRET',workItemId:'task',toMemberId:'observer'});
 f.send('private-child',{body:'Inherited private child',replyToId:'hidden-linked'});
 f.send('public-child',{body:'Visible public child',replyToId:'saved-result'});
 f.send('other-work',{body:'Other branch',workItemId:'other-task',replyToId:'saved-result'});
 f.send('other-child',{body:'Not task discussion',replyToId:'other-work'});
 f.send('linked-tail',{body:'Visible linked tail',workItemId:'task'});
 const all=await pages(f.client,{limit:1});
 assert.deepEqual(all.out.map(row=>row.message.id),['saved-result','public-child','linked-tail']);
 assert.equal(new Set(all.out.map(row=>row.message.id)).size,all.out.length);assert.ok(all.count>all.out.length);
 assert.equal(JSON.stringify(all).includes('PRIVATE-SECRET'),false);assert.ok(all.out.every(row=>!['hidden-linked','private-child','other-work','other-child'].includes(row.message.id)));
 assert.equal(all.page.discussion.checkpoint,f.store.headSequence('commons'));
 const first=await f.client.workDiscussion('task',{limit:1});const middle=await f.client.workDiscussion('task',{cursor:first.discussion.nextCursor,limit:1});
 assert.deepEqual(ids(middle),[]);assert.equal(middle.discussion.hasMore,true);assert.equal(middle.discussion.checkpoint,null);
});

test('head, credential, work and service changes invalidate opaque continuation; cold fresh reads remain usable',async t=>{
 const f=await fixture(t),first=await f.client.workDiscussion('task',{consistent:true,limit:1}),cursor=first.discussion.nextCursor;
 assert.equal(first.discussion.consistent,true);assert.ok(cursor);
 assert.throws(()=>f.store.workDiscussion(f.saved.owner,'commons','task',{cursor}),{code:'discussion_reset_required'});
 assert.throws(()=>f.store.workDiscussion(f.saved.identitySecret,'commons','other-task',{cursor}),{code:'discussion_reset_required'});
 f.send('new-unrelated',{body:'New room head'});await assert.rejects(f.client.workDiscussion('task',{cursor}),{code:'discussion_reset_required'});
 const fresh=await f.client.workDiscussion('task',{limit:1});await f.reopen();
 await assert.rejects(f.client.workDiscussion('task',{cursor:fresh.discussion.nextCursor}),{code:'discussion_reset_required'});
 assert.ok(ids(await f.client.workDiscussion('task',{limit:1})).includes('saved-result'));
 f.store.identities.revoke(f.saved.identityId,f.saved.identitySecret);await assert.rejects(f.client.workDiscussion('task'),e=>e.status===401);
});

test('current source anchors, bounded oversized entries and SDK v2 malformed pages retain exact contracts',async t=>{
 const f=await fixture(t);
 f.send('anchor',{body:'Work source anchor'});
 f.store.command(f.saved.owner,'commons',{id:'source-task',type:'work.proposed',data:{workItemId:'source-task',title:'Source task',definitionOfDone:'Source context',accountableMemberId:f.saved.identityId,sourceMessageId:'anchor',independentVerificationRequired:false,ownerDecisionRequired:false}});
 let page,cursor=null;const rows=[];do{page=await f.client.workDiscussion('source-task',{...(cursor?{cursor}:{}),limit:2});rows.push(...page.discussion.items);cursor=page.discussion.nextCursor;}while(page.discussion.hasMore);
 assert.deepEqual(rows.map(row=>[row.message.id,row.relation]),[['anchor','source']]);
 const good=await f.client.workDiscussion('task',{limit:1});
 for(const change of [p=>p.discussion.sourceWindow.complete=true,p=>p.discussion.nextCursor=null,p=>p.discussion.rowBytes++,p=>p.discussion.items[0].message.toMemberId='observer',p=>p.current.workRevision++]){
  const broken=structuredClone(good);change(broken);
  const client=new RoomAgentClient({origin:f.origin,roomId:'commons',token:f.saved.identitySecret,memberId:f.saved.identityId,fetchImpl:async(url,options)=>url.includes('/work-discussion?')?new Response(JSON.stringify(broken),{headers:{'Content-Type':'application/json'}}):fetch(url,options)});
  await assert.rejects(client.workDiscussion('task',{limit:1}),{code:'invalid_response'});
 }
 const before=f.store.headSequence('commons');f.send('oversized',{body:'X'.repeat(65536),workItemId:'task'});
 await assert.rejects(f.client.workDiscussion('task',{since:before}),e=>e.code==='discussion_entry_too_large'||e.code==='current_room_context_unavailable');
 assert.equal(f.store.headSequence('commons'),before+1);
});

test('adopted OAuth hosted combined result/discussion uses the same protected audience',async t=>{
 const f=await fixture(t,{oauth:true});const result=await f.call({includeResult:true,includeDiscussion:true},f.saved.token);
 assert.equal(result.review.result.text.body,f.saved.body);assert.ok(result.preparation.discussion.items.some(row=>row.message.id==='saved-result'));
});

test('since-join protected floor hides earlier source bodies without hydrating exclusion sets',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const events=initialRoom();let at=Date.now();
 const add=(id,type,data)=>events.push(event({id,roomId:'commons',actorId:'owner',type,data,at:new Date(at+=1000).toISOString()}));
 add('history','room.history_visibility_set',{historyVisibility:'since_join'});
 add('old','message.posted',{messageId:'old',body:'PREJOIN-SECRET'});
 add('reader','member.added',{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]});
 add('task','work.proposed',{workItemId:'task',title:'Selected',definitionOfDone:'Read',accountableMemberId:'reader',sourceMessageId:'old',independentVerificationRequired:false,ownerDecisionRequired:false});
 add('fresh','message.posted',{messageId:'fresh',body:'Visible after join',workItemId:'task'});
 s.initialize(events,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','reader');s.room=()=>{throw Error('Whole-room hydration');};
 const result=readCurrentWorkDiscussion(s,key,'commons','task');assert.deepEqual(ids(result),['fresh']);assert.equal(JSON.stringify(result).includes('PREJOIN-SECRET'),false);
});

test('current preparation keeps incomplete tails and refuses a changed or withdrawn result packet',async t=>{
 const f=await fixture(t);
 for(let i=0;i<16;i++)f.send('extra-'+i,{body:'Unrelated authorized conversation'});
 const prepared=await readWorkSelection(f.client,{workItemId:'task',includeResult:true,includeDiscussion:true});
 assert.equal(prepared.preparation.discussion.hasMore,true);assert.equal(prepared.preparation.discussion.checkpoint,null);
 assert.equal(prepared.preparation.nextRead.tool,'room_read_work_discussion');assert.equal(prepared.review.result.text.body,f.saved.body);
 const changing=f.client,discussion=changing.workDiscussion.bind(changing);let changed=false;
 changing.workDiscussion=async(...args)=>{const result=await discussion(...args);if(!changed){changed=true;f.send('interleaved',{body:'Room changed between pages'});}return result;};
 await assert.rejects(readWorkSelection(changing,{workItemId:'task',includeDiscussion:true}),{code:'discussion_reset_required'});
 const client=f.client,result=client.workResult.bind(client);
 client.workResult=async(...args)=>{const value=await result(...args);f.store.command(f.saved.owner,'commons',{id:'erase-result',type:'message.deleted',data:{messageId:'saved-result',expectedMessageRevision:0}});return value;};
 await assert.rejects(readWorkSelection(client,{workItemId:'task',includeResult:true}),{code:'review_changed'});
 const after=await pages(f.client);assert.equal(after.out.some(row=>row.message.id==='saved-result'),false);assert.equal(JSON.stringify(after).includes(f.saved.body),false);
});

test('a failed bounded read does not consume a cursor or write progress',async t=>{
 const f=await fixture(t),first=await f.client.workDiscussion('task',{limit:1}),head=f.store.headSequence('commons'),cursor=first.discussion.nextCursor;
 const prepare=f.store.db.prepare.bind(f.store.db);let fired=false;
 f.store.db.prepare=sql=>{if(!fired&&sql.includes('INDEXED BY current_messages_public_seq')){fired=true;throw Error('Synthetic discussion read fault');}return prepare(sql);};
 try{assert.throws(()=>f.store.workDiscussion(f.saved.identitySecret,'commons','task',{cursor,limit:1}),/Synthetic discussion read fault/);}finally{f.store.db.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(ids(await f.client.workDiscussion('task',{cursor,limit:1})),[]);assert.equal(f.store.headSequence('commons'),head);
});

test('historical maximum CJK/control openings use projected metadata; raw prefix stops before the next opening',async t=>{
 const {historicalDiscussionEvents}=await import('./helpers/current-discussion-large-openings.mjs');
 const s=new RoomStore(':memory:');t.after(()=>s.close());const source=historicalDiscussionEvents();s.initialize(source.events,{representation:'normalized-current-v1'});
 const token=s.issueAccessKey('commons','reader');s.room=()=>{throw Error('Whole-room hydration');};
 const prepare=s.db.prepare.bind(s.db);let obsoleteTextTransferred=false;
 s.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const value=Reflect.get(target,key,target);if(!['get','all'].includes(key))return typeof value==='function'?value.bind(target):value;return(...args)=>{const result=value.apply(target,args);for(const row of key==='all'?result:[result])for(const cell of Object.values(row??{}))if(typeof cell==='string'&&(cell.includes('界'.repeat(100))||cell.includes('\\u0001'.repeat(100))))obsoleteTextTransferred=true;return result;};}});
 let page=s.workDiscussion(token,'commons','task',{since:source.since,limit:25});
 assert.deepEqual(ids(page),['cjk']);assert.equal(page.discussion.hasMore,true);assert.equal(page.discussion.checkpoint,null);
 const firstCursor=page.discussion.nextCursor;
 page=s.workDiscussion(token,'commons','task',{cursor:firstCursor,limit:25});assert.deepEqual(ids(page),['control']);assert.equal(page.discussion.hasMore,true);
 page=s.workDiscussion(token,'commons','task',{cursor:page.discussion.nextCursor,limit:25});assert.deepEqual(ids(page),['tail']);assert.equal(page.discussion.hasMore,false);
 assert.equal(obsoleteTextTransferred,false);assert.equal(JSON.stringify(page).includes('Current private'),false);
 const again=s.workDiscussion(token,'commons','task',{cursor:firstCursor,limit:25});assert.deepEqual(ids(again),['control']);
});
