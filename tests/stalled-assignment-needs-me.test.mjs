import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {STALLED_ASSIGNMENT_MS,stalledAssignmentStep} from '../server/current-work-list.mjs';

function fixture(t){
  const store=new RoomStore(':memory:');t.after(()=>{try{store.close();}catch{}});const events=initialRoom();
  const add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
  for(const id of ['worker','other'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:['accept_work','complete_work']});
  add('work.proposed',{workItemId:'silent',title:'Silent assignee',definitionOfDone:'d',accountableMemberId:'worker'});
  add('work.proposed',{workItemId:'accepted',title:'Accepted',definitionOfDone:'d',accountableMemberId:'other'});
  store.initialize(events,{representation:'normalized-current-v1'});
  const keys=Object.fromEntries(['owner','worker','other'].map(id=>[id,store.issueAccessKey('commons',id)]));
  store.command(keys.other,'commons',{id:'accept-1',type:'work.accepted',data:{workItemId:'accepted',expectedRevision:0}});
  return {store,keys,created:Date.parse(events.at(-1).at)};
}
const ids=page=>page.work.map(item=>item.id);

test('proposer sees an unaccepted assignment in needs_me only after the threshold',t=>{
  const {store,keys,created}=fixture(t),real=store.now;
  store.now=()=>created+STALLED_ASSIGNMENT_MS-1000;
  assert.deepEqual(ids(store.currentWorkListing(keys.owner,'commons',{focus:'needs_me'})),[]);
  store.now=()=>created+STALLED_ASSIGNMENT_MS+60000;
  const page=store.currentWorkListing(keys.owner,'commons',{focus:'needs_me'});
  assert.deepEqual(ids(page),['silent']);
  assert.equal(page.work[0].next.action,'stalled_assignment');
  assert.equal(page.work[0].next.assigneeId,'worker');
  assert.equal(page.work[0].next.memberId,'owner');
  assert.ok(page.work[0].next.stalledForMs>=STALLED_ASSIGNMENT_MS);
  // The assignee's own needs_me keeps its normal accept step.
  const mine=store.currentWorkListing(keys.worker,'commons',{focus:'needs_me'});
  assert.deepEqual(ids(mine),['silent']);assert.equal(mine.work[0].next.action,'accept');
  // Unrelated members never see it (other only sees its own accepted task).
  assert.deepEqual(ids(store.currentWorkListing(keys.other,'commons',{focus:'needs_me'})),['accepted']);
  store.now=real;
});

test('accepting clears the stalled surface for the proposer',t=>{
  const {store,keys,created}=fixture(t);
  store.command(keys.worker,'commons',{id:'accept-2',type:'work.accepted',data:{workItemId:'silent',expectedRevision:0}});
  store.now=()=>created+STALLED_ASSIGNMENT_MS*3;
  assert.deepEqual(ids(store.currentWorkListing(keys.owner,'commons',{focus:'needs_me'})),[]);
});

test('stalledAssignmentStep ignores self-assigned, superseded and malformed items',()=>{
  const base={id:'w',state:'proposed',revision:0,proposedById:'p',accountableMemberId:'a',createdAt:new Date(0).toISOString()};
  const late=STALLED_ASSIGNMENT_MS+1;
  assert.equal(stalledAssignmentStep(base,late,'p').action,'stalled_assignment');
  assert.equal(stalledAssignmentStep({...base,accountableMemberId:'p'},late,'p'),null);
  assert.equal(stalledAssignmentStep({...base,supersededBy:'x'},late,'p'),null);
  assert.equal(stalledAssignmentStep({...base,createdAt:'nope'},late,'p'),null);
  assert.equal(stalledAssignmentStep(base,late,'other'),null);
  assert.equal(stalledAssignmentStep({...base,state:'accepted'},late,'p'),null);
});
