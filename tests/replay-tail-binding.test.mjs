import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import * as cutover from '../server/replay-cutover.mjs';
function fixture(t){
  const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom());
  store.db.exec(cutover.replayCutoverSchema());
  const capture=cutover.captureReplayWitness(store,{roomId:'commons',requestId:'capture',expectedHead:2,reason:'Synthetic prospective append authority'});
  const key=store.issueAccessKey('commons','owner');
  const post=()=>store.command(key,'commons',{id:'after-h',type:'message.posted',data:{messageId:'new',body:'Prospectively bound event'}});
  return {store,capture,post};
}
test('ordinary post-H append durably binds exact raw event bytes in its own transaction',t=>{
  const f=fixture(t);f.post();
  const raw=f.store.db.prepare("SELECT id,body FROM events WHERE room_id='commons' AND sequence=3").get();
  const saved=f.store.db.prepare("SELECT payload FROM message_replay_units WHERE generation=? AND domain='tail-event' AND unit_key='3'").get(f.capture.generation);
  assert.ok(saved,'RED: a later replay hash cannot replace missing prospective append authority');
  assert.equal(Buffer.from(saved.payload).toString('utf8'),raw.body);
});
test('actual prospective-binding write failure rolls back event and derived serving mutation',t=>{
  const f=fixture(t);const before=f.store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get();
  f.store.db.exec("CREATE TRIGGER synthetic_tail_failure BEFORE INSERT ON message_replay_units WHEN NEW.domain='tail-event' BEGIN SELECT RAISE(ABORT,'synthetic prospective binding failure'); END");
  assert.throws(()=>f.post(),/synthetic prospective binding failure/);
  assert.deepEqual(f.store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get(),before);
  assert.equal(f.store.db.prepare("SELECT 1 FROM events WHERE sequence=3").get(),undefined);
});

test('tail consumer requires original append binding and exact immutable source bytes',t=>{
  const f=fixture(t);f.post();const input={roomId:'commons',generation:f.capture.generation,sequence:3};
  const read=cutover.readReplayTailEvent(f.store,input);assert.equal(read.event.data.messageId,'new');
  assert.equal(read.certified,false);assert.ok(read.inputBytes<=262144);
  const replacement=Buffer.from(JSON.stringify({...read.event,data:{...read.event.data,body:'Forged current event'}}));
  f.store.db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='tail-event'")
    .run(replacement,replacement.length,'a'.repeat(64));
  assert.throws(()=>cutover.readReplayTailEvent(f.store,input),/prospective replay source changed/);
});
test('raw older writer cannot obtain prospective authority through a later read',t=>{
  const f=fixture(t);assert.throws(()=>f.store.transaction(()=>f.store.db.exec(`INSERT INTO events VALUES('commons',3,'old-writer','{"id":"old-writer","roomId":"commons","type":"message.posted","data":{}}')`)), /unsupported current room writer/);
  assert.throws(()=>cutover.readReplayTailEvent(f.store,{roomId:'commons',generation:f.capture.generation,sequence:3}),/missing independent replay audit binding/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND sequence=3").get(),undefined);
  assert.equal(f.store.db.prepare("SELECT 1 FROM message_replay_units WHERE domain='tail-event'").get(),undefined);
});
test('out-of-transaction SQL append is refused before claiming atomic capture',t=>{
  const f=fixture(t);assert.throws(()=>f.store.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('commons',3,'outside','{"id":"outside","roomId":"commons","type":"message.posted"}'), /unsupported current room writer/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND sequence=3").get(),undefined);
  assert.equal(f.store.db.prepare("SELECT 1 FROM message_replay_units WHERE domain='tail-event'").get(),undefined);
});
test('large valid ordinary post is accepted without laundering unsupported tail into bounded continuation',t=>{
  const f=fixture(t);const key=f.store.issueAccessKey('commons','owner');
  f.store.command(key,'commons',{id:'large',type:'message.posted',data:{messageId:'large',body:'é'.repeat(50000)}});
  assert.equal(f.store.headSequence('commons'),3);
  // The event is below the 128 KiB storage ceiling, but fetching both bound
  // source copies plus exact schema/control bytes exceeds the step budget.
  assert.throws(()=>cutover.readReplayTailEvent(f.store,{roomId:'commons',generation:f.capture.generation,sequence:3}),/binding admission changed/);
});
