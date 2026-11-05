import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';

function fixture(t) {
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 const events=initialRoom();
 for(const id of ['worker','other'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,kind:'agent',displayName:id,permissions:[]}}));
 for(let i=0;i<500;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:i===499?'zz-owned':`task-${String(i).padStart(4,'0')}`,title:'Useful task',definitionOfDone:'Exact saved result',accountableMemberId:i===499?'worker':'other'}}));
 for(let i=0;i<13;i++)events.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:i===12?'zz-request':`request-${i}`,body:'PRIVATE BODY',requestKind:'reply',requestPolicyVersion:1,toMemberId:i===12?'worker':'other'}}));
 store.initialize(events,{representation:'normalized-current-v1'});
 const key=store.issueAccessKey('commons','worker');
 store.room=()=>{throw Error('unbounded room hydration');};
 return {store,key};
}
test('standing needs-me enumeration seeks addressed sources instead of walking 500 unrelated tasks',t=>{
 const {store,key}=fixture(t);let cursor,calls=0;const work=[],requests=[];
 do {
  const read=store.currentWorkListing(key,'commons',{focus:'needs_me',limit:1,...(cursor?{cursor}:{})});calls++;
  work.push(...read.work.map(item=>item.id));requests.push(...read.replyRequests.map(item=>item.id));cursor=read.page.nextCursor;
  assert.ok(calls<=2,'Late owned work and request must not require a 500-page unrelated-source traversal');
 }while(cursor);
 assert.deepEqual(work,['zz-owned']);assert.deepEqual(requests,['zz-request']);
});

import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
import {nextWorkStep} from '../src/workflow.js';
import {readWorkItem} from '../server/work-repository.mjs';
import {textVersion} from '../server/text-results.mjs';
test('role streams preserve full workflow attention, deduplicate roles, and continue after empty residual pages',t=>{
 const source=new RoomStore(':memory:');t.after(()=>source.close());
 const events=initialRoom();
 for(const [id,kind,permissions] of [['worker','agent',['accept_work','complete_work','verify']],['reviewer','human',['decide']]])
  events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind,permissions}}));
 const tasks=[...Array.from({length:4},(_,i)=>({id:`a-running-${i}`,accountable:'worker'})),{id:'z-attend',accountable:'worker'},{id:'z-duplicate',accountable:'worker',verifierMemberId:'worker'},
  {id:'z-handoff',accountable:'worker'},{id:'z-review',accountable:'owner',verifierMemberId:'worker',independentVerificationRequired:true},
  {id:'z-decide',accountable:'owner',humanDecisionMakerId:'reviewer',ownerDecisionRequired:true}];
 for(const task of tasks)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:task.id,title:task.id,definitionOfDone:'Saved exact result',accountableMemberId:task.accountable,...Object.fromEntries(Object.entries(task).filter(([key])=>!['id','accountable'].includes(key)))}}));
 source.initialize(events);
 let keys=Object.fromEntries(['owner','worker','reviewer'].map(id=>[id,source.issueAccessKey('commons',id)]));let serial=0;
 const send=(actor,type,data)=>source.command(keys[actor],'commons',{id:`attention-command-${++serial}`,type,data});
 const item=id=>readWorkItem(source.db,'commons',id);
 for(let i=0;i<4;i++)for(const type of ['work.accepted','work.started'])send('worker',type,{workItemId:`a-running-${i}`,expectedRevision:item(`a-running-${i}`).revision});
 send('worker','work.accepted',{workItemId:'z-handoff',expectedRevision:0});
 send('worker','work.handoff_recorded',{workItemId:'z-handoff',expectedRevision:item('z-handoff').revision,doneSummary:'Saved partial result',nextAction:'Review',limitReason:'Human choice'});
 for(const id of ['z-review','z-decide']) {
  for(const type of ['work.accepted','work.started'])send('owner',type,{workItemId:id,expectedRevision:item(id).revision});
  const body=`Saved result for ${id}`,posted=send('owner','message.posted',{messageId:`result-${id}`,workItemId:id,body});
  send('owner','work.completed',{workItemId:id,expectedRevision:item(id).revision,evidenceKind:'room_text',evidenceMessageId:`result-${id}`,evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Saved',nextAction:'Review'});
 }
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 // Qualify reader semantics against valid recorded lifecycle history. The
 // normalized handoff writer is a separately tracked unsupported dependency.
 store.initialize(source.db.prepare('SELECT body FROM events ORDER BY sequence').all().map(row=>JSON.parse(row.body)),{representation:'normalized-current-v1'});
 keys=Object.fromEntries(['owner','worker','reviewer'].map(id=>[id,store.issueAccessKey('commons',id)]));
 const full=store.readTransaction(()=>readCurrentRoomForAudit(store,'commons'));
 store.room=()=>{throw Error('No whole-room read during serving');};
 for(const id of ['worker','reviewer','owner']) {
  const expected=Object.values(full.state.workItems).filter(work=>{const next=nextWorkStep(work,store.now(),'owner');return next.memberId===id&&next.needsAttention;}).map(work=>work.id).sort();
  let cursor,emptyMore=false;const listed=[];
  for(let calls=0;calls<20;calls++) {
   const page=store.currentWorkListing(keys[id],'commons',{focus:'needs_me',limit:1,...(cursor?{cursor}:{})});
   listed.push(...page.work.map(work=>work.id));if(!page.work.length&&page.page.hasMore)emptyMore=true;
   cursor=page.page.nextCursor;if(!cursor)break;
  }
  assert.equal(cursor,null);assert.deepEqual(listed.sort(),expected);assert.equal(new Set(listed).size,listed.length);
  if(id==='worker')assert.equal(emptyMore,true,'A non-actionable role candidate must not terminate the walk');
 }
});

test('addressed needs-me preserves existing role-holder access without leaking request bodies and verifies the owner index',t=>{
 const {store,key}=fixture(t),owner=store.issueAccessKey('commons','owner');
 store.command(owner,'commons',{id:'private-task-context',type:'message.posted',data:{messageId:'private-task-context',workItemId:'zz-owned',requestKind:'reply',toMemberId:'other',body:'Private work discussion'}});
 const page=store.currentWorkListing(key,'commons',{focus:'needs_me',limit:1});
 assert.equal(page.work[0].id,'zz-owned');assert.equal(page.work[0].title,'Useful task','Existing workRoleHolder policy keeps assigned task context available');
 assert.equal(JSON.stringify(page).includes('Private work discussion'),false);
 const name='current_inbox_owner_handoffs',before=store.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;
 store.db.exec('DROP INDEX '+name);store.db.exec(before.replace("$.work.handoff.open')=1","$.work.handoff.open')=0"));
 const after=store.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;
 assert.notEqual(after,before);assert.equal(Buffer.byteLength(after),Buffer.byteLength(before));
 assert.throws(()=>store.currentWorkListing(key,'commons',{focus:'needs_me'}),/owned serving schema changed/);
});
