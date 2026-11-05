import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {publicRoomView} from '../server/public-rooms.mjs';
import {unpublishPublic} from '../server/legal-store.mjs';
import {readCurrentPublicWork} from '../server/current-public-work.mjs';
import {withCurrentRoomWriter, CURRENT_PUBLIC_WORK_PREDICATE, CURRENT_PUBLIC_WORK_INDEX_SQL, readCurrentWorkItem} from '../server/current-room-repository.mjs';

function fixture(t){
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 store.initialize(initialRoom('public-work-room'),{representation:'normalized-current-v1'});
 const owner=store.issueAccessKey('public-work-room','owner');
 const send=(id,type,data={})=>store.command(owner,'public-work-room',{id,type,data});
 send('page','room.public_page_set',{enabled:true});
 const task=(id,publish=false)=>{send('propose-'+id,'work.proposed',{workItemId:id,title:'Task '+id,definitionOfDone:'Only the explicitly published instruction',accountableMemberId:'owner',mode:'read',ownerDecisionRequired:false,independentVerificationRequired:false});if(publish)send('publish-'+id,'work.public_set',{workItemId:id,enabled:true});};
 store.room=()=>{throw Error('Whole room hydration forbidden');};
 return{store,send,task,page:options=>publicRoomView(store,'public-work-room',options)};
}

test('normalized public work shows only explicit opt-ins and revokes immediately',t=>{
 const {store,send,task,page}=fixture(t);task('secret');task('visible',true);
 const first=page();assert.deepEqual(first.document.tasks.map(x=>x.title),['Task visible']);
 assert.equal(first.document.coverage.tasks.available,true);assert.doesNotMatch(first.html,/Task secret|Public receipts/);
 assert.deepEqual(first.document.tasks[0].nextRead.arguments,{roomId:'public-work-room',workItemId:'visible'});
 assert.deepEqual(Object.keys(first.document.tasks[0]).sort(),['definitionOfDone','id','nextRead','title']);
 assert.match(first.html,/<ul class="public-tasks">[\s\S]*Task visible/);assert.equal(first.document.coverage.tasks.assignmentGranted,false);assert.equal(first.document.coverage.tasks.executionGranted,false);
 send('withdraw','work.public_set',{workItemId:'visible',enabled:false});assert.deepEqual(page().document.tasks,[]);
 send('republish','work.public_set',{workItemId:'visible',enabled:true});assert.equal(page().document.tasks.length,1);
 send('off','room.public_page_set',{enabled:false});assert.equal(page(),null);
 send('on','room.public_page_set',{enabled:true});assert.equal(page().document.tasks.length,1);
 unpublishPublic(store.db,{kind:'room',id:'public-work-room',byAccount:'operator',now:Date.now()});assert.equal(page(),null);
});

test('public work pages advance through only published tasks without duplicating or exposing private work',t=>{
 const {task,page}=fixture(t);for(let i=0;i<11;i++){task('private-'+i);task('public-'+String(i).padStart(2,'0'),true);}
 const all=[];let after='';
 for(let n=0;n<4;n++){
  const v=page({workAfter:after});all.push(...v.document.tasks.map(x=>x.id));
  const c=v.document.coverage.tasks;assert.ok(v.document.tasks.length<=4);
  if(!c.hasMore)break;assert.ok(c.nextAfter&&c.nextAfter!==after);assert.match(v.html,/More public tasks/);after=c.nextAfter;
 }
 assert.deepEqual(all,Array.from({length:11},(_,i)=>'public-'+String(i).padStart(2,'0')));
 assert.equal(new Set(all).size,11);
});

test('archiving a room withdraws its published work',t=>{
 const {task,send,page}=fixture(t);task('visible',true);send('archive','room.archived',{});assert.equal(page(),null);
});

test('an untrusted payload cannot publish private task text or alter a selected public task',t=>{
 for(const wasPublic of [false,true]){
  const {store,task,page}=fixture(t);task('target',wasPublic);
  const row=store.db.prepare("SELECT body FROM work_entities WHERE room_id=? AND work_id='target'").get('public-work-room');
  const value=JSON.parse(row.body);value.title='PRIVATE-TAMPERED-TITLE';value.publicTask={enabled:true};
  store.transaction(()=>withCurrentRoomWriter(store.db,'public-work-room',()=>store.db.prepare("UPDATE work_entities SET body=? WHERE room_id=? AND work_id='target'").run(JSON.stringify(value),'public-work-room')));
  assert.throws(page,/current_room_corrupt: work reference changed/);
 }
});

test('maximum legal Unicode instructions remain complete across pages',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom('public-work-room'),definition='界'.repeat(4096);
 const add=(type,data)=>events.push(event({roomId:'public-work-room',actorId:'owner',type,data}));
 for(let n=0;n<5;n++){
  add('work.proposed',{workItemId:'large-'+n,title:'Large '+n,definitionOfDone:definition,accountableMemberId:'owner'});
  add('work.public_set',{workItemId:'large-'+n,enabled:true});
 }
 store.initialize(events,{representation:'normalized-current-v1'});
 const owner=store.issueAccessKey('public-work-room','owner');store.command(owner,'public-work-room',{id:'page-on',type:'room.public_page_set',data:{enabled:true}});
 store.room=()=>{throw Error('Whole room hydration forbidden');};
 const page=options=>publicRoomView(store,'public-work-room',options);
 const first=page();assert.equal(first.document.tasks.length,4);assert.equal(first.document.coverage.tasks.hasMore,true);
 for(const item of first.document.tasks)assert.equal(item.definitionOfDone,definition);
 const second=page({workAfter:first.document.coverage.tasks.nextAfter});
 assert.deepEqual(second.document.tasks.map(x=>x.id),['large-4']);assert.equal(second.document.coverage.tasks.hasMore,false);
 for(const item of second.document.tasks)assert.equal(item.definitionOfDone,definition);
});

test('discovery uses its published-task index and never reads conversation storage',t=>{
 const {store,task}=fixture(t);task('secret');task('visible',true);
 const plan=store.db.prepare(`EXPLAIN QUERY PLAN SELECT work_id FROM work_entities INDEXED BY current_public_work_keys WHERE room_id=? AND ${CURRENT_PUBLIC_WORK_PREDICATE} AND work_id>? ORDER BY work_id LIMIT 5`).all('public-work-room','');
 assert.ok(plan.some(row=>/SEARCH work_entities USING INDEX current_public_work_keys/.test(row.detail)));
 const prepare=store.db.prepare.bind(store.db);
 store.db.prepare=sql=>{if(/\b(?:FROM|JOIN)\s+(?:messages|events)\b/i.test(sql))throw Error('Conversation read forbidden');return prepare(sql);};
 assert.deepEqual(readCurrentPublicWork(store,'public-work-room').tasks.map(x=>x.id),['visible']);
 store.db.exec('DROP INDEX current_public_work_keys');assert.throws(()=>readCurrentPublicWork(store,'public-work-room'),/owned serving schema changed/);
});

test('the additive index can be installed despite unrelated malformed private data without trusting it',t=>{
 const {store,task,page}=fixture(t);task('private');task('public',true);
 store.db.exec('DROP INDEX current_public_work_keys');
 store.transaction(()=>withCurrentRoomWriter(store.db,'public-work-room',()=>store.db.prepare("UPDATE work_entities SET body='malformed private JSON' WHERE room_id='public-work-room' AND work_id='private'").run()));
 store.db.exec(CURRENT_PUBLIC_WORK_INDEX_SQL);
 assert.deepEqual(page().document.tasks.map(x=>x.id),['public']);
 assert.throws(()=>readCurrentWorkItem(store.db,'public-work-room','private'),/work reference changed/);
});

test('published tasks later associated with private requests stay hidden and paging advances',t=>{
 const {store,send,task,page}=fixture(t);
 send('producer','member.added',{memberId:'producer',displayName:'Producer',kind:'agent',permissions:[]});
 for(let n=0;n<5;n++){
  const id='a-private-'+n;task(id,true);
  send('private-request-'+n,'message.posted',{messageId:'private-request-'+n,toMemberId:'producer',workItemId:id,requestKind:'reply',body:'Private request'});
 }
 task('z-public',true);
 const first=page();assert.deepEqual(first.document.tasks,[]);assert.equal(first.document.coverage.tasks.hasMore,true);
 assert.doesNotMatch(JSON.stringify(first.document),/Task a-private|Only the explicitly published instruction|a-private-/);
 assert.match(first.html,/More public tasks/);
 const second=page({workAfter:first.document.coverage.tasks.nextAfter});
 assert.deepEqual(second.document.tasks.map(x=>x.id),['z-public']);assert.equal(second.document.coverage.tasks.hasMore,false);
 store.transaction(()=>withCurrentRoomWriter(store.db,'public-work-room',()=>store.db.prepare("UPDATE current_room_records SET payload=? WHERE room_id='public-work-room' AND domain='workPrivacy' AND record_key='a-private-0'").run(JSON.stringify({version:1,requests:0,parties:{}}))));
 assert.throws(page,/current_room_corrupt/,'untrusted privacy metadata must not make the task public');
});
