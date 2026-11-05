import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import * as cutover from '../server/replay-cutover.mjs';
function fixture(t) {
  const store=new RoomStore(':memory:',{bodiesAtRest:true,maintainMessageCertification:true});t.after(()=>store.close());
  store.initialize([...initialRoom(),event({id:'work',roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'task',title:'Original work',definitionOfDone:'Saved result',mode:'read',accountableMemberId:'owner'}}),event({id:'post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'long',body:'Original body '.repeat(80)}})]);const key=store.issueAccessKey('commons','owner');
  const command=(id,type,data)=>store.command(key,'commons',{id,type,data});
  while(!store.backfillMessages({limit:200}).done){}
  store.checkMessagesParity({roomId:'commons'});
  const work=store.db.prepare("SELECT work_id,revision,digest,body FROM work_entities WHERE room_id='commons'").get();
  const body=store.db.prepare("SELECT sha,body FROM projection_bodies WHERE room_id='commons'").get();
  store.db.exec(cutover.replayCutoverSchema());
  const capture=cutover.captureReplayWitness(store,{roomId:'commons',requestId:'reference-capture',expectedHead:store.headSequence('commons'),reason:'Synthetic existing reference consistency'});
  const unit=(domain,key)=>store.db.prepare('SELECT payload FROM message_replay_units WHERE generation=? AND domain=? AND unit_key=?').get(capture.generation,domain,key);
  return {store,command,work,body,capture,unit};
}
test('first canonical-work update saves the exact H revision and existing digest',t=>{
  const f=fixture(t);f.command('accept','work.accepted',{workItemId:'task',expectedRevision:0});
  const saved=f.unit('h-work','task');assert.ok(saved,'RED: mutable work payload lost H version');
  assert.deepEqual(JSON.parse(Buffer.from(saved.payload)),{...f.work});
});
test('new work stays absent at H through subsequent canonical updates',t=>{
  const f=fixture(t);f.command('new','work.proposed',{workItemId:'new',title:'New work',definitionOfDone:'Save result',mode:'read',accountableMemberId:'owner'});
  f.command('accept-new','work.accepted',{workItemId:'new',expectedRevision:0});
  assert.ok(f.unit('h-work-absent','new'),'RED: post-H work needs durable absence');
  assert.equal(f.unit('h-work','new'),undefined);
});
test('ordinary body-reference release retains the exact H bytes in the capture',t=>{
  const f=fixture(t);f.command('edit','message.edited',{messageId:'long',body:'New long body '.repeat(80),expectedMessageRevision:0});
  assert.equal(f.store.db.prepare("SELECT 1 FROM projection_bodies WHERE sha=?").get(f.body.sha),undefined);
  const saved=f.unit('h-body',f.body.sha);assert.ok(saved,'RED: ordinary body cache release lost referenced H bytes');
  assert.deepEqual(JSON.parse(Buffer.from(saved.payload)),{...f.body});
});

test('captured reference reader preserves old digest and rejects coherent payload replacement',t=>{
  const f=fixture(t);f.command('accept','work.accepted',{workItemId:'task',expectedRevision:0});
  const input={roomId:'commons',generation:f.capture.generation,kind:'work',key:'task'};
  const read=cutover.readReplayHReference(f.store,input);assert.deepEqual(read.row,{...f.work});
  assert.equal(read.certified,false);assert.ok(read.inputBytes<=262144);
  const now=f.store.db.prepare("SELECT work_id,revision,digest,body FROM work_entities WHERE room_id='commons'").get();
  const bytes=Buffer.from(JSON.stringify(now));f.store.db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=? WHERE domain='h-work'").run(bytes,bytes.length);
  assert.throws(()=>cutover.readReplayHReference(f.store,input),/independent replay H-reference digest changed/);
});
test('explicit message deletion purges H work, body, witness and all shared raw leaves',t=>{
  const f=fixture(t);f.command('accept','work.accepted',{workItemId:'task',expectedRevision:0});
  f.command('edit','message.edited',{messageId:'long',body:'Edited body '.repeat(80),expectedMessageRevision:0});
  assert.ok(f.unit('h-body',f.body.sha));assert.ok(f.unit('h-work','task'));
  assert.deepEqual(cutover.readReplayHReference(f.store,{roomId:'commons',generation:f.capture.generation,kind:'body',key:f.body.sha}).row,{...f.body});
  f.command('delete','message.deleted',{messageId:'long',expectedMessageRevision:1});
  assert.equal(f.store.db.prepare('SELECT 1 FROM message_replay_units WHERE generation=?').get(f.capture.generation),undefined);
  assert.equal(f.store.db.prepare("SELECT 1 FROM message_replay_units WHERE domain='control' AND unit_key='capture-head'").get(),undefined);
});

test('untouched H work and body use only existing admitted source digests',t=>{
  const f=fixture(t);
  for(const [kind,key,expected] of [['work','task',f.work],['body',f.body.sha,f.body]]){
    const read=cutover.readReplayHReference(f.store,{roomId:'commons',generation:f.capture.generation,kind,key});
    assert.equal(read.unchanged,true);assert.deepEqual(read.row,{...expected});assert.ok(read.inputBytes<=262144);
  }
});
test('missing first-H work copy cannot fall back to valid changed current work',t=>{
  const f=fixture(t);f.command('accept','work.accepted',{workItemId:'task',expectedRevision:0});
  f.store.db.prepare("DELETE FROM message_replay_units WHERE domain='h-work'").run();
  assert.throws(()=>cutover.readReplayHReference(f.store,{roomId:'commons',generation:f.capture.generation,kind:'work',key:'task'}),/missing independently bound H reference/);
});
