import test from 'node:test';import assert from 'node:assert/strict';import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';import {readConversation} from '../server/conversation-sync.mjs';import {auditRecovery} from '../server/recovery.mjs';import {readCurrentHead,readCurrentRecord} from '../server/current-room-repository.mjs';import {createLegacyInviteJourney,initializeCurrentInviteJourney} from './helpers/current-agent-invite-journey.mjs';
const joined='2026-11-01T00:00:00.000Z';
// Independent oracle: compare numeric instants, then original source order.
const oracle=(posted,sequence,activation)=>Date.parse(posted)>Date.parse(activation.at)||(Date.parse(posted)===Date.parse(activation.at)&&sequence>=activation.sequence);
test('normalized instant/source-sequence oracle covers offset ordering and late backdated arrivals',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const es=initialRoom();for(const e of es)e.at=joined;
 const add=(type,data,at=joined)=>{es.push(event({roomId:'commons',actorId:'owner',type,data,at}));return es.length;};
 add('room.history_visibility_set',{historyVisibility:'since_join'});
 const cases=[['before-offset','2026-11-01T01:00:00+01:00',true],['before-future','2026-11-01T00:00:00.001Z',true]];
 const positions=new Map();for(const[id,at]of cases)positions.set(id,add('message.posted',{messageId:id,body:id},at));
 const activation={sequence:add('member.added',{memberId:'joined',displayName:'Reader',kind:'agent',permissions:[]}),at:joined};
 for(const[id,at]of [['after-offset','2026-11-01T01:00:00+01:00'],['late-backdated','2026-10-31T23:59:59.999Z'],['late-backdated-offset','2026-11-01T00:30:00+01:00'],['later-offset','2026-10-31T23:30:00-01:00']]){cases.push([id,at]);positions.set(id,add('message.posted',{messageId:id,body:id},at));}
 add('message.edited',{messageId:'before-offset',body:'still hidden after edit',expectedMessageRevision:0},'2026-11-01T00:00:01.000Z');
 add('message.posted',{messageId:'private-after',body:'private owner/reviewer only',toMemberId:'reviewer'},'2026-11-01T00:00:01.000Z');
 // Add reviewer before message validation; this separate member is not the viewer.
 es.splice(2,0,event({roomId:'commons',actorId:'owner',type:'member.added',at:joined,data:{memberId:'reviewer',displayName:'Reviewer',kind:'agent',permissions:[]}}));activation.sequence++;for(const[id,seq]of positions)positions.set(id,seq+1);
 s.initialize(es,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','joined');
 for(const[id,at]of cases){const expected=oracle(at,positions.get(id),activation);if(expected)assert.equal(readConversation(s,key,'commons',{messageId:id}).messages[0].id,id);else assert.throws(()=>readConversation(s,key,'commons',{messageId:id}),e=>e.status===404,id);}
 assert.throws(()=>readConversation(s,key,'commons',{messageId:'private-after'}),e=>e.status===404);
 const head=s.readTransaction(()=>readCurrentHead(s.db,'commons'));assert.equal(head.counts.historyFloors,head.counts.members);assert.equal(head.counts.historyExclusions,0);assert.doesNotThrow(()=>auditRecovery(s));
});
for(const reactivate of [false,true])test(`since-join invitation ${reactivate?'reactivates':'adds'} exact activation atomically and retry preserves floor`,t=>{
 const legacy=new RoomStore(':memory:');t.after(()=>legacy.close());const snapshot=createLegacyInviteJourney(legacy,{reactivate,historyVisibility:'since_join'}),clock=Date.now()+1000,at=new Date(clock).toISOString(),offset=new Date(clock+3600000).toISOString().replace('Z','+01:00');
 snapshot.rooms[0].push(event({roomId:'commons',actorId:'owner',type:'message.posted',at:offset,data:{messageId:'before-invite',body:'not for new arrival'}}));
 const s=new RoomStore(':memory:');t.after(()=>s.close());const f=initializeCurrentInviteJourney(s,snapshot);s.now=()=>clock;
 const options={identitySecret:f.peer.secret,requestId:'floor-invite',displayName:'Friend existing agent'},result=s.invites.redeem(f.issued.code,options),floor=()=>s.readTransaction(()=>readCurrentRecord(s.db,'commons','historyFloors',result.memberId)),first=floor();
 assert.equal(first.version,2);assert.equal(first.at,at);assert.throws(()=>readConversation(s,f.peer.secret,'commons',{messageId:'before-invite'}),e=>e.status===404);
 s.command(f.ownerKey,'commons',{id:'after-invite',type:'message.posted',data:{messageId:'after-invite',body:'visible after invitation'}});assert.equal(readConversation(s,f.peer.secret,'commons',{messageId:'after-invite'}).messages[0].body,'visible after invitation');
 assert.equal(s.invites.redeem(f.issued.code,options).duplicate,true);assert.deepEqual(floor(),first);assert.doesNotThrow(()=>auditRecovery(s));
});
import {withCurrentServingWriter} from '../server/current-room-repository.mjs';
test('missing or corrupt protected activation/message facts refuse rather than exposing history',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const es=initialRoom();for(const e of es)e.at=joined;es.push(event({roomId:'commons',actorId:'owner',at:joined,type:'room.history_visibility_set',data:{historyVisibility:'since_join'}}),event({roomId:'commons',actorId:'owner',at:joined,type:'member.added',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}}),event({roomId:'commons',actorId:'owner',at:joined,type:'message.posted',data:{messageId:'visible',body:'Only protected facts authorize this'}}));s.initialize(es,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','reader');
 for(const[domain,id]of [['historyFloors','reader'],['messageWitness','visible']]){
  const rollback=Error('synthetic fault rollback');assert.throws(()=>s.transaction(()=>{withCurrentServingWriter(s.db,'commons',()=>{s.db.prepare('DELETE FROM current_room_records WHERE room_id=? AND domain=? AND record_key=?').run('commons',domain,id);assert.throws(()=>readConversation(s,key,'commons',{messageId:'visible'}),/corrupt|changed|missing/);});throw rollback;}),e=>e===rollback);
 }
 assert.equal(readConversation(s,key,'commons',{messageId:'visible'}).messages[0].id,'visible');assert.doesNotThrow(()=>auditRecovery(s));
});

import {historyActivationValue,historyJoinPoint} from '../server/history-visibility.mjs';
test('v2 never promotes a missing activation into a finite timestamp sentinel',()=>{assert.throws(()=>historyActivationValue(historyJoinPoint(null,10)),/Missing qualified member activation source/);});
