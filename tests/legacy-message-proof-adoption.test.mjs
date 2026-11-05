import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';
import { MESSAGE_PROOF_FIELDS, messageProofMatches, projectionDigest } from '../server/write-integrity.mjs';
import { createHash } from 'node:crypto';
import { createRoomServer } from '../server/http.mjs';
import { event } from '../src/events.js';
import { pre749PrefixDigest } from '../server/historical-replay-contract.mjs';
import { seedLegacyFixture, historicalSequence } from './helpers/legacy-session-fixture.mjs';
const MODE = 'adopt-absent-inline-v1', roomId = 'legacy-room';
function fixture(t, { oldShape = false, events } = {}) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const f = seedLegacyFixture(s,events);
  f.originalProofs = new Map(s.db.prepare('SELECT message_id,entity_hash FROM messages WHERE room_id=?').all(roomId).map(row=>[row.message_id,row.entity_hash]));
  if (oldShape) projection(f, state => {
    for (const message of state.messages) delete message.channelId;
    for (const item of Object.values(state.workItems)) {
      delete item.round_count; delete item.tool_calls; delete item.suspended_by;
    }
  });
  s.db.prepare('UPDATE messages SET entity_hash=NULL WHERE room_id=?').run(roomId);
  f.request = { ...f.request, messageProofMode: MODE }; return f;
}
function projection(f, change) {
  f.s.transaction(() => {
    const state = structuredClone(f.s.room(roomId).state); change(state);
    f.s.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(f.s.storedProjection(roomId,state),roomId);
    f.s.rememberReconstructedRoomProof(roomId);
  });
}
function snapshot(s, { audit = true, proof = true } = {}) {
  return Object.fromEntries(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(({name}) => audit || name !== 'operator_actions').map(({name}) => [name,s.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => {
      const value = { ...row }; if (!proof && name === 'messages') delete value.entity_hash; return value;
    })]));
}
const execute = (f,plan,id='adopt-1',more={}) => repairLegacyMessages(f.s,{...f.request,planHash:plan.planHash,requestId:id,...more},true);
for (const oldShape of [false,true]) test(`explicit absent-proof plan and atomic execution preserve every serving value (${oldShape?'source-backed old view':'current view'})`, t => {
  const f = fixture(t,{oldShape}), before = snapshot(f.s,{audit:false}), prior = { ...f.request }; delete prior.messageProofMode;
  assert.throws(() => repairLegacyMessages(f.s,prior), e => e.code === 'repair_projection_unavailable' && e.detail.repairCheck === 'message_proof_missing');
  const plan = repairLegacyMessages(f.s,f.request);
  assert.equal(plan.messageProofMode,MODE); assert.equal(plan.derivedOnly,false); assert.equal(plan.servingContentChanged,false);
  assert.equal(plan.messageProofsToAdopt,1); assert.deepEqual(snapshot(f.s,{audit:false}),before,'plan never adopts proofs or changes derived data');
  const serving = Object.fromEntries(['rooms','messages','work_entities','integrity_room_state','events'].map(name=>[name,before[name].map(row=>{const out={...row};if(name==='messages')delete out.entity_hash;return out;})]));
  const completed = execute(f,plan);
  assert.equal(completed.messageProofsAdopted,1); assert.equal(completed.verified,1);
  for (const [name,rows] of Object.entries(serving)) assert.deepEqual(snapshot(f.s,{audit:false,proof:false})[name],rows);
  assert.equal(f.s.db.prepare('SELECT * FROM messages WHERE room_id=?').all(roomId).every(messageProofMatches),true);
  assert.equal(f.s.checkMessagesParity({roomId}).ok,true,'ordinary future parity accepts the unchanged serving representation');
  assert.deepEqual(execute(f,plan),{...completed,duplicate:true});
  assert.equal(completed.replayContract.version,1); assert.equal(completed.replayContract.adapterVersion,1);
  assert.equal(completed.replayContract.throughSequence,f.events.length); assert.equal(completed.replayContract.snapshotHash,plan.snapshotHash);
});
for (const value of ['', 'bad', '0'.repeat(64)]) test(`present invalid proof is never adopted: ${value.length}`, t => {
  const f=fixture(t);f.s.db.prepare('UPDATE messages SET entity_hash=? WHERE room_id=?').run(value,roomId);const before=snapshot(f.s);
  assert.throws(()=>repairLegacyMessages(f.s,f.request),e=>e.code==='repair_projection_unavailable'&&e.detail.repairCheck==='message_proof_mismatch');assert.deepEqual(snapshot(f.s),before);
});
for (const field of MESSAGE_PROOF_FIELDS) test(`independent adoption compares every persisted proof field: ${field}`, t => {
  const f=fixture(t), row=f.s.db.prepare('SELECT * FROM messages WHERE room_id=?').get(roomId);
  const value=field==='seq'?row.seq-1:field==='pinned'?1:field==='reactions_json'?'{}':field==='record_json'||field==='reducer_extras_json'?'{"untrusted":true}':'synthetic-changed';
  f.s.db.prepare(`UPDATE messages SET ${field}=? WHERE room_id=?`).run(value,roomId);const before=snapshot(f.s);
  assert.throws(()=>repairLegacyMessages(f.s,f.request),e=>e.status===409);assert.deepEqual(snapshot(f.s),before);
});
for (const damage of ['entity-ref','missing-row','extra-row','inactive-owner','grant-change','explicit-null-round','malformed-round','explicit-null-channel','extra-work-key','changed-existing-work','missing-record-key','extra-record-key','null-extras','malformed-record'])
  test(`adoption refuses ${damage} without certifying or replacing anything`, t=>{
    const f=fixture(t),db=f.s.db;
    if(damage==='entity-ref')f.s.transaction(()=>{const raw=JSON.parse(db.prepare('SELECT projection FROM rooms WHERE id=?').get(roomId).projection);raw.messages=raw.messages.map(message=>({id:message.id,_entity:1}));db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(raw),roomId);f.s.rememberReconstructedRoomProof(roomId);});
    if(damage==='missing-row')db.prepare('DELETE FROM messages WHERE room_id=?').run(roomId);
    if(damage==='extra-row'){const row=db.prepare('SELECT * FROM messages WHERE room_id=?').get(roomId);db.prepare(`INSERT INTO messages(room_id,${MESSAGE_PROOF_FIELDS.join(',')},entity_hash) VALUES(${Array(MESSAGE_PROOF_FIELDS.length+2).fill('?').join(',')})`).run(roomId,...MESSAGE_PROOF_FIELDS.map(field=>field==='message_id'?'extra':row[field]),null);}
    if(damage==='inactive-owner')projection(f,state=>{state.members.owner.active=false;});
    if(damage==='grant-change')projection(f,state=>{state.members.owner.permissions=[];});
    if(damage==='explicit-null-round')projection(f,state=>{state.workItems.task.round_count=null;});
    if(damage==='malformed-round')projection(f,state=>{state.workItems.task.round_count=-1;});
    if(damage==='explicit-null-channel')projection(f,state=>{state.messages[0].channelId=null;});
    if(damage==='extra-work-key')projection(f,state=>{state.workItems.task.untrusted=true;});
    if(damage==='changed-existing-work')projection(f,state=>{state.workItems.task.title='Changed independent intent';});
    if(damage==='missing-record-key'||damage==='extra-record-key'){const row=db.prepare('SELECT record_json FROM messages WHERE room_id=?').get(roomId),record=JSON.parse(row.record_json);if(damage==='missing-record-key')delete record.authorId;else record.untrusted=true;db.prepare('UPDATE messages SET record_json=? WHERE room_id=?').run(JSON.stringify(record),roomId);}
    if(damage==='null-extras')db.prepare('UPDATE messages SET reducer_extras_json=NULL WHERE room_id=?').run(roomId);
    if(damage==='malformed-record')db.prepare("UPDATE messages SET record_json='{' WHERE room_id=?").run(roomId);
    const before=snapshot(f.s);assert.throws(()=>repairLegacyMessages(f.s,f.request),e=>e.status===409);assert.deepEqual(snapshot(f.s),before);
  });
test('equivalent JSON key order preserves exact row bytes when hashing an independently proved row',t=>{
  const f=fixture(t),db=f.s.db,row=db.prepare('SELECT record_json FROM messages WHERE room_id=?').get(roomId),record=JSON.parse(row.record_json);
  const wire=JSON.stringify(Object.fromEntries(Object.entries(record).reverse()),null,1);db.prepare('UPDATE messages SET record_json=? WHERE room_id=?').run(wire,roomId);
  const plan=repairLegacyMessages(f.s,f.request);execute(f,plan);const after=db.prepare('SELECT * FROM messages WHERE room_id=?').get(roomId);
  assert.equal(after.record_json,wire);assert.equal(messageProofMatches(after),true);
});
for(const stage of ['proof','derived','receipt'])test(`storage fault at ${stage} rolls back proofs, derived state and receipt before exact retry`,t=>{
  const f=fixture(t),plan=repairLegacyMessages(f.s,f.request),before=snapshot(f.s),db=f.s.db;
  const target=stage==='proof'?['messages','UPDATE','NEW.entity_hash IS NOT NULL']:stage==='derived'?['messages_backfill_cursor','UPDATE','1']:['operator_actions','INSERT',"NEW.action='legacy_session_backfill_reconciled'"];
  db.exec(`CREATE TRIGGER fail_adoption BEFORE ${target[1]} ON ${target[0]} WHEN ${target[2]} BEGIN SELECT RAISE(ABORT,'synthetic adoption storage fault'); END`);
  assert.throws(()=>execute(f,plan),/synthetic adoption storage fault/);assert.deepEqual(snapshot(f.s),before);
  db.exec('DROP TRIGGER fail_adoption');const completed=execute(f,plan);assert.equal(completed.messageProofsAdopted,1);assert.deepEqual(execute(f,plan),{...completed,duplicate:true});
});
test('same-head source mutation and opt-in intent changes cannot reuse a plan or saved response',t=>{
  const f=fixture(t),plan=repairLegacyMessages(f.s,f.request);
  f.s.db.prepare("UPDATE events SET body=json_set(body,'$.data.note','new source') WHERE room_id=? AND json_extract(body,'$.type')='work.accepted'").run(roomId);
  const before=snapshot(f.s);assert.throws(()=>execute(f,plan),e=>e.code==='repair_plan_changed');assert.deepEqual(snapshot(f.s),before);
});
test('lost response remains an immutable exact retry after later source writes',t=>{
  const f=fixture(t),plan=repairLegacyMessages(f.s,f.request),completed=execute(f,plan),key=f.s.issueAccessKey(roomId,'owner');
  f.s.command(key,roomId,{id:'later',type:'message.posted',data:{messageId:'later-message',body:'Later synthetic post'}});
  const before=snapshot(f.s);assert.deepEqual(execute(f,plan),{...completed,duplicate:true});assert.deepEqual(snapshot(f.s),before);
  assert.throws(()=>execute(f,plan,'adopt-1',{messageProofMode:undefined}),e=>e.code==='idempotency_conflict');
});

test('protected body references justify proofs without changing body or carrier bytes',t=>{
  const f=fixture(t),db=f.s.db;
  f.s.transaction(()=>{const raw=JSON.parse(db.prepare('SELECT projection FROM rooms WHERE id=?').get(roomId).projection),message=raw.messages[0];
    const digest=projectionDigest(message.body);db.prepare('INSERT INTO projection_bodies(room_id,sha,body) VALUES(?,?,?)').run(roomId,digest,message.body);
    message.bodyRef=digest;delete message.body;db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(raw),roomId);f.s.rememberReconstructedRoomProof(roomId);
  });
  const before=snapshot(f.s,{audit:false,proof:false}),plan=repairLegacyMessages(f.s,f.request);execute(f,plan);
  for(const table of ['rooms','work_entities','projection_bodies','integrity_room_state','events','messages'])assert.deepEqual(snapshot(f.s,{audit:false,proof:false})[table],before[table]);
});
for (const stage of ['proof','derived','receipt']) test(`EIO after ${stage} write preserves typed refusal and rolls back before retry`,t=>{
  const f=fixture(t),plan=repairLegacyMessages(f.s,f.request),before=snapshot(f.s),db=f.s.db,prepare=db.prepare.bind(db),fault=Object.assign(new Error('synthetic I/O'),{code:'EIO'});let armed=true;
  db.prepare=sql=>{const statement=prepare(sql);const selected=stage==='proof'?sql.startsWith('UPDATE messages SET entity_hash='):stage==='derived'?sql.startsWith('UPDATE messages_backfill_cursor SET applied_seq='):sql.startsWith('INSERT INTO operator_actions(id,at,action');
    if(selected){const run=statement.run.bind(statement);statement.run=(...args)=>{const value=run(...args);if(armed){armed=false;throw fault;}return value;};}return statement;};
  assert.throws(()=>execute(f,plan),error=>error.status===503&&error.code==='storage_unavailable'&&error.cause===fault);
  db.prepare=prepare;assert.deepEqual(snapshot(f.s),before);assert.equal(execute(f,plan).messageProofsAdopted,1);
});

test('mixed existing valid proofs and inactive authors retain their exact proof and access bytes',t=>{
  const events=historicalSequence(),extra=(id,type,actorId,data)=>event({id,roomId,actorId,type,data,at:'2026-09-01T02:00:00Z'});
  events.push(extra('add-peer','member.added','owner',{memberId:'peer',displayName:'Synthetic peer',kind:'agent',permissions:['steer']}),
    extra('peer-post','message.posted','peer',{messageId:'peer-message',body:'Historical synthetic post'}),
    extra('deactivate-peer','member.access_changed','owner',{memberId:'peer',expectedMemberRevision:0,permissions:[],active:false}));
  const f=fixture(t,{events}),db=f.s.db,held=f.originalProofs.get('message');
  db.prepare('UPDATE messages SET entity_hash=? WHERE room_id=? AND message_id=?').run(held,roomId,'message');
  const plan=repairLegacyMessages(f.s,f.request);assert.equal(plan.messageProofsToAdopt,1);execute(f,plan);
  assert.equal(db.prepare('SELECT entity_hash FROM messages WHERE room_id=? AND message_id=?').get(roomId,'message').entity_hash,held);
  assert.equal(f.s.room(roomId).state.members.peer.active,false);assert.deepEqual(f.s.room(roomId).state.members.peer.permissions,[]);
});
test('successful receipt prefix evidence binds exact source independently of later head changes',t=>{
  const f=fixture(t),plan=repairLegacyMessages(f.s,f.request),completed=execute(f,plan),db=f.s.db;
  const rows=db.prepare('SELECT sequence,CAST(id AS BLOB) AS id,CAST(body AS BLOB) AS body FROM events WHERE room_id=? ORDER BY sequence').all(roomId);
  assert.equal(completed.replayContract.prefixSha256,pre749PrefixDigest(roomId,rows));
  assert.equal(completed.replayContract.headEventId,Buffer.from(rows.at(-1).id).toString());
  rows[0]={...rows[0],body:Buffer.concat([rows[0].body,Buffer.from(' ')])};assert.notEqual(pre749PrefixDigest(roomId,rows),completed.replayContract.prefixSha256);
});
test('opt-in HTTP remains operator-only and keeps proof diagnostics fixed and sanitized',async t=>{
  const f=fixture(t),token='synthetic-opt-in-operator-credential-0001',previous=process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
  const server=createRoomServer({store:f.s});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=previous;});
  const origin='http://127.0.0.1:'+server.address().port;
  const call=authorization=>fetch(origin+'/api/operator/messages/legacy-repair/plan',{method:'POST',headers:{origin,'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify(f.request)});
  const before=snapshot(f.s);
  for(const auth of [undefined,'Bearer '+token,'Operator wrong']){const response=await call(auth),body=await response.json();assert.equal(response.status,404);assert.equal(body.repairCheck,undefined);assert.deepEqual(snapshot(f.s),before);}
  const response=await call('Operator '+token),body=await response.json();assert.equal(response.status,200);assert.equal(body.messageProofsToAdopt,1);
  f.s.db.prepare("UPDATE messages SET entity_hash='DO_NOT_EMIT' WHERE room_id=?").run(roomId);
  const refused=await call('Operator '+token),error=await refused.json();assert.equal(refused.status,409);assert.equal(error.repairCheck,'message_proof_mismatch');assert.match(error.operationId,/^op_/);assert.equal(JSON.stringify(error).includes('DO_NOT_EMIT'),false);
});

test('new proof output bytes share the original admitted unit and cannot overrun its cap',t=>{
  const f=fixture(t),first=repairLegacyMessages(f.s,f.request),spare=first.admission.limitBytes-first.admission.inputBytes-first.admission.outputBytes-first.admission.receiptReserveBytes;
  assert.ok(spare>0);f.s.db.prepare("UPDATE message_replay_snapshots SET state_json=state_json||? WHERE room_id=?").run(' '.repeat(spare+1),roomId);
  const before=snapshot(f.s);assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_bound_exceeded');assert.deepEqual(snapshot(f.s),before);
});
test('a strict plan cannot authorize the different explicit proof-adoption intent',t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());const f=seedLegacyFixture(s),plain=repairLegacyMessages(s,f.request);
  const opted={...f.request,messageProofMode:MODE},different=repairLegacyMessages(s,opted);
  assert.notEqual(different.planHash,plain.planHash);const before=snapshot(s);
  assert.throws(()=>repairLegacyMessages(s,{...opted,planHash:plain.planHash,requestId:'different-mode'},true),error=>error.code==='repair_plan_changed');assert.deepEqual(snapshot(s),before);
});
test('the original 64-event boundary can atomically adopt every justified missing row proof',t=>{
  const events=historicalSequence();
  while(events.length<64)events.push(event({id:'bounded-extra-'+events.length,roomId,actorId:'owner',type:'message.posted',data:{messageId:'bounded-extra-'+events.length,body:'Bounded synthetic history'},at:'2026-09-01T03:00:00Z'}));
  const f=fixture(t,{events}),plan=repairLegacyMessages(f.s,f.request),rows=f.s.db.prepare('SELECT * FROM messages WHERE room_id=?').all(roomId);
  assert.equal(plan.rooms[0].events,64);assert.equal(plan.messageProofsToAdopt,rows.length);assert.equal(execute(f,plan).messageProofsAdopted,rows.length);
  assert.equal(f.s.db.prepare('SELECT * FROM messages WHERE room_id=?').all(roomId).every(messageProofMatches),true);
});

function structuredFixture(t) {
  const events=historicalSequence();events.at(-1).data.actions=[{claimId:'task',label:'Action'}];
  events.push(event({id:'synthetic-edit',idempotencyKey:'synthetic-edit-key',roomId,actorId:'owner',at:'2026-09-01T00:02:00.000Z',type:'message.edited',data:{messageId:'message',expectedMessageRevision:0,body:'Edited synthetic message'}}));
  return fixture(t,{events});
}
for(const field of ['record_json','reducer_extras_json'])for(const nested of [false,true])for(const escaped of [false,true])
  test(`opt-in refuses shadowed JSON keys ${field} nested=${nested} escaped=${escaped}`,t=>{
    const f=structuredFixture(t),row=f.s.db.prepare(`SELECT ${field} AS json FROM messages`).get(),value=JSON.parse(row.json);
    const key=nested?(field==='record_json'?'label':'body'):(field==='record_json'?'body':'editHistory');
    const encoded=escaped?'\\u'+key.charCodeAt(0).toString(16).padStart(4,'0')+key.slice(1):key;
    const shadow='"'+encoded+'":'+(key==='editHistory'?'[]':'"untrusted shadow"')+',';
    let wire;
    if(nested){const target=field==='record_json'?value.actions[0]:value.editHistory[0];const original=JSON.stringify(target);wire=row.json.replace(original,'{'+shadow+original.slice(1));}
    else wire='{'+shadow+row.json.slice(1);
    assert.deepEqual(JSON.parse(wire),value,'the old JSON.parse comparison loses the shadowed field');
    f.s.db.prepare(`UPDATE messages SET ${field}=?`).run(wire);const before=snapshot(f.s);
    assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_not_exact_legacy'&&error.status===409);
    assert.deepEqual(snapshot(f.s),before);
  });
for(const field of ['record_json','reducer_extras_json'])test(`opt-in preserves normal arrays and ordered whitespace JSON ${field}`,t=>{
  const f=structuredFixture(t),row=f.s.db.prepare(`SELECT ${field} AS json FROM messages`).get(),value=JSON.parse(row.json);
  const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([key,x])=>[key,reorder(x)])):v;
  const wire=JSON.stringify(reorder(value),null,2);f.s.db.prepare(`UPDATE messages SET ${field}=?`).run(wire);
  const plan=repairLegacyMessages(f.s,f.request);execute(f,plan);assert.equal(f.s.db.prepare(`SELECT ${field} AS json FROM messages`).get().json,wire);
});
for(const wire of ["{'body':'JSON5'}",'{"body":}'])test(`opt-in rejects nonordinary JSON before duplicate traversal ${wire.length}`,t=>{
  const f=structuredFixture(t),db=f.s.db;db.prepare('UPDATE messages SET record_json=?').run(wire);const before=snapshot(f.s),prepare=db.prepare.bind(db);let traversals=0;
  db.prepare=sql=>{if(sql.includes('json_tree'))traversals++;return prepare(sql);};
  assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_not_exact_legacy'&&error.status===409);assert.equal(traversals,0);db.prepare=prepare;assert.deepEqual(snapshot(f.s),before);
});
test('opt-in duplicate traversal storage fault remains typed and exact retry succeeds once',t=>{
  const f=structuredFixture(t),plan=repairLegacyMessages(f.s,f.request),db=f.s.db,before=snapshot(f.s),prepare=db.prepare.bind(db),fault=Object.assign(new Error('synthetic duplicate read I/O'),{code:'EIO'});
  db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('json_tree'))statement.get=()=>{throw fault;};return statement;};
  assert.throws(()=>execute(f,plan),error=>error.status===503&&error.code==='storage_unavailable'&&error.cause===fault);
  db.prepare=prepare;assert.deepEqual(snapshot(f.s),before);const completed=execute(f,plan);assert.equal(completed.messageProofsAdopted,1);assert.deepEqual(execute(f,plan),{...completed,duplicate:true});
});
