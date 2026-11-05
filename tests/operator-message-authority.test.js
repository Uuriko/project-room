import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { operatorMessageAuthority } from '../server/operator-message-authority.mjs';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
const TOKEN='test-message-authority-operator-0123456789';
async function fixture(t) {
 const prior=process.env.ROOM_OPERATOR_TOKEN_SHA256;
 process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(TOKEN).digest('hex');
 const store=new RoomStore(':memory:');store.initialize(initialRoom());
 const key=store.issueAccessKey('commons','owner');
 const post=(id)=>store.command(key,'commons',{id,type:'message.posted',data:{messageId:id,body:'Saved '+id}});
 post('first');while(!store.backfillMessages({limit:100}).done){}
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();if(prior===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=prior;});
 const call=async(kind,input={},token=TOKEN)=>{
  const response=await fetch(origin+'/api/operator/messages/authority/'+kind,{method:'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Operator '+token}:{})},body:JSON.stringify({...(kind==='execute'?{requestId:'test-execute-'+(input.reverse?'reverse':'forward')}:{}),roomId:'commons',reason:'Explicit qualification',...input})});
  return {status:response.status,body:await response.json()};
 };
 const raw=()=>store.db.prepare("SELECT sequence,projection FROM rooms WHERE id='commons'").get();
 return {store,key,post,call,raw};
}
test('operator plans and executes explicit canonical conversion, preserving head and contents',async t=>{
 const f=await fixture(t),before=f.raw(),expected=f.store.room('commons').state;
 const plan=await f.call('plan');assert.equal(plan.status,200,JSON.stringify(plan.body));
 assert.deepEqual(f.raw(),before,'planning does not rewrite the projection');
 const done=await f.call('execute',{planHash:plan.body.planHash});assert.equal(done.status,200,JSON.stringify(done.body));
 assert.equal(f.raw().sequence,before.sequence);assert.equal(Object.hasOwn(JSON.parse(f.raw().projection),'messages'),false);
 assert.deepEqual(f.store.room('commons').state.messages,expected.messages);
 const reverse=await f.call('plan',{reverse:true});assert.equal(reverse.status,200);
 assert.equal((await f.call('execute',{reverse:true,planHash:reverse.body.planHash})).status,200);
 assert.deepEqual(f.store.room('commons').state,expected);
});
test('operator access and exact plan binding refuse unauthorized or changed input',async t=>{
 const f=await fixture(t),before=f.raw();
 assert.equal((await f.call('plan',{},null)).status,404);
 assert.equal((await f.call('execute',{})).status,422);
 const plan=await f.call('plan');assert.equal(plan.status,200);
 assert.equal((await f.call('execute',{reverse:true,planHash:plan.body.planHash})).status,409);
 f.post('later');const changed=f.raw();
 assert.equal((await f.call('execute',{planHash:plan.body.planHash})).status,409);
 assert.deepEqual(f.raw(),changed);assert.notEqual(changed.sequence,before.sequence);
});

test('lost execute response can be retried after later writes without another effect',async t=>{
 const f=await fixture(t),plan=await f.call('plan');
 const input={requestId:'stable-execute',planHash:plan.body.planHash};
 const first=await f.call('execute',input);assert.equal(first.status,200);
 f.post('after-conversion');const before=f.raw();
 const retry=await f.call('execute',input);assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);
 assert.deepEqual(retry.body.result,first.body.result);assert.deepEqual(f.raw(),before);
 const changed=await f.call('execute',{...input,reason:'Changed intent'});assert.equal(changed.status,409);
 assert.equal(changed.body.error.code,'idempotency_conflict');assert.deepEqual(f.raw(),before);
});
test('planning never hydrates, certifies or replays a room',async t=>{
 const f=await fixture(t);
 for(const method of ['room','checkMessagesParity','backfillMessages','migrateMessageAuthority'])f.store[method]=()=>{throw Error('unbounded call '+method);};
 const plan=await f.call('plan');assert.equal(plan.status,200,JSON.stringify(plan.body));
});
test('oversized projections, event heads and message payloads refuse before hydration',async t=>{
 const f=await fixture(t),original=f.raw();
 for(const method of ['room','checkMessagesParity','backfillMessages','migrateMessageAuthority'])f.store[method]=()=>{throw Error('unbounded call '+method);};
 const mutations=[()=>f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(' '.repeat(524289)),
  ()=>f.store.db.prepare("UPDATE rooms SET sequence=2049 WHERE id='commons'").run(),
  ()=>f.store.db.prepare("UPDATE messages SET reducer_extras_json=? WHERE room_id='commons'").run('x'.repeat(1048577))];
 for(const mutate of mutations){
  f.store.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id='commons'").run(original.sequence,original.projection);
  mutate();const before=f.raw(),plan=await f.call('plan');
  assert.equal(plan.status,409,JSON.stringify(plan.body));assert.equal(plan.body.error.code,'authority_budget_exceeded');assert.deepEqual(f.raw(),before);
 }
});
test('archive conversion is refused rather than trusting unverified archived history',async t=>{
 const f=await fixture(t);f.post('second');f.post('third');while(!f.store.backfillMessages({limit:100}).done){}
 f.store.checkMessagesParity({roomId:'commons'});assert.equal(f.store.archiveMessages('commons',{keepNewest:1,dryRun:false}).ok,true);
 const before=f.raw(),plan=await f.call('plan');assert.equal(plan.status,409);assert.equal(plan.body.error.code,'authority_archive_not_supported');assert.deepEqual(f.raw(),before);
});
test('failed audit publication rolls back conversion and the same request can recover',async t=>{
 const f=await fixture(t),before=f.raw(),plan=await f.call('plan'),input={requestId:'audit-failure',planHash:plan.body.planHash};
 f.store.db.exec("CREATE TRIGGER reject_authority_receipt BEFORE INSERT ON operator_actions WHEN NEW.action='message_authority_execute' BEGIN SELECT RAISE(ABORT,'injected authority audit failure'); END");
 assert.equal((await f.call('execute',input)).status,500);assert.deepEqual(f.raw(),before);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_execute'").get().n,0);
 f.store.db.exec('DROP TRIGGER reject_authority_receipt');assert.equal((await f.call('execute',input)).status,200);
});
test('same-head entity drift invalidates the plan without laundering source rows',async t=>{
 const f=await fixture(t),plan=await f.call('plan');
 f.store.db.prepare("UPDATE messages SET record_json=json_set(record_json,'$.body','Untrusted drift') WHERE room_id='commons'").run();
 const before=f.raw(),result=await f.call('execute',{planHash:plan.body.planHash});assert.equal(result.status,409);
 assert.equal(result.body.error.code,'plan_changed');assert.deepEqual(f.raw(),before);
});
test('reverse cannot launder canonical row drift into newly trusted inline metadata',async t=>{
 const f=await fixture(t),plan=await f.call('plan');assert.equal((await f.call('execute',{planHash:plan.body.planHash})).status,200);
 f.store.db.prepare("UPDATE messages SET body='Drift first',record_json=json_set(record_json,'$.body','Drift first') WHERE message_id='first'").run();
 const before=f.raw();
 assert.throws(()=>f.store.migrateMessageAuthority('commons',{reverse:true}),/projection_corrupt/);
 assert.deepEqual(f.raw(),before);
});
test('every normalized domain refuses cap-plus-one before any hydration or certification',async t=>{
 for(const domain of ['messages','work_entities','projection_bodies','events']) {
  await t.test(domain,async t=>{
   const f=await fixture(t),db=f.store.db;
   if(domain==='messages'){
    const row=db.prepare("SELECT * FROM messages WHERE room_id='commons' LIMIT 1").get(),cols=Object.keys(row);
    const insert=db.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`);
    f.store.transaction(()=>{for(let i=0;i<1024;i++)insert.run(...cols.map(c=>c==='message_id'?'extra-'+i:row[c]));});
   }else if(domain==='work_entities'){
    const insert=db.prepare('INSERT INTO work_entities VALUES(?,?,?,?,?)');f.store.transaction(()=>{for(let i=0;i<129;i++)insert.run('commons','extra-'+i,0,'test','{}');});
   }else if(domain==='projection_bodies'){
    const insert=db.prepare('INSERT INTO projection_bodies VALUES(?,?,?)');f.store.transaction(()=>{for(let i=0;i<1025;i++)insert.run('commons',i.toString(16).padStart(64,'0'),'x');});
   }else{
    const insert=db.prepare('INSERT INTO events VALUES(?,?,?,?)');f.store.transaction(()=>{for(let i=0;i<2049;i++)insert.run('commons',10000+i,'extra-'+i,'{}');});
   }
   for(const method of ['room','checkMessagesParity','migrateMessageAuthority'])f.store[method]=()=>{throw Error('unbounded '+method);};
   assert.throws(()=>operatorMessageAuthority(f.store,{roomId:'commons',reason:'Bounded admission'}),e=>e.code==='authority_budget_exceeded');
  });
 }
});
test('multibyte work payload bytes are bounded even with tiny inline metadata',async t=>{
 const f=await fixture(t);f.store.db.prepare('INSERT INTO work_entities VALUES(?,?,?,?,?)').run('commons','oversized',0,'test','🌏'.repeat(300000));
 f.store.room=()=>{throw Error('unbounded hydration');};
 assert.throws(()=>operatorMessageAuthority(f.store,{roomId:'commons',reason:'UTF-8 byte admission'}),e=>e.code==='authority_budget_exceeded');
});
test('a fresh reverse plan cannot authorize corrupted canonical serving proofs',async t=>{
 const f=await fixture(t),first=await f.call('plan');assert.equal((await f.call('execute',{planHash:first.body.planHash})).status,200);
 f.store.db.prepare("UPDATE messages SET body='Drift first',record_json=json_set(record_json,'$.body','Drift first') WHERE message_id='first'").run();
 const before=f.raw(),plan=await f.call('plan',{reverse:true});assert.equal(plan.status,200);
 const done=await f.call('execute',{reverse:true,planHash:plan.body.planHash});assert.equal(done.status,409);
 assert.equal(done.body.error.code,'authority_integrity_failure');assert.deepEqual(f.raw(),before);
});

test('numeric-affinity storage corruption is refused before payload materialization',async t=>{
 const cases=[['rooms','sequence'],['events','sequence'],['messages','seq'],['work_entities','revision'],['integrity_room_state','sequence'],['messages_backfill_cursor','applied_seq'],['messages_backfill_cursor','state_seq'],['messages_backfill_cursor','parity_at_seq']];
 for(const [table,column] of cases)await t.test(table+'.'+column,async t=>{
  const f=await fixture(t),db=f.store.db;
  if(table==='work_entities')db.prepare('INSERT INTO work_entities VALUES(?,?,?,?,?)').run('commons','malformed',0,'d','{}');
  db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${table==='rooms'?'id':'room_id'}=?${table==='events'?' AND rowid=(SELECT MIN(rowid) FROM events)':''}`).run('x'.repeat(2097152),'commons');
  // Instrument the payload read itself: rejection must happen before any
  // JSON fingerprint/hydration read, not after loading malformed scalars.
  const prepare=db.prepare.bind(db);
  db.prepare=(sql)=>{
   if(/SELECT \*|SELECT projection FROM|SELECT sequence,projection_hash|SELECT applied_seq,applied_event_id/.test(sql))throw Error('payload materialized before admission');
   return prepare(sql);
  };
  assert.throws(()=>operatorMessageAuthority(f.store,{roomId:'commons',reason:'Malformed scalar admission'}),e=>e.code==='authority_budget_exceeded');
 });
});
