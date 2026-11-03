import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';
import {createRoomServer} from '../server/http.mjs';
import {RoomAgentClient} from '../client/room-agent.mjs';
import {serveRoomMcp,MCP_VERSION} from '../client/mcp-stdio.mjs';
import {PassThrough} from 'node:stream';
import {readWorkItem} from '../server/work-repository.mjs';
import {textVersion} from '../server/text-results.mjs';

function fixture(t,filename=':memory:') {
  const store=new RoomStore(filename);t.after(()=>{try{store.close();}catch{}});const events=initialRoom();
  const add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
  for(const id of ['worker','other'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:[]});
  for(let i=0;i<19;i++)add('work.proposed',{workItemId:'task-'+String(i).padStart(2,'0'),title:'Title '+i,definitionOfDone:'NO-DEFINITION-BLOB',accountableMemberId:i===18?'worker':'other'});
  for(let i=0;i<13;i++)add('message.posted',{messageId:'request-'+String(i).padStart(2,'0'),toMemberId:i===12?'worker':'other',requestKind:'reply',requestPolicyVersion:1,body:'NO-REQUEST-BODY'});
  store.initialize(events,{representation:'normalized-current-v1'});
  const keys=Object.fromEntries(['owner','worker','other'].map(id=>[id,store.issueAccessKey('commons',id)]));
  store.room=()=>{throw Error('whole-room hydration');};store.snapshot=()=>{throw Error('full snapshot');};
  return {store,keys};
}
function pages(store,key,args={}) {
  const result=[];let page=store.currentWorkListing(key,'commons',args);
  for(let n=0;n<20;n++) {result.push(page);if(!page.page.nextRead)return result;page=store.currentWorkListing(key,'commons',page.page.nextRead.arguments);}
  throw Error('nonterminating work pages');
}
test('current work source pages traverse excluded backlog without false completion or hydration',t=>{
  const {store,keys}=fixture(t),listed=pages(store,keys.worker,{focus:'needs_me',limit:100});
  assert.deepEqual(listed[0].work.map(item=>item.id),['task-18']);
  assert.deepEqual(listed[0].scope,{kind:'room',permissions:[],externalExecution:false});
  assert.deepEqual(listed[0].replyRequests.map(item=>item.id),['request-12']);
  assert.equal(listed[0].selection.source,'addressed-role-indexes');
  assert.equal(listed[0].page.hasMore,false);
  assert.deepEqual(listed.flatMap(x=>x.work.map(w=>w.id)),['task-18']);
  assert.deepEqual(listed.flatMap(x=>x.replyRequests.map(r=>r.id)),['request-12']);
  assert.ok(listed.every(x=>x.selection.examinedWork<=4&&x.selection.examinedRequests<=4&&x.page.totalWork===null));
  for(const page of listed)if(page.page.nextCursor)assert.equal(Buffer.from(page.page.nextCursor,'base64url').toString('utf8').includes('request-'),false,'excluded private request keys must not be readable cursor payloads');
  assert.equal(JSON.stringify(listed).includes('NO-DEFINITION-BLOB'),false);assert.equal(JSON.stringify(listed).includes('NO-REQUEST-BODY'),false);
  const all=pages(store,keys.worker);assert.equal(all.flatMap(p=>p.work).length,19);assert.equal(new Set(all.flatMap(p=>p.work.map(w=>w.id))).size,19);
  const audit=store.db.prepare('SELECT * FROM operator_actions ORDER BY id').all();pages(store,keys.worker);assert.deepEqual(store.db.prepare('SELECT * FROM operator_actions ORDER BY id').all(),audit);
});
test('work continuation binds credential, selection, head, and requested limit',t=>{
  const {store,keys}=fixture(t),first=store.currentWorkListing(keys.worker,'commons',{limit:2}),args=first.page.nextRead.arguments;
  assert.throws(()=>store.currentWorkListing(keys.other,'commons',args),e=>e.code==='invalid_work_cursor');
  assert.throws(()=>store.currentWorkListing(keys.worker,'commons',{...args,focus:'results'}),e=>e.code==='stale_work_cursor');
  assert.throws(()=>store.currentWorkListing(keys.worker,'commons',{...args,limit:1}),e=>e.code==='stale_work_cursor');
  assert.throws(()=>store.currentWorkListing(keys.worker,'commons',{...args,cursor:args.cursor+'x'}),e=>e.code==='invalid_work_cursor');
  store.command(keys.owner,'commons',{id:'change-head',type:'message.posted',data:{messageId:'change-head',body:'A new observation'}});
  assert.throws(()=>store.currentWorkListing(keys.worker,'commons',args),e=>e.code==='stale_work_cursor');
});
test('unsupported global selections refuse instead of silently searching one page',t=>{
  const {store,keys}=fixture(t);
  for(const args of [{query:'Title'},{sort:'curiosity'}])assert.throws(()=>store.currentWorkListing(keys.worker,'commons',args),e=>e.code==='current_work_selection_unavailable');
});
test('work source pages retain private title boundaries for an unrelated viewer',t=>{
  const {store,keys}=fixture(t);
  store.command(keys.owner,'commons',{id:'private-work-request',type:'message.posted',data:{messageId:'private-work-request',toMemberId:'other',workItemId:'task-00',requestKind:'reply',body:'A private task question'}});
  const hidden=pages(store,keys.worker).flatMap(p=>p.work).find(w=>w.id==='task-00');assert.equal(hidden.title,null);
  assert.equal(pages(store,keys.other).flatMap(p=>p.work).find(w=>w.id==='task-00').title,'Title 0');
});

test('hosted MCP room_list_work uses the actual current source pager',async t=>{
  const {store}=fixture(t),identity=store.identities.create('Worker listing');
  // Synthetic identity-seat binding, not invitation/onboarding qualification.
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',identity.identityId,'worker',new Date(store.now()).toISOString());
  const handler=createHostedRoomMcp(store),read=args=>handler({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'room_list_work',arguments:{roomId:'commons',...args}}},{authorization:'Bearer '+identity.secret});
  let response=await read({focus:'needs_me'});assert.ok(!response.error,JSON.stringify(response));assert.ok(!response.result.isError,JSON.stringify(response));
  const ids=[],requests=[];
  for(let n=0;n<10;n++){const page=response.result.structuredContent;ids.push(...page.work.map(w=>w.id));requests.push(...page.replyRequests.map(r=>r.id));if(!page.page.nextRead)break;response=await read(page.page.nextRead.arguments);assert.ok(!response.result.isError,JSON.stringify(response));}
  assert.deepEqual(ids,['task-18']);assert.deepEqual(requests,['request-12']);
});

test('SDK and stdio traverse the same HTTP source pages and reject another room before I/O',async t=>{
  const {store,keys}=fixture(t),server=createRoomServer({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  let sent=0;const client=new RoomAgentClient({origin:'http://127.0.0.1:'+server.address().port,roomId:'commons',memberId:'worker',token:keys.worker,fetchImpl:(...args)=>{sent++;return fetch(...args);}});
  let page=await client.orient({paginate:true,focus:'needs_me'}),ids=[],requests=[];
  for(let i=0;i<10;i++){ids.push(...page.work.map(w=>w.id));requests.push(...page.replyRequests.map(r=>r.id));if(!page.page.nextRead)break;page=await client.orient({paginate:true,...page.page.nextRead.arguments});}
  assert.deepEqual(ids,['task-18']);assert.deepEqual(requests,['request-12']);
  const input=new PassThrough(),output=new PassThrough(),pending=new Map();let buffer='',serial=0;
  const mcp=serveRoomMcp({client,roomId:'commons',memberId:'worker',input,output});t.after(()=>{mcp.stop();input.destroy();output.destroy();});
  output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const r=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(r.id)?.(r);pending.delete(r.id);}});
  const rpc=(method,params)=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await rpc('initialize',{protocolVersion:MCP_VERSION,capabilities:{},clientInfo:{name:'work-test',version:'1'}});input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  let pointer={tool:'room_list_work',arguments:{}},all=[];
  for(let i=0;i<10;i++){const r=await rpc('tools/call',{name:pointer.tool,arguments:pointer.arguments});assert.ok(!r.error,JSON.stringify(r));assert.ok(!r.result.isError,JSON.stringify(r));all.push(...r.result.structuredContent.work.map(w=>w.id));pointer=r.result.structuredContent.page.nextRead;if(!pointer)break;}
  assert.equal(all.length,19);assert.equal(new Set(all).size,19);
  const before=sent,wrong=await rpc('tools/call',{name:'room_list_work',arguments:{roomId:'another'}});assert.equal(wrong.error.code,-32602);assert.equal(sent,before);
  await assert.rejects(()=>client.orient({paginate:true,query:'Title'}),e=>e.code==='current_work_selection_unavailable');
});

test('results listing resolves canonical native completion pointers rather than thin summary inference',t=>{
  const {store,keys}=fixture(t);let serial=0;const send=(type,data)=>store.command(keys.owner,'commons',{id:'result-'+(++serial),type,data});
  send('work.proposed',{workItemId:'000-result',title:'Useful result',definitionOfDone:'Saved',accountableMemberId:'owner'});
  const item=()=>readWorkItem(store.db,'commons','000-result');
  for(const type of ['work.accepted','work.started'])send(type,{workItemId:'000-result',expectedRevision:item().revision});
  const body='Saved native result',posted=send('message.posted',{messageId:'native-result',body,workItemId:'000-result'});
  const completed=send('work.completed',{workItemId:'000-result',expectedRevision:item().revision,evidenceKind:'room_text',evidenceMessageId:'native-result',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Saved',nextAction:'Review'});
  const listed=pages(store,keys.worker,{focus:'results'}).flatMap(p=>p.work);assert.equal(listed.length,1);assert.equal(listed[0].result.kind,'room_text');assert.equal(listed[0].nextResultRead.arguments.completionEventId,completed.event.id);
});
import {createHash,createDecipheriv} from 'node:crypto';
function decryptAsCredentialHolder(token,secret){const bytes=Buffer.from(token,'base64url'),key=createHash('sha256').update('current-work-source-v1:'+secret).digest(),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8'));}
test('an actual credential holder cannot decrypt work or addressed-request continuations',t=>{
 const {store,keys}=fixture(t);
 store.command(keys.owner,'commons',{id:'extra-private-request',type:'message.posted',data:{messageId:'zz-second-request',requestKind:'reply',toMemberId:'worker',body:'Private second obligation'}});
 for(const focus of ['all','needs_me']) {
  const first=store.currentWorkListing(keys.worker,'commons',{focus,limit:1});
  assert.ok(first.page.nextCursor);
  // Only decryption occurs inside this assertion: a later payload expectation
  // must never accidentally make successful credential-derived decryption pass.
  assert.throws(()=>decryptAsCredentialHolder(first.page.nextCursor,keys.worker));
 }
});

import {mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
test('work cursor rejects exact cold restart and a different credential for the same member',t=>{const directory=mkdtempSync(join(tmpdir(),'work-cursor-cold-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const filename=join(directory,'room.sqlite'),{store,keys}=fixture(t,filename),first=store.currentWorkListing(keys.worker,'commons',{focus:'all'}),otherIdentity=store.identities.create('Same worker credential');store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',otherIdentity.identityId,'worker',new Date(store.now()).toISOString());const secondKey=otherIdentity.secret;assert.equal(store.authenticate(secondKey,'commons').member.id,'worker');assert.throws(()=>store.currentWorkListing(secondKey,'commons',first.page.nextRead.arguments),e=>e.code==='invalid_work_cursor');store.close();const cold=new RoomStore(filename);t.after(()=>cold.close());assert.throws(()=>cold.currentWorkListing(keys.worker,'commons',first.page.nextRead.arguments),e=>e.code==='invalid_work_cursor'&&/restart/i.test(e.message));assert.equal(cold.currentWorkListing(keys.worker,'commons',{focus:'needs_me'}).workScope,'bounded_source_window');});
