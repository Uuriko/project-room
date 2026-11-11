import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import * as cutover from '../server/replay-cutover.mjs';
function fixture(t,count=2,options={},beforeCapture=()=>{}){
  const store=new RoomStore(':memory:',options);t.after(()=>store.close());
  store.initialize([...initialRoom(),...Array.from({length:count},(_,i)=>event({id:'work-'+i,roomId:'commons',actorId:'owner',type:'work.proposed',
    data:{workItemId:'task-'+i,title:'Task '+i,definitionOfDone:'Saved result',mode:'read',accountableMemberId:'owner'}}))]);
  beforeCapture(store);
  store.db.exec(cutover.replayCutoverSchema());const capture=cutover.captureReplayWitness(store,{roomId:'commons',requestId:'capture',expectedHead:store.headSequence('commons'),reason:'Synthetic complete work qualification'});
  let progress={bytes:0},n=0;while(progress.phase!=='witness_verified')progress=cutover.advanceReplayWitness(store,{roomId:'commons',generation:capture.generation,expectedBytes:progress.bytes,requestId:'hash-'+n++});
  progress={bytes:0};n=0;while(progress.phase!=='codec_partitioned')progress=cutover.partitionReplayWitness(store,{roomId:'commons',generation:capture.generation,expectedBytes:progress.bytes,requestId:'codec-'+n++});
  const step=(expectedWorkCount,requestId='work-'+expectedWorkCount)=>cutover.qualifyReplayHWork(store,{roomId:'commons',generation:capture.generation,expectedWorkCount,requestId});
  return {store,capture,step};
}
test('complete H work census qualifies existing digests and global defaults without serving writes',t=>{
  const f=fixture(t);const before=f.store.db.prepare('SELECT sequence,projection FROM rooms').get();
  const first=f.step(0);assert.equal(first.workCount,1);assert.equal(first.workDefaultsQualified,false);
  const second=f.step(1);assert.equal(second.phase,'work_qualified');assert.equal(second.workCount,2);assert.equal(second.workDefaultsQualified,true);
  assert.equal(second.certified,false);assert.equal(second.historyProvenance,'unknown');assert.ok(second.inputBytes<=262144);
  assert.deepEqual(f.store.db.prepare('SELECT sequence,projection FROM rooms').get(),before);
  assert.deepEqual({...f.step(0),duplicate:false},first);
});
test('post-H changed canonical work is qualified from its first-H dependency',t=>{
  const f=fixture(t,1);const key=f.store.issueAccessKey('commons','owner');
  f.store.command(key,'commons',{id:'accept',type:'work.accepted',data:{workItemId:'task-0',expectedRevision:0}});
  assert.equal(f.step(0).phase,'work_qualified');
});
test('missing captured work member cannot satisfy the protected complete map count',t=>{
  const f=fixture(t,1);f.store.db.prepare("DELETE FROM message_replay_units WHERE domain='metadata-entry' AND unit_key=?").run(JSON.stringify(['workItems','task-0']));
  assert.throws(()=>f.step(0),/work membership count changed/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM message_replay_units WHERE domain='semantic'").get(),undefined);
});

test('an unloaded legacy work record with old defaults prevents whole-map qualification',t=>{
  const f=fixture(t,2,{workEntities:false},store=>{
    // A synthetic code-owned metadata representation rewrite retains the old
    // work fields exactly. It does not claim full-room content qualification.
    const state=structuredClone(store.room('commons').state);delete state.workItems['task-1'].round_count;
    store.transaction(()=>store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(store.storedProjection('commons',state)));
  });
  assert.equal(f.step(0).workDefaultsQualified,false);
  const before=f.store.db.prepare("SELECT payload FROM message_replay_units WHERE domain='semantic'").get();
  assert.throws(()=>f.step(1),/unloaded legacy work defaults require qualification/);
  assert.deepEqual(f.store.db.prepare("SELECT payload FROM message_replay_units WHERE domain='semantic'").get(),before);
});
test('a manufactured true continuation flag does not replace independent whole-map qualification',t=>{
  const f=fixture(t);f.step(0);
  const current=f.store.db.prepare("SELECT payload FROM message_replay_units WHERE domain='semantic'").get();
  const forged=JSON.parse(Buffer.from(current.payload));forged.state.workDefaultsQualified=true;forged.state.workCount=2;
  const bytes=Buffer.from(JSON.stringify(forged));
  f.store.db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='semantic'")
    .run(bytes,bytes.length,createHash('sha256').update(bytes).digest('hex'));
  assert.throws(()=>f.step(2),/independent work qualification continuation changed/);
  assert.throws(()=>cutover.auditReplayCutoverRecovery(f.store.db),/independent recovered work qualification changed/);
});
test('phase receipt failure rolls back work qualification cursor and exact retry succeeds',t=>{
  const f=fixture(t);
  f.store.db.exec("CREATE TRIGGER synthetic_work_receipt_failure BEFORE INSERT ON operator_actions WHEN NEW.action='replay_cutover_work' BEGIN SELECT RAISE(ABORT,'synthetic work receipt failure'); END");
  assert.throws(()=>f.step(0),/synthetic work receipt failure/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM message_replay_units WHERE domain='semantic'").get(),undefined);
  f.store.db.exec('DROP TRIGGER synthetic_work_receipt_failure');assert.equal(f.step(0).workCount,1);
});
