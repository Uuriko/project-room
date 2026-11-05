import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';

function fixture(t,count=36,extend=()=>{}){
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 const add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
 for(const memberId of ['alice','bob','reader'])add('member.added',{memberId,displayName:memberId,kind:'agent',permissions:[]});
 for(let i=0;i<count;i++)add('message.posted',{messageId:'private-'+i,body:'PRIVATE-'+i,toMemberId:'bob'},'alice');
 add('message.posted',{messageId:'public',body:'OLD-PUBLIC'});
 add('message.edited',{messageId:'public',body:'CURRENT-PUBLIC',expectedMessageRevision:0});
 add('message.edited',{messageId:'private-0',body:'EDITED-PRIVATE',expectedMessageRevision:0},'alice');
 extend(events,add,store);
 store.initialize(events,{representation:'normalized-current-v1'});
 const keys=Object.fromEntries(['owner','alice','bob','reader'].map(id=>[id,store.issueAccessKey('commons',id)]));
 store.room=()=>{throw Error('whole-room hydration');};
 return {store,keys,events};
}
test('normalized events traverse excluded source windows and redact current bodies without room hydration',t=>{
 const {store,keys}=fixture(t);let after=0;const all=[];
 for(let n=0;n<30;n++){
  const page=store.eventsAfter(keys.reader,'commons',after,100);
  assert.ok(page.next>=after);
  assert.doesNotThrow(()=>store.redactionMessages('commons',page));
  all.push(...page.events);if(!page.hasMore)break;assert.ok(page.next>after);after=page.next;
 }
 // W3200 R-07: a read now scans past excluded source windows within one call
 // (bounded by the source-byte ledger and the shared read budget), so an
 // empty-more page is possible but no longer required for this small backlog;
 // that honesty case is covered deterministically in
 // tests/w3200-r07-r08-event-window.test.mjs (large invisible backlog).
 assert.equal(all.filter(x=>x.event.type==='message.posted').length,1);
 assert.equal(all.find(x=>x.event.data?.messageId==='public').event.data.body,'CURRENT-PUBLIC');
 assert.equal(JSON.stringify(all).includes('PRIVATE-'),false);
});

test('filters scan past unfiltered source gaps to the match in a bounded number of calls',t=>{
 const {store,keys}=fixture(t);let after=0,pages=0;const rows=[];
 for(;pages<30;pages++){
  const page=store.eventsAfter(keys.reader,'commons',after,100,{types:['message.edited'],actor:'owner'});
  assert.ok(page.next>=after);rows.push(...page.events);if(!page.hasMore)break;assert.ok(page.next>after);after=page.next;
 }
 // W3200 R-07: filters are still applied after candidate admission (no JSON
 // predicate before LIMIT), but one call scans forward over the match gap
 // instead of returning one 16-sequence window per call (was 3+ pages here).
 assert.ok(pages<=2);assert.equal(rows.length,1);assert.equal(rows[0].event.data.body,'CURRENT-PUBLIC');
 assert.throws(()=>store.eventsAfter(keys.reader,'commons',0,101),e=>e.code==='invalid_cursor');
 assert.throws(()=>store.eventsAfter(keys.reader,'commons',999,10),e=>e.code==='cursor_ahead');
 assert.throws(()=>store.redactionMessages('commons'),e=>e.code==='current_room_context_unavailable');
});

test('private followups remain visible only to their parties and owner has no DM exemption',t=>{
 const {store,keys,events}=fixture(t,1),after=events.length-2;
 for(const who of ['owner','reader'])assert.equal(store.eventsAfter(keys[who],'commons',after,100).events.some(x=>x.event.data?.messageId==='private-0'),false);
 for(const who of ['alice','bob'])assert.equal(store.eventsAfter(keys[who],'commons',after,100).events.find(x=>x.event.data?.messageId==='private-0').event.data.body,'EDITED-PRIVATE');
});

import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';
import {createRoomServer} from '../server/http.mjs';
test('actual HTTP events and tail plus hosted MCP use selected current redaction context',async t=>{
 const {store,keys}=fixture(t),server=createRoomServer({store});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const url='http://127.0.0.1:'+server.address().port+'/api/rooms/commons/events';
 let after=0,all=[];
 for(let n=0;n<20;n++){
  const response=await fetch(url+'?after='+after,{headers:{authorization:'Bearer '+keys.reader}}),page=await response.json();
  assert.equal(response.status,200,JSON.stringify(page));all.push(...page.events);if(!page.hasMore)break;after=page.next;
 }
 assert.equal(all.find(x=>x.event.data?.messageId==='public').event.data.body,'CURRENT-PUBLIC');
 const tail=await fetch(url+'?tail=8',{headers:{authorization:'Bearer '+keys.reader}});assert.equal(tail.status,200,await tail.text());
 const identity=store.identities.create('Events reader');
 store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',identity.identityId,'reader',new Date(store.now()).toISOString());
 const mcp=createHostedRoomMcp(store);after=0;all=[];
 for(let n=0;n<20;n++){
  const response=await mcp({jsonrpc:'2.0',id:n+1,method:'tools/call',params:{name:'room_list_events',arguments:{roomId:'commons',after}}},{authorization:'Bearer '+identity.secret});
  assert.ok(!response.error&&!response.result.isError,JSON.stringify(response));const page=response.result.structuredContent;
  all.push(...page.events);if(!page.hasMore)break;after=page.next;
 }
 assert.equal(all.find(x=>x.event.data?.messageId==='public').event.data.body,'CURRENT-PUBLIC');assert.equal(JSON.stringify(all).includes('PRIVATE-'),false);
});

test('since-join excludes old timestamp/new sequence posts and followups to earlier messages',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 const add=(id,type,data,at)=>events.push(event({id,roomId:'commons',actorId:'owner',type,data,at}));
 add('history','room.history_visibility_set',{historyVisibility:'since_join'},'2026-01-01T00:00:00.000Z');
 add('early','message.posted',{messageId:'early',body:'PRE-JOIN'},'2026-01-01T00:00:00.000Z');
 add('join','member.added',{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]},'2026-02-01T00:00:00.000Z');
 add('late-old-time','message.posted',{messageId:'late-old-time',body:'OLD-TIME'},'2026-01-01T00:00:00.000Z');
 add('edit-early','message.edited',{messageId:'early',body:'LATE-EDIT-PRE-JOIN',expectedMessageRevision:0},'2026-03-01T00:00:00.000Z');
 add('visible','message.posted',{messageId:'visible',body:'VISIBLE'},'2026-03-01T00:00:00.000Z');
 store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','reader');store.room=()=>{throw Error('whole-room hydration');};
 const page=store.eventsAfter(key,'commons');assert.deepEqual(page.events.filter(x=>x.event.type.startsWith('message.')).map(x=>x.event.data.messageId),['visible']);
});

test('malformed or oversized source envelope refuses without issuing an advanced page',t=>{
 const {store,keys}=fixture(t,1);
 assert.throws(()=>store.db.prepare('UPDATE events SET body=? WHERE room_id=? AND sequence=1').run('bad','commons'),/unsupported current room writer/);
 // Explicit synthetic fault injection through the fixture's format permit.
 const damage=body=>store.transaction(()=>withCurrentRoomWriter(store.db,'commons',()=>store.db.prepare('UPDATE events SET body=? WHERE room_id=? AND sequence=1').run(body,'commons')));
 damage(JSON.stringify({noise:'x'.repeat(131073)}));
 assert.throws(()=>store.eventsAfter(keys.reader,'commons'),e=>e.code==='current_room_context_unavailable');
 damage('{"id":"forged"}');
 assert.throws(()=>store.eventsAfter(keys.reader,'commons'),e=>e.code==='current_room_context_unavailable');
});

test('mention filtering/chips use bounded facts and timeout presentation creates no write',t=>{
 const {store,keys,events}=fixture(t,1),post=events.find(e=>e.data?.messageId==='public'&&e.type==='message.posted');
 store.db.prepare('INSERT INTO mention_states(room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at) VALUES(?,?,?,?,?,?)').run('commons',post.id,'reader','delivered',0,1);
 const before=store.db.prepare('SELECT * FROM mention_states').all();
 const page=store.eventsAfter(keys.reader,'commons',0,100,{mentions:'me',compact:true});
 assert.equal(page.events.length,1);assert.equal(page.events[0].event.data.body,'CURRENT-PUBLIC');
 assert.deepEqual(page.events[0].event.mentions,[{memberId:'reader',state:'timed_out'}]);
 assert.equal('roomId' in page.events[0].event,false);assert.deepEqual(store.db.prepare('SELECT * FROM mention_states').all(),before);
});

test('consent moderation and peer identity privacy preserve their distinct audiences',t=>{
 let partyIdentity;
 const {store,keys}=fixture(t,1,(_events,add,s)=>{
  partyIdentity=s.identities.create('Bob peer');
  add('dm.consent_changed',{requesterId:'alice',targetId:'bob',status:'pending'});
  add('dm.posted',{messageId:'peer-secret',threadId:'thread',bondId:'bond',fromIdentityId:partyIdentity.identityId,toIdentityId:'reader',body:'PEER-SECRET'});
 });
 store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('commons',partyIdentity.identityId,'bob',new Date(store.now()).toISOString());
 for(const who of ['owner','reader','alice','bob']){
  const page=store.eventsAfter(keys[who],'commons');
  assert.equal(page.events.some(x=>x.event.type==='dm.consent_changed'),who!=='reader');
  assert.equal(page.events.some(x=>x.event.type==='dm.posted'),who==='bob','member ID collision or owner must not grant peer DM access');
 }
});

test('a late formal request is reached past hidden empty windows without acknowledging it',t=>{
 const {store,keys}=fixture(t,60,(_events,add)=>add('message.posted',{messageId:'late-request',toMemberId:'reader',body:'Useful request',requestKind:'reply',requestPolicyVersion:1}));
 const before=store.db.prepare('SELECT * FROM mention_states').all();let after=0,request=null;
 for(let n=0;n<20;n++){
  const page=store.eventsAfter(keys.reader,'commons',after,100);
  request??=page.events.find(x=>x.event.data?.messageId==='late-request');if(!page.hasMore)break;after=page.next;
 }
 // W3200 R-07: the request is still reached past the hidden backlog without
 // being acknowledged; the scan now crosses the backlog within a call rather
 // than yielding multiple empty pages first.
 assert.equal(request.event.data.requestKind,'reply');assert.equal(request.event.data.body,'Useful request');
 assert.deepEqual(store.db.prepare('SELECT * FROM mention_states').all(),before);
});

test('SSE drains hidden source windows and delivers current public text',async t=>{
 const {store,keys}=fixture(t,60),server=createRoomServer({store});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),3000);let text='';
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/rooms/commons/stream?after=0',{headers:{authorization:'Bearer '+keys.reader},signal:controller.signal});
  assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();
  while(!text.includes('CURRENT-PUBLIC')){const value=await reader.read();if(value.done)break;text+=decoder.decode(value.value);}
  await reader.cancel();assert.ok(text.includes('CURRENT-PUBLIC'));assert.equal(text.includes('PRIVATE-'),false);assert.equal(text.includes('unavailable'),false);
 }finally{clearTimeout(timeout);controller.abort();}
});
