import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {withCurrentReadContext,withCurrentRoomWriter} from '../server/current-room-repository.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(t,extend=()=>{}){
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 const add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
 for(const memberId of ['reader','other'])add('member.added',{memberId,displayName:memberId,kind:'agent',permissions:[]});
 add('message.posted',{messageId:'question',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Please save useful work'});
 extend(events,add,store);store.initialize(events,{representation:'normalized-current-v1'});
 const keys=Object.fromEntries(['owner','reader','other'].map(id=>[id,store.issueAccessKey('commons',id)]));
 return {store,keys,events};
}
test('normalized current requests list does not report an existing incoming obligation as empty',t=>{
 const {store,keys}=fixture(t),listed=store.replyRequests.list(keys.reader,'commons');
 assert.deepEqual(listed.requests.map(request=>request.id),['question']);
});
test('bounded witnessed refill finds an addressed request behind unrelated requests',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<18;i++)add('message.posted',{messageId:`a-noise-${String(i).padStart(2,'0')}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});
 });
 store.room=()=>{throw Error('whole-room hydration forbidden');};
 const result=store.replyRequests.list(keys.reader,'commons',{limit:8});
 assert.deepEqual(result.requests.map(request=>request.id),['question']);
 assert.equal(result.page.hasMore,false);
});
test('witnessed refill respects a nested 200-record context and returns every request',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<25;i++)add('message.posted',{messageId:`a-match-${String(i).padStart(2,'0')}`,toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Question'});
 });
 store.room=()=>{throw Error('whole-room hydration forbidden');};
 let args={direction:'incoming',status:'open',limit:50},ids=[],pages=0;
 do{
  const {result,records}=withCurrentReadContext(store.db,'commons',b=>{
   const result=store.replyRequests.list(keys.reader,'commons',args);
   return {result,records:b.records};
  },{maxRecords:200});
  assert.ok(records<=200);
  ids.push(...result.requests.map(request=>request.id));args=result.nextRead?.arguments;
  assert.ok(++pages<20);
 }while(args);
 assert.equal(ids.length,26);assert.equal(new Set(ids).size,26);assert.equal(ids.at(-1),'question');
});
for(const [field,value] of [['recipientId','other'],['status','answered']])test(`witnessed refill fails closed when ${field} is corrupted`,t=>{
 const {store,keys}=fixture(t);
 store.transaction(()=>withCurrentRoomWriter(store.db,'commons',()=>store.db.prepare(
  "UPDATE current_room_records SET payload=json_set(payload,?,?) WHERE room_id='commons' AND domain='replyRequests' AND record_key='question'"
 ).run(`$.${field}`,value)));
 store.room=()=>{throw Error('whole-room hydration forbidden');};
 assert.throws(()=>store.replyRequests.list(keys.reader,'commons',{direction:'incoming',status:'open'}),/current_room_corrupt/);
});
test('large cancelled requests keep a bounded continuation',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<8;i++){
   const id=`budget-${i}`;
   add('message.posted',{messageId:id,toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Question'});
   add('reply_request.cancelled',{requestMessageId:id,expectedRequestRevision:0,reason:'\u0001'.repeat(4096)});
  }
 });
 store.room=()=>{throw Error('whole-room hydration forbidden');};
 let args={direction:'incoming',status:'cancelled',limit:8},ids=[],pages=0;
 do{const result=store.replyRequests.list(keys.reader,'commons',args);ids.push(...result.requests.map(r=>r.id));args=result.nextRead?.arguments;assert.ok(++pages<10);}while(args);
 assert.ok(pages>1);assert.deepEqual(ids,Array.from({length:8},(_,i)=>`budget-${i}`));
});
test('normalized selected request is readable through the existing reader and supplies exact answer basis',t=>{
 const {store,keys}=fixture(t),read=store.replyRequests.selected(keys.reader,'commons','question');
 assert.equal(read.request.id,'question');assert.equal(read.page.items[0].message.body,'Please save useful work');
 assert.equal(read.current.answerBasis.contextEventId,read.request.contextEventId);
});
test('normalized current request remains absent to nonparticipants',t=>{
 const {store,keys}=fixture(t);
 assert.throws(()=>store.replyRequests.selected(keys.other,'commons','question'),error=>error.status===404&&error.code==='reply_request_not_found');
});

import {validateReplyRead,validReplyArguments} from '../client/reply-actions.mjs';
test('v2 selected and list pass the actual shared SDK/MCP validator without v1 cursor synthesis',t=>{
 const {store,keys}=fixture(t);
 for(const [name,args,read]of [
  ['room_list_requests',{},store.replyRequests.list(keys.reader,'commons')],
  ['room_read_request',{requestMessageId:'question'},store.replyRequests.selected(keys.reader,'commons','question')]
 ])assert.equal(validateReplyRead(read,{name,args,roomId:'commons'}).contractVersion,2);
 assert.equal(validReplyArguments('room_list_requests',{limit:1,cursor:'opaque'}),true);
});
test('bounded list empty-more pages retain late obligation and hide excluded IDs in opaque cursor',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<18;i++)add('message.posted',{messageId:`a-private-${i.toString().padStart(2,'0')}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});
 });
 let args={limit:2},found=[],pages=0,emptyMore=false;
 do{
  const read=store.replyRequests.list(keys.reader,'commons',args);validateReplyRead(read,{name:'room_list_requests',args,roomId:'commons'});
  found.push(...read.requests.map(r=>r.id));emptyMore ||=read.requests.length===0&&read.page.hasMore;
  assert.equal(JSON.stringify(read).includes('a-private-'),false);
  if(!read.nextRead)break;args=read.nextRead.arguments;assert.ok(++pages<20);
 }while(true);
 assert.deepEqual(found,['question']);assert.equal(emptyMore,true);
});
test('selected continuation binds viewer and request, rejects tampering and carries source progress',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<12;i++)add('message.posted',{messageId:`context-${i}`,replyToId:'question',toMemberId:'reader',body:`Context ${i}`});
 });
 let args={requestMessageId:'question',limit:2},ids=[],pages=0;
 do{
  const read=store.replyRequests.selected(keys.reader,'commons','question',args);validateReplyRead(read,{name:'room_read_request',args,roomId:'commons'});
  ids.push(...read.page.items.map(r=>r.message.id));
  if(!read.nextRead)break;
  assert.equal(read.current.answerBasis,null);
  assert.throws(()=>store.replyRequests.selected(keys.owner,'commons','question',read.nextRead.arguments),e=>e.code==='reply_cursor_identity_changed');
  assert.throws(()=>store.replyRequests.selected(keys.reader,'commons','question',{...read.nextRead.arguments,cursor:read.page.nextCursor.slice(0,-2)+'xx'}),e=>e.code==='invalid_reply_cursor');
  args=read.nextRead.arguments;assert.ok(++pages<20);
 }while(true);
 assert.equal(ids.length,13);assert.equal(new Set(ids).size,13);
});
test('requester cancellation is exposed only after supported command and remains readable to its parties',t=>{
 const {store,keys}=fixture(t);
 const before=store.replyRequests.selected(keys.owner,'commons','question');assert.equal(before.current.actions.cancel,true);
 const cancelled=store.command(keys.owner,'commons',{id:'cancel-question',type:'reply_request.cancelled',data:{requestMessageId:'question',expectedRequestRevision:0,reason:'No longer needed'}});
 const read=store.replyRequests.selected(keys.reader,'commons','question');
 assert.equal(read.request.status,'cancelled');assert.equal(read.current.answerBasis,null);
 assert.equal(read.page.items.at(-1).eventId,cancelled.event.id);assert.equal(read.page.items.at(-1).reason,'No longer needed');
 validateReplyRead(read,{name:'room_read_request',args:{requestMessageId:'question'},roomId:'commons'});
});

import {createRoomServer} from '../server/http.mjs';
import {RoomAgentClient} from '../client/room-agent.mjs';
test('actual HTTP and SDK consume normalized list continuation and selected answer without legacy hydration',async t=>{
 const {store,keys}=fixture(t,(_events,add)=>{for(let i=0;i<9;i++)add('message.posted',{messageId:`a-excluded-${i}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});});
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,client=new RoomAgentClient({version:1,origin,roomId:'commons',memberId:'reader',token:keys.reader});
 store.room=()=>{throw Error('unexpected legacy room hydration');};
 let args={limit:2},ids=[];
 for(let page=0;page<10;page++){
  const read=await client.replyRead('room_list_requests',args);ids.push(...read.requests.map(r=>r.id));if(!read.nextRead)break;args=read.nextRead.arguments;
 }
 assert.deepEqual(ids,['question']);
 const selected=await client.replyContext('question');assert.ok(selected.current.answerBasis);assert.equal(selected.page.items[0].message.body,'Please save useful work');
});
test('normalized same-pair follow-up prepares the earlier useful answer without hydrating the room',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  // Legacy policy1 marked response records carry the exact inspected context.
  const opening=_events.find(e=>e.data.messageId==='question');
  add('message.posted',{messageId:'answer',replyToId:'question',responseToRequestId:'question',expectedRequestRevision:0,responseOutcome:'answered',requestPolicyVersion:1,contextEventId:opening.id,contextSequence:_events.indexOf(opening)+1,toMemberId:'owner',workItemId:null,body:'A useful saved answer'},'reader');
  add('message.posted',{messageId:'follow-up',replyToId:'answer',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Build on that answer'});
 });
 store.room=()=>{throw Error('legacy hydration');};
 const read=store.replyRequests.selected(keys.reader,'commons','follow-up');
 assert.equal(read.preparation.previousExchanges[0].messages.at(-1).body,'A useful saved answer');
 assert.ok(read.current.answerBasis);validateReplyRead(read,{name:'room_read_request',args:{requestMessageId:'follow-up'},roomId:'commons'});
});
test('normalized history drains excluded source windows and resumes checkpoint for a late obligation',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{for(let i=0;i<18;i++)add('message.posted',{messageId:`private-background-${i}`,toMemberId:'other',body:'Do not disclose'});});
 let args={limit:2},ids=[],checkpoint=null,emptyMore=false;
 for(let page=0;page<30;page++){
  const read=store.replyRequests.history(keys.reader,'commons',args);validateReplyRead(read,{name:'room_request_history',args,roomId:'commons'});
  ids.push(...read.page.items.map(r=>r.message.id));emptyMore ||=read.page.items.length===0&&read.page.hasMore;
  assert.equal(JSON.stringify(read).includes('private-background'),false);
  if(!read.nextRead){checkpoint=read.page.completedCheckpoint;break;}args=read.nextRead.arguments;
 }
 assert.deepEqual(ids,['question']);assert.ok(checkpoint);assert.equal(emptyMore,true);
 store.command(keys.owner,'commons',{id:'late-request',type:'message.posted',data:{messageId:'late-question',toMemberId:'reader',requestKind:'reply',body:'New useful work'}});
 args={limit:2,checkpoint};const late=store.replyRequests.history(keys.reader,'commons',args);
 validateReplyRead(late,{name:'room_request_history',args,roomId:'commons'});assert.deepEqual(late.page.items.map(r=>r.message.id),['late-question']);
 assert.throws(()=>store.replyRequests.history(keys.owner,'commons',args),e=>e.code==='reply_cursor_identity_changed');
});
test('same-member active credentials cannot transfer selected, list, or history continuations',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{for(let i=0;i<10;i++)add('message.posted',{messageId:`context-bound-${i}`,replyToId:'question',toMemberId:'reader',body:'Bound context'});});
 const second=store.mintAccessKey('commons','reader');
 assert.equal(store.authenticate(keys.reader,'commons').member.id,store.authenticate(second,'commons').member.id);
 const selected=store.replyRequests.selected(keys.reader,'commons','question',{limit:1});
 const history=store.replyRequests.history(keys.reader,'commons',{limit:1});
 // A second addressed request ensures the one-result list has a continuation.
 store.command(keys.owner,'commons',{id:'excluded-bound',type:'message.posted',data:{messageId:'excluded-bound',toMemberId:'reader',requestKind:'reply',body:'Second'}});
 const list=store.replyRequests.list(keys.reader,'commons',{limit:1});
 assert.ok(list.nextRead);assert.ok(selected.nextRead);assert.ok(history.nextRead);
 for(const read of [selected,history,list]){
  const args=read.nextRead.arguments;
  assert.throws(()=>read.nextRead.tool==='room_read_request'?store.replyRequests.selected(second,'commons','question',args):read.nextRead.tool==='room_list_requests'?store.replyRequests.list(second,'commons',args):store.replyRequests.history(second,'commons',args),e=>e.code==='reply_cursor_identity_changed');
 }
});
import {callHostedStdioTool,validHostedStdioArgs} from '../server/mcp-full-profile.mjs';
test('hosted MCP reply continuations include their required room and can be followed verbatim',async t=>{
 const {store,keys}=fixture(t,(_events,add)=>{for(let i=0;i<9;i++)add('message.posted',{messageId:`a-mcp-excluded-${i}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});});
 store.room=()=>{throw Error('legacy hydration');};
 let args={roomId:'commons',limit:2},ids=[];
 for(let page=0;page<10;page++){
  assert.equal(validHostedStdioArgs('room_list_requests',args),true);
  const response=await callHostedStdioTool(store,keys.reader,'room_list_requests',args);assert.equal(response.isError,false);
  ids.push(...response.value.requests.map(r=>r.id));if(!response.value.nextRead)break;
  assert.equal(response.value.page.nextRead.arguments.roomId,'commons');args=response.value.nextRead.arguments;
 }
 assert.deepEqual(ids,['question']);
 const selected=await callHostedStdioTool(store,keys.reader,'room_read_request',{roomId:'commons',requestMessageId:'question'});
 assert.equal(selected.isError,false);assert.ok(selected.value.current.answerBasis);assert.equal(selected.value.responseActions[0].arguments.roomId,'commons');
});
test('reactivation history floor hides the older obligation consistently across list, selected and history',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  add('room.history_visibility_set',{historyVisibility:'since_join'});
  add('member.access_changed',{memberId:'reader',expectedMemberRevision:0,permissions:[],active:false});add('member.access_changed',{memberId:'reader',expectedMemberRevision:1,permissions:[],active:true});
  add('message.posted',{messageId:'new-visible',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Visible current obligation'});
 });
 assert.deepEqual(store.replyRequests.list(keys.reader,'commons').requests.map(r=>r.id),['new-visible']);
 assert.throws(()=>store.replyRequests.selected(keys.reader,'commons','question'),e=>e.status===404&&e.code==='reply_request_not_found');
 let args={limit:2},found=[];
 for(let i=0;i<20;i++){const read=store.replyRequests.history(keys.reader,'commons',args);found.push(...read.page.items.map(r=>r.message.id));if(!read.nextRead)break;args=read.nextRead.arguments;}
 assert.deepEqual(found,['new-visible']);
});
test('denied directional consent removes answer and reply actions without acknowledging or changing obligations',t=>{
 const {store,keys}=fixture(t);
 store.dmConsents.request('commons','reader','owner','Fixture');
 store.dmConsents.decide('commons','owner','reader','reject');
 const before=Object.fromEntries(['events','commands','current_room_records','operator_actions'].map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()]));
 const read=store.replyRequests.selected(keys.reader,'commons','question');
 assert.equal(read.current.answerBasis,null);assert.equal(read.current.actions.answer,false);assert.equal(read.current.actions.reply,false);assert.equal(read.responseActions.length,0);
 validateReplyRead(read,{name:'room_read_request',args:{requestMessageId:'question'},roomId:'commons'});
 store.replyRequests.list(keys.reader,'commons');store.replyRequests.history(keys.reader,'commons');
 for(const table of Object.keys(before))assert.deepEqual(store.db.prepare('SELECT * FROM '+table).all(),before[table]);
});
test('incoming open asks come first through the open-request index, then the witnessed scan skips them',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<40;i++)add('message.posted',{messageId:`a-noise-${String(i).padStart(2,'0')}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});
  add('message.posted',{messageId:'z-late-ask',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Late'});
 },);
 store.room=()=>{throw Error('whole-room hydration forbidden');};
 const first=store.replyRequests.list(keys.reader,'commons',{limit:20});
 assert.deepEqual(first.requests.map(r=>r.id).sort(),['question','z-late-ask'],'both open asks on page one despite 40 earlier requests');
  assert.equal(JSON.stringify(first).includes('a-noise-'),false);
 let args=first.nextRead?.arguments,later=[],pages=0;
 while(args){const read=store.replyRequests.list(keys.reader,'commons',args);later.push(...read.requests.map(r=>r.id));args=read.nextRead?.arguments;assert.ok(++pages<40);}
 assert.deepEqual(later,[],'the witnessed scan does not repeat the index hits');
 const small=store.replyRequests.list(keys.reader,'commons',{limit:1});
 assert.equal(small.requests.length,1);assert.equal(small.page.hasMore,true);
 const rest=[];let a=small.nextRead.arguments,p=0;
 assert.throws(()=>store.replyRequests.list(keys.other,'commons',a),e=>e.code==='reply_cursor_identity_changed');
 while(a){const read=store.replyRequests.list(keys.reader,'commons',a);rest.push(...read.requests.map(r=>r.id));a=read.nextRead?.arguments;assert.ok(++p<60);}
 assert.deepEqual([...small.requests.map(r=>r.id),...rest].sort(),['question','z-late-ask'],'limit 1: each open ask exactly once across pages');
 const outgoing=store.replyRequests.list(keys.reader,'commons',{direction:'both',limit:20});
 assert.equal(outgoing.requests.some(r=>r.id==='a-noise-00'),false,'other paths unchanged: no access to others\' asks');
});
test('open-ask head start: revoked credentials and restarted stores refuse its continuation, and a fresh read still leads with the ask',t=>{
 const dir=mkdtempSync(join(tmpdir(),'open-asks-')),path=join(dir,'room.sqlite');
 let store=new RoomStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const events=initialRoom(),add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
 for(const memberId of ['reader','other'])add('member.added',{memberId,displayName:memberId,kind:'agent',permissions:[]});
 for(let i=0;i<20;i++)add('message.posted',{messageId:`a-noise-${String(i).padStart(2,'0')}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});
 add('message.posted',{messageId:'z-late-ask',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Late'});
 store.initialize(events,{representation:'normalized-current-v1'});
 let key=store.issueAccessKey('commons','reader');
 const first=store.replyRequests.list(key,'commons',{limit:1});
 assert.deepEqual(first.requests.map(r=>r.id),['z-late-ask']);
 store.close();store=new RoomStore(path);
 assert.throws(()=>store.replyRequests.list(key,'commons',first.nextRead.arguments),e=>e.code==='invalid_reply_cursor','a cold store never resumes an old head-start cursor');
 assert.deepEqual(store.replyRequests.list(key,'commons',{limit:1}).requests.map(r=>r.id),['z-late-ask'],'cold reopen: the ask still leads');
 const again=store.replyRequests.list(key,'commons',{limit:1});
 store.revokeRoomCredential('commons','reader',key);
 assert.throws(()=>store.replyRequests.list(key,'commons',again.nextRead.arguments),e=>e.status===401,'revoked credential cannot continue');
 assert.throws(()=>store.replyRequests.list(key,'commons',{limit:1}),e=>e.status===401,'revoked credential cannot start');
});
test('sent open asks lead page one too, in both and outgoing directions, and closed ones stay in the scan',t=>{
 const {store,keys}=fixture(t,(_events,add)=>{
  for(let i=0;i<40;i++)add('message.posted',{messageId:`a-noise-${String(i).padStart(2,'0')}`,toMemberId:'other',requestKind:'reply',requestPolicyVersion:1,body:'Private'});
  add('message.posted',{messageId:'z-my-ask',toMemberId:'owner',requestKind:'reply',requestPolicyVersion:1,body:'Mine'},'reader');
 });
 store.room=()=>{throw Error('whole-room hydration forbidden');};
 for(const direction of ['outgoing','both']){
  const first=store.replyRequests.list(keys.reader,'commons',{direction,limit:20});
  const ids=first.requests.map(r=>r.id).sort();
  assert.ok(ids.includes('z-my-ask'),`${direction}: my sent ask on page one (${ids})`);
  if(direction==='both')assert.ok(ids.includes('question'),'both: the incoming ask too');
  assert.equal(JSON.stringify(first).includes('a-noise-'),false);
  let args=first.nextRead?.arguments,later=[],pages=0;
  while(args){const read=store.replyRequests.list(keys.reader,'commons',args);later.push(...read.requests.map(r=>r.id));args=read.nextRead?.arguments;assert.ok(++pages<60);}
  assert.equal(later.filter(id=>ids.includes(id)).length,0,`${direction}: no repeats`);
 }
 const other=store.replyRequests.list(keys.other,'commons',{direction:'outgoing',limit:20});
 assert.equal(other.requests.some(r=>r.id==='z-my-ask'),false,'another member never sees my sent ask');
});
