import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import * as cutover from '../server/replay-cutover.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,patch={}){
  const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom());
  const state=structuredClone(store.room('commons').state);Object.assign(state,patch);
  store.transaction(()=>store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(store.storedProjection('commons',state)));
  store.db.exec(cutover.replayCutoverSchema());
  const captured=cutover.captureReplayWitness(store,{roomId:'commons',requestId:'capture',expectedHead:store.headSequence('commons'),reason:'Synthetic leaf provenance'});
  const initialHash=store.db.prepare("SELECT * FROM message_replay_units WHERE domain='hash'").get();
  let step={bytes:0},n=0;
  while(step.phase!=='witness_verified')step=cutover.advanceReplayWitness(store,{roomId:'commons',generation:captured.generation,expectedBytes:step.bytes,requestId:'hash-'+n++});
  return {store,captured,initialHash};
}
function partition(f){let step={bytes:0},n=0;while(step.phase!=='codec_partitioned')step=cutover.partitionReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:step.bytes,requestId:'codec-'+n++});return step;}

test('changed witness bytes after completed independent hashing refuse before codec writes',t=>{
  const f=fixture(t),db=f.store.db;
  db.prepare("UPDATE message_replay_units SET payload=CAST(replace(CAST(payload AS TEXT),'Commons','Changed') AS BLOB) WHERE domain='witness'").run();
  const before=db.prepare('SELECT * FROM message_replay_units').all();
  assert.throws(()=>partition(f),/source chunk|witness/);
  assert.deepEqual(db.prepare('SELECT * FROM message_replay_units').all(),before);
});

test('Muse-shaped replyRequests partition by addressed entry without raising token caps',t=>{
  const replyRequests=Object.fromEntries(Array.from({length:305},(_,i)=>['request-'+i,{id:'request-'+i,body:'x'.repeat(720)}]));
  assert.ok(Buffer.byteLength(JSON.stringify(replyRequests))>223420);
  const f=fixture(t,{replyRequests}),result=partition(f);
  assert.equal(result.certified,false);assert.equal(result.publication,'pending');
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM message_replay_units WHERE domain='metadata-entry' AND json_extract(unit_key,'$[0]')='replyRequests'").get().n,305);
  assert.deepEqual(cutover.readReplayWitnessLeaf(f.store,{roomId:'commons',generation:f.captured.generation,domain:'metadata-entry',key:JSON.stringify(['replyRequests','request-17'])}).value,replyRequests['request-17']);
});

for(const mutation of ['leaf-with-new-self-hash','pointer-index'])test(`point leaf proof refuses ${mutation}`,t=>{
  const f=fixture(t);partition(f);const db=f.store.db;
  assert.equal(typeof cutover.readReplayWitnessLeaf,'function');
  const input={roomId:'commons',generation:f.captured.generation,domain:'metadata',key:'room'};
  const original=cutover.readReplayWitnessLeaf(f.store,input);
  if(mutation==='leaf-with-new-self-hash'){
    const bytes=Buffer.from(JSON.stringify({...original.value,name:'Changed'}));
    db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='metadata' AND unit_key='room'").run(bytes,bytes.length,sha(bytes));
  }else{
    const row=db.prepare("SELECT payload FROM message_replay_units WHERE domain='leaf-proof' AND unit_key=?").get(JSON.stringify(['metadata','room']));
    const pointer=JSON.parse(Buffer.from(row.payload).toString());pointer.index++;
    const bytes=Buffer.from(JSON.stringify(pointer));
    db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='leaf-proof' AND unit_key=?").run(bytes,bytes.length,sha(bytes),JSON.stringify(['metadata','room']));
  }
  assert.throws(()=>cutover.readReplayWitnessLeaf(f.store,input),/leaf|binding/);
});

test('a spanning token cannot reread changed bytes from an earlier verified chunk',t=>{
  const f=fixture(t,{messages:[{id:'large',body:'x'.repeat(50000)}]}),db=f.store.db;
  let step=cutover.partitionReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:0,requestId:'partial-0'});
  assert.equal(step.phase,'codec_partitioning');
  const row=db.prepare("SELECT payload FROM message_replay_units WHERE domain='witness'").get();
  const bytes=Buffer.from(row.payload),at=bytes.indexOf(Buffer.from('xxxxxxxx'));assert.ok(at>=0&&at<step.bytes);bytes[at]=121;
  db.prepare("UPDATE message_replay_units SET payload=? WHERE domain='witness'").run(bytes);
  assert.throws(()=>{for(let i=1;i<5;i++)step=cutover.partitionReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:step.bytes,requestId:'partial-'+i});},/source chunk changed/);
  assert.notEqual(step.phase,'codec_partitioned');
});

test('changed chunk receipt pointer refuses independently of pointer self hashes',t=>{
  const f=fixture(t,{messages:[{id:'large',body:'x'.repeat(50000)}]}),db=f.store.db;
  const other=db.prepare("SELECT payload FROM message_replay_units WHERE domain='source-chunk' AND unit_key='16384'").get();
  db.prepare("UPDATE message_replay_units SET payload=? WHERE domain='source-chunk' AND unit_key='0'").run(other.payload);
  assert.throws(()=>partition(f),/source chunk binding/);
});

test('receipt vectors and charged repeated source reads stay within admitted unit limits',t=>{
  const f=fixture(t,{messages:[{id:'large',body:'x'.repeat(128*1024-200)},...Array.from({length:100},(_,i)=>({id:'m'+i,body:'small'}))]});
  let step={bytes:0},n=0,maxInput=0;
  while(step.phase!=='codec_partitioned'){
    step=cutover.partitionReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:step.bytes,requestId:'bound-'+n++});
    assert.ok(step.leafCommitments.length<=32);assert.ok(Buffer.byteLength(JSON.stringify(step))<=4096);
    assert.ok(step.logicalUnitRows<=200);
    maxInput=Math.max(maxInput,step.inputBytes);assert.ok(step.inputBytes<=256*1024);
  }
  assert.ok(maxInput>128*1024,'spanning reads are included, not just the current chunk');
});

test('a partial fork receipt cannot masquerade as inclusion in an older completed hash chain',t=>{
  const f=fixture(t,{messages:[{id:'large',body:'x'.repeat(50000)}]}),db=f.store.db;
  const completed=db.prepare("SELECT * FROM message_replay_units WHERE domain='hash'").get();
  const restore=row=>db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='hash'").run(row.payload,row.payload_bytes,row.payload_sha256);
  db.prepare("UPDATE message_replay_units SET payload=CAST(replace(CAST(payload AS TEXT),'Commons','Changed') AS BLOB) WHERE domain='witness'").run();
  restore(f.initialHash);
  db.prepare("DELETE FROM message_replay_units WHERE domain='source-chunk' AND unit_key='0'").run();
  db.prepare("DELETE FROM message_replay_units WHERE domain='source-merkle'").run();
  const partial=cutover.advanceReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:0,requestId:'fork-hash'});
  assert.equal(partial.phase,'hashing','the fork never passed the independent full digest');
  restore(completed);
  assert.throws(()=>partition(f),/source.*(inclusion|root|binding)/);
});

for(const mutation of ['root-control','sibling-self-hash','oversized-sibling'])test(`source membership refuses ${mutation}`,t=>{
  const f=fixture(t,{messages:[{id:'large',body:'x'.repeat(50000)}]}),db=f.store.db;
  if(mutation==='root-control'){
    const row=db.prepare("SELECT payload FROM message_replay_units WHERE domain='hash'").get();
    const value=JSON.parse(Buffer.from(row.payload).toString());value.sourceRoot='0'.repeat(64);
    const bytes=Buffer.from(JSON.stringify(value));
    db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='hash'").run(bytes,bytes.length,sha(bytes));
  }else{
    const bytes=Buffer.from(mutation==='oversized-sibling'?'x'.repeat(2*1024*1024):'0'.repeat(64));
    db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='source-merkle' AND unit_key='0:1'").run(bytes,bytes.length,sha(bytes));
  }
  assert.throws(()=>partition(f),/checkpoint binding|hash binding|source inclusion/);
});

test('large nested archive retained identities use independent indexed leaf commitments',t=>{
  const retainedIds=Array.from({length:6000},(_,i)=>'message-'+String(i).padStart(6,'0')+'-x'.repeat(12));
  const f=fixture(t,{messagesArchive:{throughSeq:9000,count:3000,retainedIds}});const result=partition(f);
  assert.equal(result.phase,'codec_partitioned');assert.equal(result.certified,false);
  const frame=cutover.readReplayWitnessLeaf(f.store,{roomId:'commons',generation:f.captured.generation,domain:'metadata-entry',key:JSON.stringify(['messagesArchive','retainedIds'])});
  assert.equal(frame.value.kind,'entry-array');assert.equal(frame.value.entries,retainedIds.length);assert.ok(frame.bytes<256);
  const key=JSON.stringify(['messagesArchive','retainedIds',4095]);
  assert.equal(cutover.readReplayWitnessLeaf(f.store,{roomId:'commons',generation:f.captured.generation,domain:'metadata-index',key}).value,retainedIds[4095]);
  f.store.db.prepare("UPDATE message_replay_units SET payload=CAST('\"forged\"' AS BLOB),payload_bytes=8 WHERE domain='metadata-index' AND unit_key=?").run(key);
  assert.throws(()=>cutover.readReplayWitnessLeaf(f.store,{roomId:'commons',generation:f.captured.generation,domain:'metadata-index',key}),/independent replay leaf binding changed/);
});
