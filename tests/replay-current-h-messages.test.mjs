import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {messageProofHash} from '../server/write-integrity.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages} from '../server/replay-cutover.mjs';
function setup(t,mutate=()=>{},options={}) {
 const store=new RoomStore(':memory:',options);t.after(()=>store.close());store.initialize([...initialRoom(),event({id:'post-root',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'root',body:'Existing original wording '.repeat(20)}}),event({id:'post-reply',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'reply',body:'Existing useful reply',replyToId:'root'}})]);const key=store.issueAccessKey('commons','owner');
 while(!store.backfillMessages({limit:200}).done){}
 store.checkMessagesParity({roomId:'commons'});
 mutate(store,key);store.db.exec(replayCutoverSchema());
 const capture=captureReplayWitness(store,{roomId:'commons',requestId:'capture',expectedHead:store.headSequence('commons'),reason:'Existing-room qualification'});
 let progress={bytes:0},n=0;while(progress.phase!=='witness_verified')progress=advanceReplayWitness(store,{roomId:'commons',generation:capture.generation,requestId:'hash-'+n++,expectedBytes:progress.bytes});
 progress={bytes:0};n=0;while(progress.phase!=='codec_partitioned')progress=partitionReplayWitness(store,{roomId:'commons',generation:capture.generation,requestId:'codec-'+n++,expectedBytes:progress.bytes});
 qualifyReplayHWork(store,{roomId:'commons',generation:capture.generation,requestId:'work',expectedWorkCount:0});
 return {store,key,capture};
}
function finish(f) {let result={hMessageSteps:0},n=0;do{result=qualifyReplayHMessages(f.store,{roomId:'commons',generation:f.capture.generation,requestId:'qualify-'+n++,expectedSteps:result.hMessageSteps});assert.ok(result.inputBytes<=262144);}while(!result.hMessagesQualified&&n<100);assert.ok(result.hMessagesQualified);return result;}
function mutateRow(store,id,change) {const row=store.db.prepare('SELECT * FROM messages WHERE room_id=? AND message_id=?').get('commons',id);change(row);row.entity_hash=messageProofHash(row);store.db.prepare('UPDATE messages SET thread_root_id=?,pinned=?,reducer_extras_json=?,entity_hash=? WHERE room_id=? AND message_id=?').run(row.thread_root_id,row.pinned,row.reducer_extras_json,row.entity_hash,'commons',id);}

test('existing inline H membership, fields, bodyrefs and ancestry qualify without serving mutation',t=>{
 const f=setup(t,()=>{},{bodiesAtRest:true}),before=f.store.db.prepare('SELECT * FROM rooms').all();
 const result=finish(f);assert.equal(result.hMessageCount,2);assert.equal(result.hCanonicalCount,2);assert.equal(result.historyProvenance,'unknown');assert.equal(result.certified,false);assert.deepEqual(f.store.db.prepare('SELECT * FROM rooms').all(),before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);
});
for(const [field,change,pattern] of [
 ['thread ancestry',row=>{row.thread_root_id='wrong-root';},/parity differs/],
 ['pin',row=>{row.pinned=1;},/parity differs/],
 ['unproven extras',row=>{row.reducer_extras_json=null;},/invalid message entity/],
])test('existing H '+field+' corruption refuses even with a self-consistent row hash',t=>{
 const f=setup(t,store=>mutateRow(store,'reply',change));assert.throws(()=>finish(f),pattern);assert.equal(f.store.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);
});
test('post-H edits and new posts preserve qualified original H, including first body copy',t=>{
 const f=setup(t,()=>{},{bodiesAtRest:true});f.store.command(f.key,'commons',{id:'later-edit',type:'message.edited',data:{messageId:'root',body:'Later replacement',expectedMessageRevision:0}});f.store.command(f.key,'commons',{id:'later-new',type:'message.posted',data:{messageId:'new',body:'Later post'}});
 const result=finish(f);assert.equal(result.hMessageCount,2);assert.equal(result.hCanonicalCount,2);assert.equal(f.store.room('commons').state.messages.length,3);
});

import {advanceCurrentRoomConversion} from '../server/replay-cutover.mjs';
import {readWorkItem} from '../server/work-repository.mjs';
import {textVersion} from '../server/text-results.mjs';
import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {buildOrient} from '../server/orient.mjs';
import {buildActivationPack} from '../server/room-activation-pack.mjs';
import {buildRoomContext} from '../server/room-context.mjs';
import {thinWorkForContext} from '../server/current-work-summary.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
test('existing room H plus independently bound tail activates actual normalized post/reply and useful work result',t=>{
 const f=setup(t);finish(f);
 const tail=f.store.command(f.key,'commons',{id:'tail-post',type:'message.posted',data:{messageId:'tail-message',body:'Arrived while conversion was preparing',replyToId:'root'}});
 const expected=structuredClone(f.store.room('commons').state);expected.eventLog=[];expected.seenEvents={};expected.seenIdempotencyKeys={};
 const previousProofs=f.store.db.prepare('SELECT message_id,entity_hash FROM messages ORDER BY message_id').all();
 let progress={currentSteps:0},n=0;do{progress=advanceCurrentRoomConversion(f.store,{roomId:'commons',generation:f.capture.generation,requestId:'current-'+n++,expectedSteps:progress.currentSteps});}while(progress.phase!=='current_serving'&&n<200);
 assert.deepEqual(f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state),expected);
 assert.equal(progress.phase,'current_serving');assert.equal(progress.sequence,tail.sequence);assert.deepEqual(f.store.db.prepare('SELECT message_id,entity_hash FROM messages ORDER BY message_id').all(),previousProofs);
 f.store.room=()=>{throw Error('Full blob hydration attempted after existing-room activation');};
 const posted=f.store.command(f.key,'commons',{id:'after-current',type:'message.posted',data:{messageId:'after-current',body:'Useful normalized reply',replyToId:'tail-message'}});assert.equal(posted.duplicate,false);
 assert.equal(readConversation(f.store,f.key,'commons',{messageId:'after-current',limit:5}).messages[0].body,'Useful normalized reply');
 const proposed=f.store.command(f.key,'commons',{id:'existing-work',type:'work.proposed',data:{workItemId:'existing-work',title:'Save useful evidence',definitionOfDone:'A saved room result',mode:'read',accountableMemberId:'owner'}});assert.equal(proposed.duplicate,false);
 const overview=f.store.roomContext(f.key,'commons');assert.equal(overview.workWindow.complete,true);assert.equal(overview.workWindow.total,1);assert.equal(overview.focusWork[0].id,'existing-work');
 assert.equal(f.store.roomContext(f.key,'commons',{sinceVersion:overview.context_version}).not_modified,true);
 assert.equal(buildOrient(f.store,'commons','owner').work[0].id,'existing-work');
 assert.equal(buildActivationPack(f.store,'commons','owner').openWork[0].id,'existing-work');
 const selected=f.store.workContext(f.key,'commons','existing-work',{includeSource:true});assert.equal(selected.work.id,'existing-work');assert.equal(selected.context.omitted.includes('other_work'),true);
 const item=()=>readWorkItem(f.store.db,'commons','existing-work');
 f.store.command(f.key,'commons',{id:'accept-existing',type:'work.accepted',data:{workItemId:'existing-work',expectedRevision:item().revision}});
 f.store.command(f.key,'commons',{id:'start-existing',type:'work.started',data:{workItemId:'existing-work',expectedRevision:item().revision}});
 const body='Existing-room migration delivered useful evidence 🧪';
 const result=f.store.command(f.key,'commons',{id:'result-existing',type:'message.posted',data:{messageId:'existing-result',workItemId:'existing-work',body}});
 const completed=f.store.command(f.key,'commons',{id:'complete-existing',type:'work.completed',data:{workItemId:'existing-work',expectedRevision:item().revision,evidenceKind:'room_text',evidenceMessageId:'existing-result',evidenceMessageEventId:result.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'A saved result',nextAction:'Review'}});
 const full=f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state);
 const thin={...full,workItems:Object.fromEntries(Object.entries(full.workItems).map(([id,value])=>[id,thinWorkForContext(value)]))};
 const contextNow=f.store.now();assert.deepEqual(buildRoomContext({state:thin,sequence:1,viewerId:'owner',caughtUp:0,now:contextNow}),buildRoomContext({state:full,sequence:1,viewerId:'owner',caughtUp:0,now:contextNow}));
 assert.equal(f.store.roomContext(f.key,'commons').workWindow.total,1);
 const saved=f.store.workResult(f.key,'commons','existing-work');assert.equal(saved.result.text.body,body);assert.equal(saved.result.receipt.eventId,completed.event.id);
 auditRecovery(f.store);
});


test('current prospective metadata proof permits capture after a legacy command without integrity sweep',t=>{
 let checkpoint;
 const f=setup(t,(store,key)=>{checkpoint={...store.db.prepare('SELECT * FROM integrity_room_state').get()};store.command(key,'commons',{id:'advanced-without-sweep',type:'message.posted',data:{messageId:'advanced',body:'A command advanced the current head'}});assert.ok(store.headSequence('commons')>store.db.prepare('SELECT sequence FROM integrity_room_state').get().sequence);});
 const result=finish(f);assert.equal(result.hMessageCount,3);assert.equal(result.certified,false);
 const stored=JSON.parse(Buffer.from(f.store.db.prepare("SELECT payload FROM message_replay_units WHERE domain='header' AND unit_key='state'").get().payload).toString('utf8'));
 assert.deepEqual(stored.historicalCheckpoint,{sequence:checkpoint.sequence,contentHash:checkpoint.projection_hash});
});
for(const [name,mutate,pattern] of [
 ['missing prospective metadata proof',store=>store.db.prepare('UPDATE integrity_room_state SET metadata_hash=NULL').run(),/independent replay proof required/],
 ['wrong prospective metadata proof',store=>store.db.prepare('UPDATE integrity_room_state SET metadata_hash=?').run('0'.repeat(64)),/independent replay witness mismatch/],
 ['unregistered source metadata mutation',store=>store.db.prepare("UPDATE rooms SET projection=replace(projection,'Existing useful reply','Unregistered mutation')").run(),/independent replay witness mismatch/],
])test('capture refuses '+name+' before target activation',t=>assert.throws(()=>setup(t,mutate),pattern));

test('active existing-room capture excludes raw source projection and canonical mutations while admitting code-owned commands',t=>{
 const f=setup(t);finish(f);
 for(const sql of ["UPDATE rooms SET projection='{}' WHERE id='commons'","DELETE FROM messages WHERE room_id='commons' AND message_id='root'","UPDATE messages SET body='raw' WHERE room_id='commons'"])
  assert.throws(()=>f.store.db.prepare(sql).run(),/unsupported current room writer/);
 assert.equal(f.store.command(f.key,'commons',{id:'cooperative',type:'message.posted',data:{messageId:'cooperative',body:'Code-owned source writer still works'}}).duplicate,false);
});

test('existing conversion drains admitted concurrent posts without resetting an already compared prefix',t=>{
 const f=setup(t);finish(f);let progress={currentSteps:0},steps=0,arrivals=0,tailSteps=0;
 do {
  if(steps%5===0&&arrivals<16)f.store.command(f.key,'commons',{id:'arrival-'+arrivals,type:'message.posted',data:{messageId:(arrivals%2?'a':'z')+'-arrival-'+String(arrivals++).padStart(3,'0'),body:'Concurrent admitted arrival'}});
  progress=advanceCurrentRoomConversion(f.store,{roomId:'commons',generation:f.capture.generation,requestId:'drain-'+steps++,expectedSteps:progress.currentSteps});
  if(progress.currentPhase==='tail')tailSteps++;
 }while(progress.phase!=='current_serving'&&steps<250);
 assert.equal(progress.phase,'current_serving');assert.ok(arrivals>=8);assert.ok(tailSteps>0);
 assert.equal(f.store.headSequence('commons'),progress.sequence);
 const state=f.store.readTransaction(()=>readCurrentRoomForAudit(f.store,'commons').state);assert.equal(state.messages.length,2+arrivals);
 t.diagnostic(JSON.stringify({steps,admittedConcurrentArrivals:arrivals,tailSteps,committedTailDrain:arrivals,backlogAtActivation:0,scope:'Node bounded post-only conversion; actual Worker physical/net-drain qualification pending'}));
});
