import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {createRoomServer} from '../server/http.mjs';
import {RoomClient} from '../src/client.js';
import {readRoomSnapshot} from '../server/snapshot-window.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
import {buildRoomBootstrap} from '../server/room-bootstrap.mjs';

// Same existing endpoint, explicitly code-owned synthetic normalized room.
// Runtime implementation is owned by root; this test intentionally fails before
// the normalized snapshot/bootstrap port exists.
test('normalized room bootstrap is readable through the existing builder',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 store.initialize([...initialRoom(),event({id:'saved-bootstrap',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'saved-bootstrap',body:'Useful saved context'}})],{representation:'normalized-current-v1'});
 const key=store.issueAccessKey('commons','owner');
 const bootstrap=buildRoomBootstrap(store,key,'commons',null);
 assert.equal(bootstrap.roomId,'commons');
 assert.equal(bootstrap.snapshot.viewerId,'owner');
 assert.ok(Array.isArray(bootstrap.snapshot.state.messages));
 assert.equal(bootstrap.snapshot.state.messages.find(message=>message.id==='saved-bootstrap')?.body,'Useful saved context');
});

test('actual browser client holds explicit partial current window and pages through existing conversation contract',async t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 const posts=Array.from({length:20},(_,i)=>event({id:`native-open-${i}`,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:`native-open-${i}`,body:`Saved result ${i}`}}));
 store.initialize([...initialRoom(),...posts],{representation:'normalized-current-v1'});
 const issued=store.createSession(store.issueAccessKey('commons','owner')),key=issued.token,reads=[],seen=[];
 const client=new RoomClient({events:null,lazyHistory:true,onSnapshot:s=>seen.push(s)});t.after(()=>client.disconnect());
 client.session={authMode:'room',roomId:'commons',member:{id:'owner'},sessionBinding:issued.session.sessionBinding,sessionRevision:issued.session.sessionRevision};
 client.request=async path=>{
  reads.push(path);const url=new URL(path,'http://local');
  if(url.pathname.endsWith('/conversation'))return readConversation(store,key,'commons',{limit:Number(url.searchParams.get('limit')),cursor:url.searchParams.get('cursor')});
  return readRoomSnapshot(store,key,'commons',null,{windowed:true,offerContext:true});
 };
 await client.refresh();
 assert.equal(reads.length,1,'no fallback full-document loop for unknown omitted count');
 assert.equal(seen.at(-1).snapshotVersion,2);
 assert.equal(client.heldMessages().partial,true);
 assert.equal(client.heldMessages().owesFull,false);
 assert.equal(seen.at(-1).state.messages.at(-1).body,'Saved result 19');
 for(let i=0;i<5&&client.heldMessages().partial;i++)assert.equal(await client.pageOlder(),true);
 assert.equal(client.heldMessages().partial,false);
 assert.equal(new Set(seen.at(-1).state.messages.map(m=>m.id)).size,seen.at(-1).state.messages.length);
 for(const post of posts)assert.ok(seen.at(-1).state.messages.some(m=>m.id===post.data.messageId));
 assert.ok(reads.slice(1).every(path=>path.includes('/conversation?')));
});

test('ordinary HTTP room read opens normalized storage without legacy room hydration',async t=>{
 const store=new RoomStore(':memory:');
 store.initialize([...initialRoom(),event({id:'http-saved',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'http-saved',body:'HTTP saved result'}})],{representation:'normalized-current-v1'});
 const key=store.issueAccessKey('commons','owner'),server=createRoomServer({store});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams?.();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));store.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 store.room=()=>{throw new Error('legacy whole-room hydration is forbidden');};
 const response=await fetch(`${origin}/api/rooms/commons?messages=recent`,{headers:{authorization:`Bearer ${key}`,'X-Project-Room-Offer-Context':'1'}});
 assert.equal(response.status,200);const snapshot=await response.json();
 assert.equal(snapshot.snapshotVersion,2);
 assert.equal(snapshot.state.messages.find(m=>m.id==='http-saved')?.body,'HTTP saved result');
 assert.equal(snapshot.messagesWindow.omitted,null);
 assert.equal(snapshot.sections.replyRequests.available,true);
 assert.equal(snapshot.sections.replyRequests.complete,false);
 assert.equal(snapshot.sections.replyRequests.coverage,'visible-conversation-records');
 assert.deepEqual(snapshot.state.replyRequests,{},'empty selected page is explicitly not a complete request census');
});


import {withCurrentReadContext,withCurrentWorkSummaryReuse,readCurrentWorkSummaryForViewer,withCurrentServingWriter} from '../server/current-room-repository.mjs';
test('composed browser metadata reservation supports100small members without widening nested inbox bounds',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 for(let i=1;i<100;i++)events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'roster-'+i,displayName:'Member '+i,kind:'agent',permissions:[]}}));
 for(let i=0;i<9;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'roster-task-'+i,title:'Useful task',definitionOfDone:'Saved result',accountableMemberId:'owner'}}));
 store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner');
 const snapshot=readRoomSnapshot(store,key,'commons',null,{windowed:true});
 assert.equal(Object.keys(snapshot.state.members).length,100);assert.equal(snapshot.workWindow.shown,8);assert.equal(snapshot.workWindow.complete,false);
 assert.ok(snapshot.workWindow.nextAfter);const next=store.roomContext(key,'commons',{workAfter:snapshot.workWindow.nextAfter});
 assert.equal(next.workWindow.shown,1);assert.equal(next.workWindow.nextAfter,null);
 assert.throws(()=>store.readTransaction(()=>withCurrentReadContext(store.db,'commons',()=>readRoomSnapshot(store,key,'commons',null,{windowed:true}),{maxRecords:200})),e=>e.code==='current_room_context_unavailable','Nested reads cannot replace the enclosing smaller reservation');
});


test('same-transaction browser reuse keeps private event titles viewer-bound and observes changed parties in a new read',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 for(const id of ['worker','outsider'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:'agent',permissions:[]}}));
 events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'secret-task',title:'PRIVATE_TASK_TITLE',definitionOfDone:'PRIVATE_DEFINITION',accountableMemberId:'worker'}}));
 events.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'private-request',toMemberId:'worker',workItemId:'secret-task',requestKind:'reply',requestPolicyVersion:1,body:'Private request'}}));
 store.initialize(events,{representation:'normalized-current-v1'});
 const outsider=store.issueAccessKey('commons','outsider'),worker=store.issueAccessKey('commons','worker'),owner=store.issueAccessKey('commons','owner');
 store.room=()=>{throw Error('browser must not hydrate room');};
 const hidden=readRoomSnapshot(store,outsider,'commons',null,{windowed:true});
 assert.equal(hidden.state.workItems['secret-task'].title,null);
 assert.ok(!JSON.stringify(hidden).includes('PRIVATE_TASK_TITLE'));assert.ok(!JSON.stringify(hidden).includes('PRIVATE_DEFINITION'));
 const visible=readRoomSnapshot(store,worker,'commons',null,{windowed:true});
 assert.equal(visible.state.workItems['secret-task'].title,'PRIVATE_TASK_TITLE');
 assert.equal(visible.state.eventLog.find(e=>e.type==='work.proposed').data.title,'PRIVATE_TASK_TITLE');
 store.command(owner,'commons',{id:'include-outsider',type:'message.posted',data:{messageId:'private-request-two',toMemberId:'outsider',workItemId:'secret-task',requestKind:'reply',body:'Include another party'}});
 const changed=readRoomSnapshot(store,outsider,'commons',null,{windowed:true});
 assert.equal(changed.state.workItems['secret-task'].title,'PRIVATE_TASK_TITLE');
 assert.equal(changed.state.eventLog.find(e=>e.type==='work.proposed').data.title,'PRIVATE_TASK_TITLE');
});

test('browser summary reuse expires, rejects async escape and refuses head/schema mutation with rollback',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'task',title:'Original title',definitionOfDone:'Saved',accountableMemberId:'owner'}}));
 store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner');
 const reuse=operation=>store.readTransaction(()=>withCurrentReadContext(store.db,'commons',()=>withCurrentWorkSummaryReuse(store,'commons','owner',operation),{maxRecords:1024}));
 assert.throws(()=>reuse(()=>Promise.resolve()),/must be synchronous/);
 const escaped=reuse(()=>{const value=readCurrentWorkSummaryForViewer(store.db,'commons','task','owner');value.title='Changed clone';assert.equal(readCurrentWorkSummaryForViewer(store.db,'commons','task','owner').title,'Original title');return()=>readCurrentWorkSummaryForViewer(store.db,'commons','task','owner');});
 assert.equal(escaped().title,'Original title');
 const before=store.headSequence('commons'),writableReuse=operation=>store.transaction(()=>reuse(operation));
 assert.throws(()=>writableReuse(()=>{readCurrentWorkSummaryForViewer(store.db,'commons','task','owner');store.command(key,'commons',{id:'must-rollback',type:'message.posted',data:{messageId:'must-rollback',body:'Never published'}});}),/reuse head changed/);
 assert.equal(store.headSequence('commons'),before);assert.equal(store.db.prepare('SELECT 1 FROM events WHERE id=?').get('must-rollback'),undefined);
 assert.throws(()=>writableReuse(()=>{readCurrentWorkSummaryForViewer(store.db,'commons','task','owner');store.db.exec('DROP INDEX current_work_summary_keys');}),/reuse schema changed/);
 assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='current_work_summary_keys'").get());
 const original=store.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('commons','task').body;
 assert.throws(()=>writableReuse(()=>{readCurrentWorkSummaryForViewer(store.db,'commons','task','owner');withCurrentServingWriter(store.db,'commons',()=>store.db.prepare('UPDATE work_entities SET body=body||? WHERE room_id=? AND work_id=?').run(' ','commons','task'));assert.equal(readCurrentWorkSummaryForViewer(store.db,'commons','task','owner').title,'Original title');}),/reuse data changed/);
 assert.equal(store.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('commons','task').body,original);

 assert.equal(readRoomSnapshot(store,key,'commons',null,{windowed:true}).state.workItems.task.title,'Original title');
});
