import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';
import {readCurrentRecord} from '../server/current-room-repository.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {replayNdjsonInto} from '../server/restore-ndjson.mjs';
import {event} from '../src/events.js';
import {publicRoomView} from '../server/public-rooms.mjs';

test('normalized owner policy and trust changes persist through restart and export replay', t => {
  const dir=mkdtempSync(join(tmpdir(),'room-settings-'));
  let s=new RoomStore(join(dir,'room.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  s.initialize(initialRoom());
  const owner=s.issueAccessKey('commons','owner');
  s.command(owner,'commons',{id:'member',type:'member.added',data:{memberId:'peer',displayName:'Peer',kind:'agent',permissions:[]}});
  const peer=s.issueAccessKey('commons','peer');
  const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});
  operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'adopt',reason:'Synthetic test'},true);
  const cases=[['room.policy_set',{requireIndependentReview:true,requireOwnerDecision:true}],['room.trust_set',{enabled:true}]];
  for (const [type,data] of cases) {
    const before=s.headSequence('commons');
    assert.throws(()=>s.command(peer,'commons',{id:`denied-${type}`,type,data}),e=>e.code==='command_rejected' && /Only the Room owner/.test(e.message));
    assert.equal(s.headSequence('commons'),before);
    const command={id:`allowed-${type}`,type,data};
    const first=s.command(owner,'commons',command);
    const after=s.headSequence('commons');
    const retry=s.command(owner,'commons',command);
    assert.equal(retry.duplicate,true);assert.equal(retry.event.id,first.event.id);assert.equal(s.headSequence('commons'),after);
  }
  const head=s.headSequence('commons');
  assert.throws(()=>s.command(owner,'commons',{id:'invalid-policy',type:'room.policy_set',data:{requireIndependentReview:'yes',requireOwnerDecision:true}}));
  assert.throws(()=>s.command(owner,'commons',{id:'invalid-trust',type:'room.trust_set',data:{enabled:'no'}}));
  assert.equal(s.headSequence('commons'),head);
  s.close(); s=new RoomStore(join(dir,'room.sqlite'));
  const room=readCurrentRecord(s.db,'commons','metadata','room');
  assert.equal(room.policy.requireOwnerDecision,true); assert.equal(room.trust.enabled,true);
  const restored=new RoomStore(':memory:');
  try {
    const result=replayNdjsonInto(exportNdjsonText(s.db),restored);
    assert.equal(result.audit.ok,true);
    const recovered=readCurrentRecord(restored.db,'commons','metadata','room');
    assert.equal(recovered.policy.requireOwnerDecision,true); assert.equal(recovered.trust.enabled,true);
  } finally {restored.close();}
});

test('normalized settings changes govern subsequent work, including after trust is reenabled', t => {
  const s=new RoomStore(':memory:'); t.after(()=>s.close());
  const events=initialRoom();
  events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'human2',displayName:'Second Human',kind:'human',permissions:[]}}));
  events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'foreign',displayName:'Foreign Agent',kind:'agent',accountableHumanId:'human2',permissions:[]}}));
  events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'reviewer',displayName:'Reviewer Agent',kind:'agent',permissions:[]}}));
  s.initialize(events); const owner=s.issueAccessKey('commons','owner');
  const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});
  operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'adopt',reason:'Synthetic test'},true);
  const command=(id,type,data)=>s.command(owner,'commons',{id,type,data});
  const work=(id,extra={})=>({workItemId:id,title:'Synthetic work',definitionOfDone:'Saved',accountableMemberId:'foreign',...extra});
  command('trust-off','room.trust_set',{enabled:false});
  assert.throws(()=>command('foreign-denied','work.proposed',work('foreign-denied')),e=>e.code==='trust_off');
  command('trust-on','room.trust_set',{enabled:true});
  command('policy-on','room.policy_set',{requireIndependentReview:true,requireOwnerDecision:true});
  assert.throws(()=>command('no-review','work.proposed',work('no-review')),/requires independent review/i);
  command('with-review','work.proposed',work('with-review',{verifierMemberId:'reviewer'}));
  const saved=readCurrentRecord(s.db,'commons','workSummary','with-review');
  assert.equal(saved.work.independentVerificationRequired,true);
  assert.equal(saved.work.ownerDecisionRequired,true);
});

test('normalized settings remain writable after the room page is published', t => {
  const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const owner=s.issueAccessKey('commons','owner');
  const command=(id,type,data)=>s.command(owner,'commons',{id,type,data});
  command('publish','room.public_page_set',{enabled:true});
  const before=publicRoomView(s,'commons')?.document; assert.ok(before);
  command('policy','room.policy_set',{requireIndependentReview:true,requireOwnerDecision:true});
  command('trust','room.trust_set',{enabled:false});
  const room=readCurrentRecord(s.db,'commons','metadata','room');
  assert.equal(room.publicPage.enabled,true);assert.equal(room.policy.requireOwnerDecision,true);assert.equal(room.trust.enabled,false);
  const after=publicRoomView(s,'commons')?.document;assert.ok(after);
  assert.deepEqual(after.join,before.join);assert.equal(after.title,before.title);assert.equal(after.agentJoin.admission,before.agentJoin.admission);
});
