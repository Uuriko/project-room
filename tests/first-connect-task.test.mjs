// First-connect task: a new agent's room_join result names one finishable
// first task when ROOM_FIRST_CONNECT_TASK=1; off by default (no change).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createRoomServer} from '../server/http.mjs';
import {
  firstConnectTask,firstConnectTaskEnabled,
  INTRO_BODY_TEMPLATE,INTRO_SKILL_SLOT,FIRST_CONNECT_SUCCESS_METRIC,
  fillIntroBody,isTemplateIntroBody,firstConnectSuccess,isUnfilledIntroBody,firstConnectReport,
} from '../server/first-connect-task.mjs';

async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'first-connect-'));const store=new RoomStore(join(dir,'db'));
  const owner=store.identities.create('Founder'),roomId='qa-first-connect';
  new AgentRooms(store).create(owner.secret,{roomId,title:'QA',purpose:'Useful work',starter:false,visibility:'private'});
  const command=(type,data)=>store.command(owner.secret,roomId,{id:type,type,data});
  command('room.public_page_set',{enabled:true});command('room.join_link_set',{enabled:true});
  const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});delete process.env.ROOM_FIRST_CONNECT_TASK;});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(secret,args)=>{const r=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({jsonrpc:'2.0',id:'t',method:'tools/call',params:{name:'room_join',arguments:args}})});return (await r.json()).result?.structuredContent;};
  return {store,roomId,call,origin};
}

test('flag off by default: room_join result is unchanged (no firstTask)',async t=>{
  delete process.env.ROOM_FIRST_CONNECT_TASK;const f=await fixture(t);
  const joined=await f.call(f.store.identities.create('Newcomer').secret,{roomId:f.roomId});
  assert.equal(joined.status,'approved');assert.equal(joined.firstTask,undefined);
  assert.equal(firstConnectTaskEnabled({}),false);
});

test('flag on: a new agent gets one finishable first task, and a rejoin does not',async t=>{
  process.env.ROOM_FIRST_CONNECT_TASK='1';const f=await fixture(t);
  const peer=f.store.identities.create('Newcomer');
  const joined=await f.call(peer.secret,{roomId:f.roomId});
  assert.equal(joined.status,'approved');
  assert.equal(joined.firstTask.source,'intro');
  assert.equal(joined.firstTask.roomId,f.roomId);
  assert.equal(joined.firstTask.action.tool,'room_post_message');
  assert.equal(joined.firstTask.action.arguments.roomId,f.roomId);
  assert.equal(joined.firstTask.action.arguments.body,INTRO_BODY_TEMPLATE);
  assert.equal(joined.firstTask.action.requiredSlots.skill.required,true);
  assert.equal(joined.firstTask.action.requiredSlots.skill.placeholder,INTRO_SKILL_SLOT);
  assert.deepEqual(joined.firstTask.successMetric,FIRST_CONNECT_SUCCESS_METRIC);
  assert.ok(joined.firstTask.done);
  assert.equal(joined.firstTask.action.arguments.body.includes('<one concrete skill>'),false);
  const before=f.store.headSequence(f.roomId);
  const again=await f.call(peer.secret,{roomId:f.roomId});
  assert.equal(again.alreadyMember,true);assert.equal(again.firstTask,undefined);
  assert.equal(f.store.headSequence(f.roomId),before,'the hint never posts for the agent');
});

test('prefers a claimable public-work starter in the joined room',()=>{
  const calls=[];
  const store={publicWorkClaims:{list:(args)=>{calls.push(args);return {tasks:[{taskId:'t_1',title:'Fix a typo'}]};}}};
  const task=firstConnectTask(store,'r',{env:{ROOM_FIRST_CONNECT_TASK:'1'}});
  assert.equal(task.source,'public_work');
  assert.equal(task.roomId,'r');
  assert.deepEqual(task.nextRead,{tool:'public_work_read_task',arguments:{taskId:'t_1'}});
  assert.deepEqual(task.successMetric,FIRST_CONNECT_SUCCESS_METRIC);
  assert.deepEqual(calls,[{limit:1,claimable:true,roomId:'r'}]);
  assert.equal(task.scope,'joined_room');
});

test('joined-room-first: an empty room falls back to the public board, then to the intro',()=>{
  const calls=[];
  const board={publicWorkClaims:{list:(args)=>{calls.push(args);return {tasks:args.roomId?[]:[{taskId:'t_x',title:'Elsewhere'}]};}}};
  const task=firstConnectTask(board,'r',{env:{ROOM_FIRST_CONNECT_TASK:'1'}});
  assert.equal(task.source,'public_work');assert.equal(task.taskId,'t_x');assert.equal(task.scope,'public_board');
  assert.deepEqual(calls,[{limit:1,claimable:true,roomId:'r'},{limit:1,claimable:true}]);
  const empty={publicWorkClaims:{list:()=>({tasks:[]})}};
  const intro=firstConnectTask(empty,'r',{env:{ROOM_FIRST_CONNECT_TASK:'1'}});
  assert.equal(intro.source,'intro');assert.equal(intro.action.arguments.roomId,'r');
});

test('starter-list failure logs structured warn and falls back to intro',()=>{
  const logs=[];
  const broken={publicWorkClaims:{list:()=>{throw Error('x');}}};
  const task=firstConnectTask(broken,'r',{env:{ROOM_FIRST_CONNECT_TASK:'1'},warn:(line)=>logs.push(line)});
  assert.equal(task.source,'intro');
  assert.equal(logs.length,1);
  const payload=JSON.parse(logs[0]);
  assert.equal(payload.event,'first_connect_task.public_work_list_failed');
  assert.equal(payload.roomId,'r');
  assert.equal(payload.error,'x');
  assert.equal(firstConnectTask(broken,'r',{env:{}}),null);
});

test('required skill slot: fillIntroBody rejects blank and fills the template',()=>{
  assert.equal(fillIntroBody(''),null);
  assert.equal(fillIntroBody('   '),null);
  assert.equal(fillIntroBody(null),null);
  const filled=fillIntroBody('review PRs');
  assert.ok(filled.includes('review PRs'));
  assert.equal(filled.includes(INTRO_SKILL_SLOT),false);
  assert.equal(isTemplateIntroBody(INTRO_BODY_TEMPLATE),true);
  assert.equal(isTemplateIntroBody(filled),false);
  assert.equal(isTemplateIntroBody('Hi, I just connected. I can help with: <one concrete skill>. Reply with a small task and I\'ll take it.'),true);
});

test('success metric: non-template post or claim within 10 minutes',()=>{
  const joinedAt=1_000_000;
  const windowMs=FIRST_CONNECT_SUCCESS_METRIC.windowMs;
  assert.equal(FIRST_CONNECT_SUCCESS_METRIC.windowMs,10*60*1000);
  assert.deepEqual(
    firstConnectSuccess({joinedAt,now:joinedAt+60_000,events:[{type:'post',at:joinedAt+1_000,body:INTRO_BODY_TEMPLATE}]}),
    {success:false,at:null,kind:null},
    'template post does not count'
  );
  assert.deepEqual(
    firstConnectSuccess({joinedAt,now:joinedAt+60_000,events:[{type:'post',at:joinedAt+1_000,body:fillIntroBody('ship docs')}]}),
    {success:true,at:joinedAt+1_000,kind:'post'}
  );
  assert.deepEqual(
    firstConnectSuccess({joinedAt,now:joinedAt+60_000,events:[{type:'claim',at:joinedAt+2_000}]}),
    {success:true,at:joinedAt+2_000,kind:'claim'}
  );
  assert.deepEqual(
    firstConnectSuccess({joinedAt,now:joinedAt+windowMs+1,events:[{type:'claim',at:joinedAt+windowMs+1}]}),
    {success:false,at:null,kind:null},
    'outside the 10-minute window'
  );
});

test('success metric takes the earliest qualifying action whatever the input order',()=>{
  const joinedAt=1_000_000;
  const result=firstConnectSuccess({joinedAt,now:joinedAt+600_000,events:[{type:'post',at:joinedAt+300_000,body:'later'},{type:'claim',at:joinedAt+60_000}]});
  assert.deepEqual(result,{success:true,at:joinedAt+60_000,kind:'claim'});
});

test('an unfilled intro is refused at admission; a message that mentions the slot still posts',async t=>{
  const f=await fixture(t);
  const agent=f.store.identities.create('Newcomer');await f.call(agent.secret,{roomId:f.roomId});
  assert.equal(isUnfilledIntroBody(INTRO_BODY_TEMPLATE),true);assert.equal(isUnfilledIntroBody(fillIntroBody('SQL reviews')),false);
  const post=(id,body)=>f.store.command(agent.secret,f.roomId,{id,type:'message.posted',data:{messageId:id,body}});
  assert.throws(()=>post('raw',INTRO_BODY_TEMPLATE),err=>err.code==='intro_slot_unfilled'||/intro_slot_unfilled|\{\{skill\}\}/.test(err.message));
  assert.doesNotThrow(()=>post('filled',fillIntroBody('SQL reviews')));
  assert.doesNotThrow(()=>post('talk','The template uses {{skill}} as its slot name.'));
});

test('first-connect report measures agent joins against the 10-minute window',async t=>{
  const f=await fixture(t);
  // The fixture's room creator is itself an agent member: compare against a
  // baseline taken at the same instants before our two joins.
  const now=Date.now()+60_000,later=now+11*60_000;
  const before=firstConnectReport(f.store.db,{now}),beforeLater=firstConnectReport(f.store.db,{now:later});
  const addAgent=async name=>{const who=f.store.identities.create(name);await f.call(who.secret,{roomId:f.roomId});return who;};
  const quick=await addAgent('Quick');await addAgent('Quiet');
  f.store.command(quick.secret,f.roomId,{id:'hello',type:'message.posted',data:{messageId:'hello',body:fillIntroBody('test triage')}});
  const live=firstConnectReport(f.store.db,{now}),after=firstConnectReport(f.store.db,{now:later});
  assert.deepEqual([live.joins-before.joins,live.success-before.success,live.pending-before.pending,live.byKind.post-before.byKind.post],[2,1,1,1]);
  assert.deepEqual([after.success-beforeLater.success,after.timeout-beforeLater.timeout,after.pending],[1,1,0]);
  assert.throws(()=>firstConnectReport(f.store.db,{days:0}),{code:'invalid_days'});
});

// f5931: a public-work claim writes no room event; the report reads the claim
// stamp and attributes it to the claiming identity's join, for both the
// joined-room starter and the public-board fallback.
test('first-connect report counts the suggested public-work claim, joined room and public board',async t=>{
  const f=await fixture(t);
  const ownerMember=f.store.db.prepare("SELECT member_id AS m FROM identity_links WHERE room_id=?").get(f.roomId).m;
  const offer=(roomId,ownerId,offerId)=>{
    f.store.projectOffers.create(roomId,ownerId,{requestId:'create-'+offerId,offerId,reviewerMemberIds:[ownerId],terms:{kind:'task',title:'Starter '+offerId,summary:'Synthetic public work',acceptanceCriteria:['Return exact bytes'],repositoryUrl:'https://github.com/example/project',reward:{kind:'unpaid'},approvalPolicy:{mode:'agent'}}});
    f.store.projectOffers.transition(roomId,ownerId,offerId,'publish',{requestId:'publish-'+offerId,expectedRevision:1});
    f.store.publicWorkClaims.enable(roomId,ownerId,offerId,{requestId:'enable-'+offerId,expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:[offerId.replace(/\W/g,'-')+'.js']});
  };
  offer(f.roomId,ownerMember,'fc:starter');
  // A second room with no public work: its joiner gets the public-board starter.
  const host=f.store.identities.create('Board host');
  new AgentRooms(f.store).create(host.secret,{roomId:'qa-empty',title:'Empty',purpose:'No tasks',starter:false,visibility:'private'});
  f.store.command(host.secret,'qa-empty',{id:'pp',type:'room.public_page_set',data:{enabled:true}});
  f.store.command(host.secret,'qa-empty',{id:'jl',type:'room.join_link_set',data:{enabled:true}});
  const rpc=async(secret,name,args)=>{const r=await fetch(f.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({jsonrpc:'2.0',id:'t',method:'tools/call',params:{name,arguments:args}})});const body=await r.json();assert.ok(!body.error&&!body.result?.isError,JSON.stringify(body));return body.result.structuredContent;};
  process.env.ROOM_FIRST_CONNECT_TASK='1';
  const now=Date.now()+60_000,later=now+11*60_000;
  const before=firstConnectReport(f.store.db,{now}),beforeLater=firstConnectReport(f.store.db,{now:later});
  const roomAgent=f.store.identities.create('Room agent'),boardAgent=f.store.identities.create('Board agent');
  const scopes=[];
  for(const [who,roomId] of [[roomAgent,f.roomId],[boardAgent,'qa-empty']]){
    const joined=await f.call(who.secret,{roomId});
    const task=joined.firstTask;assert.equal(task?.taskId,'fc:starter',JSON.stringify(joined));scopes.push(task.scope);
    if(who===roomAgent){
      await rpc(who.secret,'public_work_claim',{taskId:task.taskId,requestId:'claim-'+who.identityId,expectedTermsVersion:1});
      // The board agent's claim races the room agent's held lease: release it first.
      const held=f.store.publicWorkClaims.read('fc:starter').claim;
      await rpc(who.secret,'public_work_release',{taskId:task.taskId,requestId:'release-'+who.identityId,expectedTermsVersion:1,generation:held.generation});
    } else await rpc(who.secret,'public_work_claim',{taskId:task.taskId,requestId:'claim-'+who.identityId,expectedTermsVersion:1});
  }
  assert.deepEqual(scopes,['joined_room','public_board']);
  const live=firstConnectReport(f.store.db,{now}),after=firstConnectReport(f.store.db,{now:later});
  assert.deepEqual([live.joins-before.joins,live.success-before.success,live.byKind.claim-before.byKind.claim,live.pending-before.pending],[2,2,2,0]);
  assert.deepEqual([after.success-beforeLater.success,after.timeout-beforeLater.timeout],[2,0]);
  // The host who created the empty room never claimed: no claim is borrowed from another identity.
  assert.equal(after.joins-beforeLater.joins,2);
});
