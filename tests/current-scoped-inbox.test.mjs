import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';import {createRoomServer} from '../server/http.mjs';
import {withCurrentReadContext} from '../server/current-room-repository.mjs';import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
async function fixture(t){const directory=mkdtempSync(join(tmpdir(),'scoped-inbox-')),filename=join(directory,'room.sqlite');let s=new RoomStore(filename);const saved=seedScopedInbox(s);let server,origin;const open=async()=>{s.room=()=>{throw Error('whole-room hydration');};server=createRoomServer({store:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;},close=async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();};await open();t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});return{get s(){return s;},saved,rpc:async(method,params)=>{const r=await fetch(origin+"/room/mcp",{method:"POST",headers:{authorization:"Bearer "+saved.token,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"pointer",method,params})});return r.json();},readPointer:async pointer=>{assert.equal(pointer.tool,'room_read_inbox');const {roomId,...query}=pointer.arguments;assert.equal(roomId,'commons');const response=await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/agent-inbox?${new URLSearchParams(query)}`,{headers:{authorization:'Bearer '+saved.token}});return{status:response.status,value:await response.json()};},read:async(limit,after=saved.after,token=saved.token)=>{const response=await fetch(`${origin}/api/rooms/commons/agent-inbox?limit=${limit}&after=${after}`,{headers:{authorization:'Bearer '+token}});return{status:response.status,value:await response.json()};},reopen:async()=>{await close();s=new RoomStore(filename);await open();}};}
function ids(page){return Object.fromEntries(['directMessages','directMentions','replies','replyRequests','nativeWork'].map(key=>[key,(page[key]??[]).map(row=>row.messageId??row.id)]));}
test('actual five-scope API-key HTTP inbox traverses overlapping obligations without leaks/duplicates and survives cold reopen',async t=>{
 const f=await fixture(t);for(const limit of [1,5,30]){const r=await f.read(limit);assert.equal(r.status,200,JSON.stringify(r.value));}
 const acp=f.s.agentPlugin.issueApiKey({identityId:f.saved.identityId,scopes:['mcp:room:commons','rooms:read','rooms:write','heartbeats:report','heartbeats:read'],expiresAt:f.s.now()+3600000});assert.equal((await f.read(5,42,'rak_'+acp.secret)).value.error.code,'insufficient_scope');
 const expected={directMessages:['dm','overlap'],directMentions:['mention','dm','reply','overlap'],replies:['reply','overlap'],replyRequests:['dm'],nativeWork:['waiting']};
 const first=(await f.read(5)).value;assert.deepEqual(ids(first),expected);
 assert.equal(f.s.headSequence('commons'),47);assert.equal(first.cursor.after,47);assert.equal(first.cursor.hasMore,false);assert.equal(first.cursor.nextRead,null);assert.equal(first.attention.nextRead,null);
 assert.equal(first.next.find(x=>x.action==='continue-conversation'),undefined);
 assert.equal(first.coverage.standingMentions.complete,false);assert.equal(first.coverage.standingMentions.nextRead.arguments.roomId,'commons');assert.equal(first.coverage.globalAttentionComplete,false);
 // A verified skip can consume unrelated47 at limit5. Use an actually partial
 // limit1 page to exercise the emitted continuation, without fabricating after.
 let page=(await f.read(1)).value;assert.equal(page.cursor.hasMore,true);
 for(const next of [page.cursor.nextRead,page.attention.nextRead,page.next.find(x=>x.action==='continue-conversation').nextRead,page.coverage.standingMentions.nextRead])assert.equal(next.arguments.roomId,'commons');
 const collected={directMessages:[],directMentions:[],replies:[]};let pages=0;
 while(true){
  pages++;assert.ok(pages<=5,'five source events bound this fixture traversal');
  for(const key of Object.keys(collected))collected[key].push(...ids(page)[key]);
  assert.equal(JSON.stringify(page).includes('PRIVATE-OTHER-PAIR'),false);
  if(!page.cursor.hasMore){assert.equal(page.cursor.after,47);assert.equal(page.cursor.nextRead,null);break;}
  const pointer=page.cursor.nextRead,previous=page.cursor.after,next=await f.readPointer(pointer);assert.equal(next.status,200,JSON.stringify(next.value));page=next.value;assert.ok(page.cursor.after>previous);
 }
 for(const key of Object.keys(collected))assert.deepEqual(collected[key],expected[key],'all addressed '+key+' appear exactly once across emitted continuations');
 assert.equal(JSON.stringify(first).includes('PRIVATE-OTHER-PAIR'),false);const after=first.cursor.after,last=await f.read(5,after);assert.equal(last.status,200);assert.equal(last.value.cursor.hasMore,false);assert.deepEqual(last.value.directMessages,[]);assert.deepEqual(last.value.directMentions,[]);assert.deepEqual(last.value.replies,[]);assert.equal(JSON.stringify(last.value).includes('PRIVATE-OTHER-PAIR'),false);
 const before=f.s.db.prepare('SELECT * FROM operator_actions ORDER BY id').all();await f.read(5);assert.deepEqual(f.s.db.prepare('SELECT * FROM operator_actions ORDER BY id').all(),before);
 await f.reopen();assert.deepEqual(ids((await f.read(5)).value),expected);
 f.s.agentPlugin.revokeApiKey({identityId:f.saved.identityId,keyId:f.saved.keyId});assert.notEqual((await f.read(5)).status,200);
});
test('fixed inbox reservation admits legitimate record work while the same byte cap still refuses excessive selected context',async t=>{
 const f=await fixture(t),measure=maxRecords=>f.s.readTransaction(()=>withCurrentReadContext(f.s.db,'commons',b=>{let error;try{f.s.agentInbox(f.saved.token,'commons',{after:42,limit:5});}catch(e){error=e.code;}return{error,records:b.records,bytes:b.bytes};},{maxRecords}));
 const old=measure(200),current=measure(512);assert.equal(old.error,'current_room_context_unavailable');assert.equal(current.error,undefined);assert.ok(current.records>200&&current.records<=512);assert.ok(current.bytes<262144);t.diagnostic('SCOPED_INBOX_RESERVATION '+JSON.stringify({old,current}));
 const key=f.s.issueAccessKey('commons','worker');for(let i=0;i<4;i++)f.s.command(key,'commons',{id:'large-own-'+i,type:'message.posted',data:{messageId:'large-own-'+i,body:'X'.repeat(35000)}});
 const owner=f.saved.owner,after=f.s.headSequence('commons');for(let i=0;i<4;i++)f.s.command(owner,'commons',{id:'large-reply-'+i,type:'message.posted',data:{messageId:'large-reply-'+i,body:'Useful reply',replyToId:'large-own-'+i}});
 const large=await f.read(5,after);assert.equal(large.status,409);assert.equal(large.value.error.code,'current_room_context_unavailable');
});

test("MCP inbox continuation can be called verbatim",async t=>{const f=await fixture(t);const first=await f.rpc("tools/call",{name:"room_read_inbox",arguments:{roomId:"commons",after:f.saved.after,limit:1}});assert.ok(first.result?.structuredContent,JSON.stringify(first));assert.equal(first.result.structuredContent.cursor.hasMore,true);const pointer=first.result.structuredContent.cursor.nextRead;assert.ok(pointer);assert.equal(pointer.arguments.roomId,'commons');const next=await f.rpc("tools/call",{name:pointer.tool,arguments:pointer.arguments});assert.equal(next.result?.isError,undefined,JSON.stringify(next));assert.ok(next.result?.structuredContent?.cursor,JSON.stringify(next));});

test("MCP recent inbox older pointer is usable and invalid cursor is rejected",async t=>{const f=await fixture(t);const first=await f.rpc("tools/call",{name:"room_read_inbox",arguments:{roomId:"commons",limit:1}});const pointer=first.result.structuredContent.older.nextRead;assert.ok(pointer,JSON.stringify(first));const next=await f.rpc("tools/call",{name:pointer.tool,arguments:pointer.arguments});assert.equal(next.result?.isError,undefined,JSON.stringify(next));assert.ok(next.result?.structuredContent?.older,JSON.stringify(next));const invalid=await f.rpc("tools/call",{name:"room_read_inbox",arguments:{roomId:"commons",limit:1,olderCursor:"invalid-cursor-probe"}});assert.ok(invalid.result?.isError||invalid.error,JSON.stringify(invalid));});
