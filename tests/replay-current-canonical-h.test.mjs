import {auditRecovery} from '../server/recovery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../server/replay-cutover.mjs';
function setup(t,mutate=()=>{},{archive=false,retain=false,initialWork=[]}={}){const store=new RoomStore(':memory:',{maintainMessageCertification:true});t.after(()=>store.close());store.initialize([...initialRoom(),...initialWork,event({id:'root-post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'root',body:'Canonical original'}}),event({id:'reply-post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'reply',body:'Canonical reply',replyToId:'root'}})]);while(!store.backfillMessages({limit:200}).done){}assert.equal(store.checkMessagesParity({roomId:'commons'}).ok,true);if(archive){const key=store.issueAccessKey('commons','owner');for(let i=0;i<6;i++)store.command(key,'commons',{id:'extra-'+i,type:'message.posted',data:{messageId:'extra-'+i,body:'Standalone archived history '+i}});while(!store.backfillMessages({limit:200}).done){}store.checkMessagesParity({roomId:'commons'});if(retain)store.command(key,'commons',{id:'retain-root',type:'message.pinned',data:{messageId:'root'}});assert.equal(store.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);store.checkMessagesParity({roomId:'commons'});}
store.migrateMessageAuthority('commons');mutate(store);const prepare=()=>{store.db.exec(replayCutoverSchema());const capture=captureReplayWitness(store,{roomId:'commons',requestId:'capture',expectedHead:store.headSequence('commons'),reason:'Canonical H conversion qualification'});let progress={bytes:0},n=0;while(progress.phase!=='witness_verified')progress=advanceReplayWitness(store,{roomId:'commons',generation:capture.generation,requestId:'hash-'+n++,expectedBytes:progress.bytes});progress={bytes:0};n=0;while(progress.phase!=='codec_partitioned')progress=partitionReplayWitness(store,{roomId:'commons',generation:capture.generation,requestId:'codec-'+n++,expectedBytes:progress.bytes});let work={workCount:0},workStep=0;do{work=qualifyReplayHWork(store,{roomId:'commons',generation:capture.generation,requestId:'work-'+workStep++,expectedWorkCount:work.workCount});}while(!work.workDefaultsQualified&&workStep<100);return{store,capture};};return archive?{store,prepare}:prepare();}
test('actual canonical-authority room qualifies complete H rather than refusing its format',t=>{const f=setup(t);let result={hMessageSteps:0},n=0;do{result=qualifyReplayHMessages(f.store,{roomId:'commons',generation:f.capture.generation,requestId:'messages-'+n++,expectedSteps:result.hMessageSteps});}while(!result.hMessagesQualified&&n<100);assert.equal(result.hMessagesQualified,true);assert.equal(result.hMessageCount,2);assert.equal(result.certified,false);assert.equal(result.historyProvenance,'unknown');});

import {messageProofHash} from '../server/write-integrity.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
function qualify(f){let result={hMessageSteps:0},n=0;do{result=qualifyReplayHMessages(f.store,{roomId:'commons',generation:f.capture.generation,requestId:'qualified-'+n++,expectedSteps:result.hMessageSteps});assert.ok(result.inputBytes<=262144);}while(!result.hMessagesQualified&&n<500);assert.equal(result.hMessagesQualified,true);return result;}
function convert(f){let result={currentSteps:0},n=0;do{result=advanceCurrentRoomConversion(f.store,{roomId:'commons',generation:f.capture.generation,requestId:'convert-'+n++,expectedSteps:result.currentSteps});}while(result.phase!=='current_serving'&&n<500);assert.equal(result.phase,'current_serving');return result;}
test('canonical existing H converts through actual post/reply endpoint with unchanged old hashes',t=>{
 const f=setup(t),before=f.store.db.prepare('SELECT message_id,entity_hash FROM messages ORDER BY message_id').all();qualify(f);convert(f);
 assert.deepEqual(f.store.db.prepare('SELECT message_id,entity_hash FROM messages ORDER BY message_id').all(),before);
 const key=f.store.issueAccessKey('commons','owner');f.store.room=()=>{throw Error('full legacy room read');};
 f.store.command(key,'commons',{id:'after',type:'message.posted',data:{messageId:'after',body:'Canonical converted useful reply',replyToId:'root'}});
 assert.equal(readConversation(f.store,key,'commons',{messageId:'after',limit:5}).messages[0].body,'Canonical converted useful reply');
 const state=f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state);assert.equal(state.messages.length,3);
});
test('canonical H digest rejects self-consistent unregistered row mutation',t=>{
 const f=setup(t,store=>{const row=store.db.prepare("SELECT * FROM messages WHERE message_id='root'").get();row.body='Unregistered replacement';row.record_json=JSON.stringify({...JSON.parse(row.record_json),body:row.body});row.entity_hash=messageProofHash(row);store.db.prepare('UPDATE messages SET body=?,record_json=?,entity_hash=? WHERE message_id=?').run(row.body,row.record_json,row.entity_hash,'root');});
 assert.throws(()=>qualify(f),/complete content digest differs/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);
});
test('canonical H membership rejects missing independent canonical member',t=>{
 const f=setup(t,store=>store.db.prepare("DELETE FROM messages WHERE message_id='reply'").run());assert.throws(()=>qualify(f),/complete membership count differs/);
});
test('canonical H rejects stale global content checkpoint without inventing current proof',t=>{
 assert.throws(()=>setup(t,store=>{const key=store.issueAccessKey('commons','owner');store.command(key,'commons',{id:'advanced',type:'message.posted',data:{messageId:'advanced',body:'Advanced after integrity checkpoint'}});store.db.prepare('UPDATE integrity_room_state SET sequence=sequence-1').run();}),/Canonical-authority current content qualification required/);
});
test('canonical H reconstructs original rows across lower-ID post-H new arrival',t=>{
 const f=setup(t),key=f.store.issueAccessKey('commons','owner');
 f.store.command(key,'commons',{id:'tail',type:'message.posted',data:{messageId:'aaa-tail',body:'Prospective canonical tail'}});
 const q=qualify(f);assert.equal(q.hMessageCount,2);convert(f);
 const state=f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state);assert.equal(state.messages.length,3);
});
test('canonical H exact qualification retry does not advance semantic state or receipts',t=>{
 const f=setup(t),input={roomId:'commons',generation:f.capture.generation,requestId:'retry',expectedSteps:0};const first=qualifyReplayHMessages(f.store,input),before=f.store.db.prepare('SELECT count(*) n FROM operator_actions').get().n;
 const retry=qualifyReplayHMessages(f.store,input);assert.deepEqual({...retry,duplicate:false},first);assert.equal(f.store.db.prepare('SELECT count(*) n FROM operator_actions').get().n,before);
});

test('canonical archive qualifies complete content while retaining the legacy context and all conversation rows',async t=>{
 let f=setup(t,()=>{},{archive:true});await f.store.verifyRoomIntegrity();f=f.prepare();const key=f.store.issueAccessKey('commons','owner'),before=f.store.room('commons').state;
 const q=qualify(f);assert.equal(q.hCanonicalCount,8);convert(f);
 const current=f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state);
 assert.deepEqual(current.messages,before.messages);assert.deepEqual(current.messagesArchive,before.messagesArchive);
 assert.equal(readConversation(f.store,key,'commons',{messageId:'extra-0',limit:5}).messages[0].body,'Standalone archived history 0');
 f.store.command(key,'commons',{id:'after-archive',type:'message.posted',data:{messageId:'after-archive',body:'Reply to archived canonical history',replyToId:'extra-0'}});
 assert.equal(readConversation(f.store,key,'commons',{messageId:'after-archive',limit:5}).messages[0].body,'Reply to archived canonical history');
 assert.doesNotThrow(()=>f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons')));
 assert.doesNotThrow(()=>auditRecovery(f.store),'full independent recovery must honor the proved archive representation');
});

test('canonical archive nested retained IDs preserve pinned early member and exact legacy order',async t=>{
 let f=setup(t,()=>{},{archive:true,retain:true});await f.store.verifyRoomIntegrity();f=f.prepare();const before=f.store.room('commons').state;
 assert.ok(before.messagesArchive.retainedIds.includes('root'));qualify(f);convert(f);
 const state=f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state);assert.deepEqual(state.messagesArchive,before.messagesArchive);assert.deepEqual(state.messages,before.messages);
});
test('canonical H includes archived payload in independent complete content digest',async t=>{
 let f=setup(t,()=>{},{archive:true});await f.store.verifyRoomIntegrity();const row=f.store.db.prepare("SELECT * FROM messages WHERE message_id='extra-0'").get();row.body='Forged archived wording';row.record_json=JSON.stringify({...JSON.parse(row.record_json),body:row.body});row.entity_hash=messageProofHash(row);f.store.db.prepare('UPDATE messages SET body=?,record_json=?,entity_hash=? WHERE message_id=?').run(row.body,row.record_json,row.entity_hash,'extra-0');f=f.prepare();assert.throws(()=>qualify(f),/complete content digest differs/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);
});

import {buildOrient} from '../server/orient.mjs';
import {buildActivationPack} from '../server/room-activation-pack.mjs';
test('existing canonical H work summary reaches actual context Begin and selected-work doors',t=>{
 const initialWork=[event({id:'existing-work-proposed',roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'existing-work',title:'Continue existing useful work',definitionOfDone:'Keep existing work exact',accountableMemberId:'owner'}})];
 const f=setup(t,()=>{},{initialWork});qualify(f);convert(f);const key=f.store.issueAccessKey('commons','owner');f.store.room=()=>{throw Error('canonical context fullroom fallback');};
 assert.equal(f.store.roomContext(key,'commons').focusWork[0].id,'existing-work');
 assert.equal(buildOrient(f.store,'commons','owner').work[0].id,'existing-work');assert.equal(buildActivationPack(f.store,'commons','owner').openWork[0].id,'existing-work');
 assert.equal(f.store.workContext(key,'commons','existing-work').work.id,'existing-work');
 assert.doesNotThrow(()=>f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons')));
});

test('canonical H private request indexes preserve party and role boundaries after migration',t=>{
 const initialWork=[];for(const memberId of ['producer','observer'])initialWork.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[]}}));
 initialWork.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'private-work',title:'CANONICAL-PRIVATE-TITLE',definitionOfDone:'Private evidence',accountableMemberId:'producer'}}));
 initialWork.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'private-request',toMemberId:'producer',workItemId:'private-work',requestKind:'reply',requestPolicyVersion:1,body:'Private scoped question'}}));
 const f=setup(t,()=>{},{initialWork});qualify(f);convert(f);f.store.room=()=>{throw Error('full canonical room');};
 for(const memberId of ['owner','producer'])assert.ok(JSON.stringify(buildOrient(f.store,'commons',memberId)).includes('CANONICAL-PRIVATE-TITLE'));
 assert.ok(!JSON.stringify(buildOrient(f.store,'commons','observer')).includes('CANONICAL-PRIVATE-TITLE'));
 assert.doesNotThrow(()=>auditRecovery(f.store));
});
