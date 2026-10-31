import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { upgradeLegacyMessages } from '../server/legacy-message-shape.mjs';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';
import { createRoomServer } from '../server/http.mjs';
function fixture(t, mode = 'reactions') {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  for (const roomId of ['target','other']) store.initialize([...initialRoom(roomId), event({ type:'message.posted', roomId, actorId:'owner', id:`post-${roomId}`, at:new Date().toISOString(), data:{ messageId:'card', body:'PRIVATE_BODY', kind:'receipt_card', claimId:'c', receiptId:'custom-id', title:'Done', closedBy:'Owner', deliveryMode:'merged', evidence:'PRIVATE_EVIDENCE' } })]);
  while (!store.backfillMessages({limit:1000}).done) { /* fixture */ }
  for (const roomId of ['target','other']) store.checkMessagesParity({roomId});
  if (mode === 'reactions') store.db.exec("UPDATE messages SET record_json=json_set(record_json,'$.reactions',json('{\"PRIVATE\":[\"owner\"]}')),reactions_json='PRIVATE_REACTION' WHERE room_id='target'");
  else if (mode === 'null') store.db.exec("UPDATE messages SET record_json=json_set(record_json,'$.receiptId',NULL) WHERE room_id='target'");
  else store.db.exec("UPDATE messages SET record_json=json_remove(record_json,'$.receiptId') WHERE room_id='target'");
  store.recordIntegrityFailure('messages_parity','target',new Error('messages parity failed for target: current record card differs'));
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='target'").get().sequence;
  return {store,input:{rooms:[{roomId:'target',expectedHead:head}],reason:'Verified legacy shape repair'}};
}
const rows = store => JSON.stringify(store.db.prepare('SELECT * FROM messages ORDER BY room_id,message_id').all());
const source = store => JSON.stringify({rooms:store.db.prepare('SELECT * FROM rooms ORDER BY id').all(),events:store.db.prepare('SELECT * FROM events ORDER BY room_id,sequence').all(),other:store.db.prepare("SELECT * FROM messages WHERE room_id='other'").all()});
function plan(f) { const result=repairLegacyMessages(f.store,f.input); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|custom-id/); return {...f.input,planHash:result.planHash,requestId:'repair-one'}; }
for (const mode of ['reactions','null','absent']) test(`scoped ${mode} repair canonically verifies and clears only its failure`, t => {
  const f=fixture(t,mode), before=source(f.store), execute=plan(f);
  f.store.recordIntegrityFailure('email','other',new Error('other failure'));
  const result=repairLegacyMessages(f.store,execute,true);
  assert.equal(result.verified,1); assert.equal(source(f.store),before);
  assert.equal(f.store.checkMessagesParity({roomId:'target'}).ok,true);
  assert.deepEqual(f.store.integrityFailures().map(row=>[row.step,row.recordId]),[['email','other']]);
  const record=f.store.db.prepare("SELECT record_json,reactions_json FROM messages WHERE room_id='target'").get();
  assert.equal(JSON.parse(record.record_json).receiptId,'custom-id'); assert.equal(Object.hasOwn(JSON.parse(record.record_json),'reactions'),false);
  if(mode==='reactions') assert.equal(record.reactions_json,null);
  const count=f.store.db.prepare('SELECT count(*) AS n FROM operator_actions').get().n;
  assert.equal(repairLegacyMessages(f.store,execute,true).duplicate,true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operator_actions').get().n,count);
  assert.throws(()=>repairLegacyMessages(f.store,{...execute,reason:'changed'},true),e=>e.code==='idempotency_conflict');
});
test('explicit null receipt ID normalizes once without being overwritten by key order',()=>{
  for(const message of [{kind:'receipt_card',claimId:'c',receiptId:null},{receiptId:null,kind:'receipt_card',claimId:'c'}]){
    const state={messages:[message]}; assert.equal(upgradeLegacyMessages(state).receiptIdsAdded,1);
    assert.equal(state.messages[0].receiptId,'rc_c'); assert.equal(upgradeLegacyMessages(state).receiptIdsAdded,0);
  }
});
for(const sql of ["UPDATE messages SET body='changed' WHERE room_id='target'","UPDATE messages SET seq=1 WHERE room_id='target'","DELETE FROM messages WHERE room_id='target'","UPDATE messages_backfill_cursor SET applied_event_id='wrong' WHERE room_id='target'","UPDATE messages SET record_json=json_set(record_json,'$.unrecognized','PRIVATE') WHERE room_id='target'","DELETE FROM integrity_failures WHERE record_id='target'"])
 test(`nonlegacy or incomplete state cannot be repaired: ${sql.split(' ')[0]} ${sql.split(' ')[1]}`,t=>{
  const f=fixture(t); f.store.db.exec(sql); const before=rows(f.store);
  assert.throws(()=>repairLegacyMessages(f.store,f.input),e=>e.code==='repair_not_exact_legacy'); assert.equal(rows(f.store),before);
});
test('stale head, changed plan, invalid scope and forged digest refuse before writes',t=>{
  const f=fixture(t), execute=plan(f), before=rows(f.store);
  assert.throws(()=>repairLegacyMessages(f.store,{...f.input,rooms:[{roomId:'target',expectedHead:999}]}),e=>e.code==='repair_head_changed');
  assert.throws(()=>repairLegacyMessages(f.store,{...execute,planHash:'0'.repeat(64)},true),e=>e.code==='repair_plan_changed');
  assert.throws(()=>repairLegacyMessages(f.store,{...f.input,rooms:Array(4).fill(f.input.rooms[0])}),e=>e.code==='invalid_legacy_repair');
  f.store.db.exec("UPDATE messages SET reactions_json='changed' WHERE room_id='target'");
  assert.throws(()=>repairLegacyMessages(f.store,execute,true),e=>e.code==='repair_plan_changed');
  assert.notEqual(rows(f.store),before);
});
for(const late of ['verify','audit']) test(`${late} failure rolls back repair and preserves failure but invalidates old certificate`,t=>{
  const f=fixture(t), execute=plan(f), before=rows(f.store), failures=JSON.stringify(f.store.integrityFailures());
  if(late==='verify') f.store.checkMessagesParity=()=>{throw Error('PRIVATE failure');};
  else f.store.db.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON operator_actions WHEN NEW.action='legacy_messages_repaired' BEGIN SELECT RAISE(ABORT,'late audit failure'); END");
  assert.throws(()=>repairLegacyMessages(f.store,execute,true));
  assert.equal(rows(f.store),before); assert.equal(JSON.stringify(f.store.integrityFailures()),failures);
  assert.equal(f.store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='target'").get().parity_at_seq,null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='legacy_messages_repaired'").get().n,0);
});
test('extra rows and excess work hydration cannot enter repair',t=>{
  const f=fixture(t), row=f.store.db.prepare("SELECT * FROM messages WHERE room_id='target'").get();
  f.store.db.prepare(`INSERT INTO messages(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values({...row,message_id:'extra'}));
  assert.throws(()=>repairLegacyMessages(f.store,f.input),e=>e.code==='repair_not_exact_legacy');
  f.store.db.exec("DELETE FROM messages WHERE message_id='extra'");
  f.store.db.prepare('INSERT INTO work_entities(room_id,work_id,revision,digest,body) VALUES(?,?,?,?,?)').run('target','oversize',1,'digest','x'.repeat(4*1024*1024+1));
  assert.throws(()=>repairLegacyMessages(f.store,f.input),e=>e.code==='repair_bound_exceeded');
});
test('Operator HTTP gate refuses room bearer and supports plan then execute',async t=>{
  const f=fixture(t), token='legacy-repair-operator-fixture-1234567890', old=process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
  t.after(()=>{if(old===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=old;});
  const server=createRoomServer({store:f.store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const post=(action,auth,data)=>fetch(`http://127.0.0.1:${server.address().port}/api/operator/messages/legacy-repair/${action}`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post('plan','Bearer '+f.store.issueAccessKey('target','owner'),f.input)).status,404);
  const response=await post('plan','Operator '+token,f.input);assert.equal(response.status,200);
  const planned=await response.json();const done=await post('execute','Operator '+token,{...f.input,planHash:planned.planHash,requestId:'http-repair'});
  assert.equal(done.status,200);assert.equal((await done.json()).verified,1);
});

test('multi-room canonical failure is atomic and preserves unrelated certificates', t => {
  const f=fixture(t), db=f.store.db;
  db.exec("UPDATE messages SET record_json=json_set(record_json,'$.receiptId',NULL) WHERE room_id='other'");
  f.store.recordIntegrityFailure('messages_parity','other',new Error('old mismatch'));
  f.input.rooms.push({roomId:'other',expectedHead:db.prepare("SELECT sequence FROM rooms WHERE id='other'").get().sequence});
  const execute=plan(f), before=rows(f.store), failures=JSON.stringify(f.store.integrityFailures());
  const verify=f.store.checkMessagesParity.bind(f.store);let called=0;
  f.store.checkMessagesParity=args=>{if(++called===2)throw Error('injected second verification');return verify(args);};
  assert.throws(()=>repairLegacyMessages(f.store,execute,true),e=>e.code==='repair_verification_failed');
  assert.equal(rows(f.store),before);assert.equal(JSON.stringify(f.store.integrityFailures()),failures);
  assert.ok(db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id IN ('target','other')").all().every(row=>row.parity_at_seq===null));
});
test('over-limit event source refuses repair without any row changes',t=>{
  const f=fixture(t), db=f.store.db, row=db.prepare("SELECT * FROM events WHERE room_id='target' LIMIT 1").get();
  const insert=db.prepare(`INSERT INTO events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`);
  for(let n=0;n<2001;n++)insert.run(...Object.values({...row,sequence:10000+n,id:`bound-${n}`}));
  const before=rows(f.store);assert.throws(()=>repairLegacyMessages(f.store,f.input),e=>e.code==='repair_not_exact_legacy');assert.equal(rows(f.store),before);
});
test('failed execution invalidation does not touch unrelated room certificate',t=>{
  const f=fixture(t), execute=plan(f), before=f.store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='other'").get().parity_at_seq;
  f.store.checkMessagesParity=()=>{throw Error('injected');};
  assert.throws(()=>repairLegacyMessages(f.store,execute,true));
  assert.equal(f.store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='other'").get().parity_at_seq,before);
});
