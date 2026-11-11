import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { applyEvent, emptyRoomState, event } from '../src/events.js';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';

import { historicalSequence, fixtureLegacyApply, seedLegacyFixture } from './helpers/legacy-session-fixture.mjs';
function legacyFixture(t) { const s=new RoomStore(':memory:');t.after(()=>s.close());return seedLegacyFixture(s); }
const authority=s=>Object.fromEntries(['rooms','messages','work_entities','integrity_room_state'].map(table=>[table,s.db.prepare(`SELECT * FROM ${table} WHERE ${table==='rooms'?'id':'room_id'}=?`).all('legacy-room')]));

test('explicit legacy repair reconciles synthetic pre749 quarantine without rewriting independently proved serving rows',t=>{
  const f=legacyFixture(t),before=authority(f.s);
  const plan=repairLegacyMessages(f.s,f.request);
  const completed=repairLegacyMessages(f.s,{...f.request,planHash:plan.planHash,requestId:'legacy-repair-1'},true);
  assert.equal(completed.derivedOnly,true);
  assert.equal(f.s.db.prepare('SELECT 1 FROM messages_backfill_blocks WHERE room_id=?').get('legacy-room'),undefined);
  assert.deepEqual(authority(f.s),before);
  assert.deepEqual(repairLegacyMessages(f.s,{...f.request,planHash:plan.planHash,requestId:'legacy-repair-1'},true),{...completed,duplicate:true});
});

test('modern direct commands still reject work.accepted after session processing/active/done',t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());const events=historicalSequence();
  const firstAccept=events.findIndex(e=>e.type==='work.accepted');s.initialize(events.slice(0,firstAccept));
  const key=s.issueAccessKey('legacy-room','owner'),head=s.headSequence('legacy-room');
  assert.equal(s.room('legacy-room').state.workItems.task.state,'working');
  assert.throws(()=>s.command(key,'legacy-room',{id:'modern-repeat-accept',type:'work.accepted',data:{workItemId:'task',expectedRevision:3}}),/Invalid transition from working/);
  assert.equal(s.headSequence('legacy-room'),head);
});

test('historical adapter matches predecessor separate ladders without changing public session/grant effects',async()=>{
  const {applyPre749SessionEvent}=await import('../server/legacy-session-replay.mjs');
  const sequence=historicalSequence();let expected=emptyRoomState(),actual=emptyRoomState();
  for(const incoming of sequence){expected=fixtureLegacyApply(expected,incoming);actual=applyPre749SessionEvent(actual,incoming);assert.deepEqual(actual,expected);}
  // Explicit lifecycle steps before active/failed exercise the other two
  // predecessor effects; only item.state may differ from the public reducer.
  let prefix=sequence.slice(0,sequence.findIndex(e=>e.type==='session.started')).reduce(applyPre749SessionEvent,emptyRoomState());
  const extra=(id,type,data)=>event({id,roomId:'legacy-room',actorId:'owner',type,data,at:'2026-09-01T01:00:00Z'});
  for(const incoming of [extra('accept-first','work.accepted',{workItemId:'task'}),extra('start-session','session.started',{workItemId:'task'}),extra('active-session','session.status_changed',{workItemId:'task',status:'active'}),extra('start-work','work.started',{workItemId:'task'}),extra('fail-session','session.stopped',{workItemId:'task',status:'failed'})]){
    const old=fixtureLegacyApply(prefix,incoming),next=applyPre749SessionEvent(prefix,incoming),modern=applyEvent(prefix,incoming);
    assert.deepEqual(next,old);const a=structuredClone(next),b=structuredClone(modern);a.workItems.task.state=b.workItems.task.state;
    assert.deepEqual(a,b,'every non-lifecycle field, including permissions, keeps the public reducer result');prefix=next;
  }
});

const derived=s=>Object.fromEntries(['messages_backfill_cursor','message_replay_snapshots','messages_backfill_state','messages_backfill_blocks'].map(table=>[table,s.db.prepare(`SELECT * FROM ${table} WHERE room_id IN (?,?) ORDER BY room_id`).all('legacy-room','legacy-room\0anchor')]));
const execute=(f,plan,id='repair-1',extra={})=>repairLegacyMessages(f.s,{...f.request,planHash:plan.planHash,requestId:id,...extra},true);
for(const damage of ['metadata-proof','message-proof','missing-work','changed-work'])test(`historical repair refuses ${damage} without replacing serving truth or derived artifacts`,t=>{
  const f=legacyFixture(t),db=f.s.db;
  if(damage==='metadata-proof')db.prepare('UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id=?').run('legacy-room');
  if(damage==='message-proof')db.prepare('UPDATE messages SET entity_hash=NULL WHERE room_id=?').run('legacy-room');
  if(damage==='missing-work')db.prepare('DELETE FROM work_entities WHERE room_id=?').run('legacy-room');
  if(damage==='changed-work')f.s.transaction(()=>{const state=structuredClone(f.s.room('legacy-room').state);state.workItems.task.title='Different independently proved current intent';db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(f.s.storedProjection('legacy-room',state),'legacy-room');f.s.rememberReconstructedRoomProof('legacy-room');});
  const before=derived(f.s),serving=authority(f.s);
  assert.throws(()=>repairLegacyMessages(f.s,f.request),e=>['repair_projection_unavailable','repair_not_exact_legacy'].includes(e.code));
  assert.deepEqual(derived(f.s),before);assert.deepEqual(authority(f.s),serving);
});

test('historical repair audit failure rolls back the entire derived slice and never writes authority',t=>{
  const f=legacyFixture(t),plan=repairLegacyMessages(f.s,f.request),before=derived(f.s),serving=authority(f.s);
  f.s.db.exec("CREATE TRIGGER reject_legacy_receipt BEFORE INSERT ON operator_actions WHEN NEW.action='legacy_session_backfill_reconciled' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.throws(()=>execute(f,plan),/synthetic audit failure/);assert.deepEqual(derived(f.s),before);assert.deepEqual(authority(f.s),serving);
});

test('unexpected parity storage fault rolls back artifacts rather than becoming a history refusal',t=>{
  const f=legacyFixture(t),plan=repairLegacyMessages(f.s,f.request),before=derived(f.s),serving=authority(f.s);let injected=null;
  f.s.checkMessagesParity=()=>{try{f.s.db.prepare('SELECT * FROM absent_legacy_repair_storage_probe').get();}catch(error){injected=error;throw error;}};
  assert.throws(()=>execute(f,plan),error=>error===injected&&error.code==='ERR_SQLITE_ERROR');assert.deepEqual(derived(f.s),before);assert.deepEqual(authority(f.s),serving);
});

test('lost-response receipt stays immutable after later modern writes and bounded backfill',t=>{
  const f=legacyFixture(t),plan=repairLegacyMessages(f.s,f.request),receipt=execute(f,plan),key=f.s.issueAccessKey('legacy-room','owner');
  f.s.command(key,'legacy-room',{id:'later-message',type:'message.posted',data:{messageId:'later',body:'A later synthetic modern message'}});
  assert.equal(f.s.backfillMessages({limit:64}).quarantined.length,0);
  const before=derived(f.s),serving=authority(f.s);
  assert.deepEqual(execute(f,plan),{...receipt,duplicate:true});assert.deepEqual(derived(f.s),before);assert.deepEqual(authority(f.s),serving);
  assert.throws(()=>execute(f,plan,'repair-1',{reason:'Changed intent'}),error=>error.code==='idempotency_conflict');
});

test('a changed head invalidates a plan before any derived reconciliation',t=>{
  const f=legacyFixture(t),plan=repairLegacyMessages(f.s,f.request),key=f.s.issueAccessKey('legacy-room','owner');
  f.s.command(key,'legacy-room',{id:'before-execute',type:'message.posted',data:{messageId:'changed-head',body:'New synthetic source'}});
  const before=derived(f.s);assert.throws(()=>execute(f,plan),e=>e.code==='repair_head_changed');assert.deepEqual(derived(f.s),before);
});

for(const [table,column]of [['rooms','sequence'],['events','sequence'],['messages_backfill_cursor','state_seq'],['integrity_room_state','sequence'],['messages_backfill_state','part']])test(`${table} oversized numeric-affinity control refuses before payload transfer`,t=>{
  const f=legacyFixture(t),db=f.s.db;
  if(table==='messages_backfill_state')db.prepare('INSERT INTO messages_backfill_state VALUES(?,?,?)').run('legacy-room','x'.repeat(2*1024*1024),'');
  else db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${table==='rooms'?'id':'room_id'}=?${table==='events'?' AND sequence=(SELECT MIN(sequence) FROM events WHERE room_id=\'legacy-room\')':''}`).run('x'.repeat(2*1024*1024),'legacy-room');
  const prepare=db.prepare.bind(db);let payloadRead=false;
  db.prepare=sql=>{if(sql.startsWith('SELECT id,sequence,projection,archived_at FROM rooms')){payloadRead=true;throw Error('payload transferred before admission');}return prepare(sql);};
  assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_bound_exceeded');assert.equal(payloadRead,false);
});

test('serving equality includes current permissions and never resurrects a grant',t=>{
  const f=legacyFixture(t);f.s.transaction(()=>{const state=structuredClone(f.s.room('legacy-room').state);state.members.owner.permissions=[];f.s.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(f.s.storedProjection('legacy-room',state),'legacy-room');f.s.rememberReconstructedRoomProof('legacy-room');});
  const before=authority(f.s),staging=derived(f.s);assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_not_exact_legacy');assert.deepEqual(authority(f.s),before);assert.deepEqual(derived(f.s),staging);
});

test('same-sequence source change invalidates a plan even when it leaves reducer values unchanged',t=>{
  const f=legacyFixture(t),plan=repairLegacyMessages(f.s,f.request);
  f.s.db.prepare("UPDATE events SET body=json_set(body,'$.data.note','new source fingerprint') WHERE room_id=? AND json_extract(body,'$.type')='work.accepted'").run('legacy-room');
  const before=derived(f.s);assert.throws(()=>execute(f,plan),error=>error.code==='repair_plan_changed');assert.deepEqual(derived(f.s),before);
});

test('qualified repair attempts no UPDATE or DELETE of independently proved serving rows',t=>{
  const f=legacyFixture(t),plan=repairLegacyMessages(f.s,f.request),before=authority(f.s);
  for(const table of ['rooms','messages','work_entities','integrity_room_state'])for(const action of ['UPDATE','DELETE'])
    f.s.db.exec(`CREATE TRIGGER forbid_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'serving authority must remain untouched'); END`);
  assert.equal(execute(f,plan).derivedOnly,true);assert.deepEqual(authority(f.s),before);
});

test('a malformed source anchor refuses rather than silently resetting the cursor',t=>{
  const f=legacyFixture(t);f.s.db.prepare("UPDATE messages_backfill_cursor SET replay_event_id='not-the-source-event' WHERE room_id=?").run('legacy-room');
  const before=derived(f.s);assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_not_exact_legacy');assert.deepEqual(derived(f.s),before);
});

for(const count of [64,65])test(`event row admission ${count===64?'accepts64':'refuses65'} before opaque hydration`,t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());const events=historicalSequence();
  while(events.length<count)events.push(event({id:'extra-'+events.length,roomId:'legacy-room',actorId:'owner',type:'message.posted',data:{messageId:'extra-'+events.length,body:'Small synthetic body'}}));
  const f=seedLegacyFixture(s,events);
  if(count===64)assert.equal(repairLegacyMessages(s,f.request).rooms[0].events,64);
  else assert.throws(()=>repairLegacyMessages(s,f.request),error=>error.code==='invalid_legacy_repair');
});

for(const damage of ['aggregate-bytes','archive','malformed-snapshot','malformed-anchor'])test(`historical repair refuses ${damage} without writes`,t=>{
  const f=legacyFixture(t),db=f.s.db;
  if(damage==='aggregate-bytes')db.prepare('UPDATE message_replay_snapshots SET state_json=? WHERE room_id=?').run(' '.repeat(256*1024),'legacy-room');
  if(damage==='archive')db.prepare("UPDATE rooms SET archived_at='2026-09-02' WHERE id=?").run('legacy-room');
  if(damage==='malformed-snapshot')db.prepare("UPDATE message_replay_snapshots SET state_json='parts:2:bad' WHERE room_id=?").run('legacy-room');
  if(damage==='malformed-anchor')db.prepare("UPDATE messages_backfill_state SET json='unknown' WHERE room_id=? AND part=-1").run('legacy-room\0anchor');
  const before=derived(f.s),serving=authority(f.s);
  assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>['repair_bound_exceeded','repair_not_exact_legacy'].includes(error.code));
  assert.deepEqual(derived(f.s),before);assert.deepEqual(authority(f.s),serving);
});

test('targeted historical reconciliation leaves another room and event log byte unchanged',t=>{
  const f=legacyFixture(t);f.s.initialize(initialRoom('other-room','other-owner'));
  const rows=()=>({room:f.s.db.prepare("SELECT * FROM rooms WHERE id='other-room'").get(),events:f.s.db.prepare('SELECT * FROM events ORDER BY room_id,sequence').all(),proofs:f.s.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='other-room'").all(),cursor:f.s.db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='other-room'").all()});
  const before=rows(),plan=repairLegacyMessages(f.s,f.request);execute(f,plan);assert.deepEqual(rows(),before);
});

test('admitted input plus proposed output must fit the same byte unit before any artifact write',t=>{
  const f=legacyFixture(t),first=repairLegacyMessages(f.s,f.request),padding=256*1024-first.admission.inputBytes-1;
  assert.ok(padding>0);
  f.s.db.prepare("UPDATE message_replay_snapshots SET state_json=state_json||? WHERE room_id='legacy-room'").run(' '.repeat(padding));
  const before=derived(f.s),db=f.s.db,prepare=db.prepare.bind(db);let payloadRead=false,written=false;
  db.prepare=sql=>{if(sql.startsWith('SELECT id,sequence,projection,archived_at FROM rooms'))payloadRead=true;if(/^(INSERT|UPDATE|DELETE)/.test(sql))written=true;return prepare(sql);};
  assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_bound_exceeded');
  assert.equal(payloadRead,true,'input is within admission; proposed output causes refusal');assert.equal(written,false);assert.deepEqual(derived(f.s),before);
});

test('a missing referenced message refuses before hydration or any proof repair',t=>{
  const f=legacyFixture(t);f.s.transaction(()=>{const state=structuredClone(f.s.room('legacy-room').state);state.messages=state.messages.map(message=>({id:message.id,_entity:1}));f.s.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state),'legacy-room');f.s.rememberReconstructedRoomProof('legacy-room');});
  f.s.db.prepare('DELETE FROM messages WHERE room_id=?').run('legacy-room');
  const before=derived(f.s);assert.throws(()=>repairLegacyMessages(f.s,f.request),error=>error.code==='repair_projection_unavailable');assert.deepEqual(derived(f.s),before);assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id='legacy-room'").get().n,0);
});
