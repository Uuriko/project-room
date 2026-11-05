import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {buildOrient,readComposedRoomContext} from '../server/orient.mjs';

test('normalized context preserves private brief titles only for parties and role holders',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 const add=(type,data,actorId='owner')=>events.push(event({id:'fixture-'+events.length,roomId:'commons',actorId,type,data}));
 for(const memberId of ['producer','observer'])add('member.added',{memberId,displayName:memberId,kind:'agent',permissions:[]});
 add('work.proposed',{workItemId:'private-brief',title:'PRIVATE-NORMALIZED-TITLE',definitionOfDone:'PRIVATE-NORMALIZED-DONE',accountableMemberId:'producer'});
 add('work.proposed',{workItemId:'public-brief',title:'PUBLIC-NORMALIZED-TITLE',definitionOfDone:'Public done',accountableMemberId:'producer'});
 add('message.posted',{messageId:'private-question',toMemberId:'producer',workItemId:'private-brief',requestKind:'reply',requestPolicyVersion:1,body:'PRIVATE-NORMALIZED-BODY'});
 // Synthetic journal fixture: no onboarding or consent-approval claim.
 store.initialize(events,{representation:'normalized-current-v1'});assert.equal(store.db.prepare("SELECT count(*) n FROM current_room_records WHERE domain='replyRequests'").get().n,1,'journal fixture must contain a real policy-stamped request');store.room=()=>{throw Error('whole-room hydration');};
 for(const viewer of ['owner','producer'])assert.ok(JSON.stringify(buildOrient(store,'commons',viewer)).includes('PRIVATE-NORMALIZED-TITLE'));
 const token=store.issueAccessKey('commons','observer');
 for(const value of [buildOrient(store,'commons','observer'),readComposedRoomContext(store,token,'commons')]){
  const text=JSON.stringify(value);assert.equal(text.includes('PRIVATE-NORMALIZED-TITLE'),false);assert.ok(text.includes('PUBLIC-NORMALIZED-TITLE'));assert.equal(text.includes('PRIVATE-NORMALIZED-DONE'),false);assert.equal(text.includes('PRIVATE-NORMALIZED-BODY'),false);
 }
});

import {buildActivationPack} from '../server/room-activation-pack.mjs';
import {auditRecovery} from '../server/recovery.mjs';
test('private request index qualifies each work independently of unrelated request backlog',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'producer',displayName:'Producer',kind:'agent',permissions:[]}}));
 for(const id of ['public','private'])events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:id,title:id+' useful work',definitionOfDone:'Saved evidence',accountableMemberId:'producer'}}));
 for(let i=0;i<12;i++)events.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'private-'+i,toMemberId:'producer',workItemId:'private',requestKind:'reply',requestPolicyVersion:1,body:'Private request '+i}}));
 store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner');store.room=()=>{throw Error('full room');};
 assert.equal(store.workContext(key,'commons','public').work.id,'public');
 assert.throws(()=>store.workContext(key,'commons','private'),/continuation for this work/);
 assert.equal(buildActivationPack(store,'commons','owner').workWindow.total,2);
 assert.doesNotThrow(()=>auditRecovery(store));
});

test('actual current request and response maintain privacy links atomically with exact retry',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();for(const memberId of ['producer','observer'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[]}}));
 store.initialize(events,{representation:'normalized-current-v1'});const owner=store.issueAccessKey('commons','owner'),producer=store.issueAccessKey('commons','producer');store.room=()=>{throw Error('full room');};
 store.command(owner,'commons',{id:'propose-private',type:'work.proposed',data:{workItemId:'private',title:'ACTUAL-PRIVATE-TITLE',definitionOfDone:'Private definition',accountableMemberId:'producer'}});
 assert.ok(JSON.stringify(buildOrient(store,'commons','observer')).includes('ACTUAL-PRIVATE-TITLE'));
 const command={id:'ask-private',type:'message.posted',data:{messageId:'ask-private',toMemberId:'producer',workItemId:'private',requestKind:'reply',body:'Actual private request'}};
 const asked=store.command(owner,'commons',command);assert.equal(asked.event.data.requestPolicyVersion,1);
 assert.ok(!JSON.stringify(buildOrient(store,'commons','observer')).includes('ACTUAL-PRIVATE-TITLE'));
 assert.ok(!JSON.stringify(buildActivationPack(store,'commons','observer')).includes('ACTUAL-PRIVATE-TITLE'));
 assert.ok(JSON.stringify(buildOrient(store,'commons','producer')).includes('ACTUAL-PRIVATE-TITLE'));
 const before=store.db.prepare('SELECT * FROM operator_actions ORDER BY id').all();assert.equal(store.command(owner,'commons',command).duplicate,true);assert.deepEqual(store.db.prepare('SELECT * FROM operator_actions ORDER BY id').all(),before);
 const observer=store.issueAccessKey('commons','observer');assert.equal(store.workContext(observer,'commons','private').work.title,null);
 const selected=store.workContext(producer,'commons','private');assert.equal(selected.work.id,'private');
 store.command(producer,'commons',{id:'answer-private',type:'message.posted',data:{messageId:'answer-private',toMemberId:'owner',replyToId:'ask-private',workItemId:'private',responseToRequestId:'ask-private',expectedRequestRevision:0,responseOutcome:'answered',contextEventId:asked.event.id,contextSequence:asked.sequence,body:'Saved private answer'}});
 assert.ok(!JSON.stringify(buildOrient(store,'commons','observer')).includes('ACTUAL-PRIVATE-TITLE'));
 assert.doesNotThrow(()=>auditRecovery(store));
});
