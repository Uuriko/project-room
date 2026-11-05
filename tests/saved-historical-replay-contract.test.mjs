import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { event } from '../src/events.js';
import { appendHistoricalReplayLookup } from '../server/historical-replay-contract.mjs';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';
import { historicalSequence, seedLegacyFixture } from './helpers/legacy-session-fixture.mjs';

function repaired(t, append = false, reverseTarget = false) {
  const dir=mkdtempSync(join(tmpdir(),'saved-historical-contract-')),file=join(dir,'room.sqlite');
  let store=new RoomStore(file);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const events=historicalSequence(),intro=[0,1].map(i=>event({id:'intro-'+i,roomId:'legacy-room',actorId:'owner',at:'2026-09-01T00:00:10.000Z',type:'message.posted',data:{messageId:'intro-'+i,body:'Synthetic ordinary message'}}));
  const f=seedLegacyFixture(store,[...events.slice(0,2),...intro,...events.slice(2)]);
  assert.equal(store.db.prepare("SELECT sequence FROM messages_backfill_blocks WHERE room_id='legacy-room'").get().sequence,9);
  if(reverseTarget) f.request.rooms=[{expectedHead:11,roomId:'legacy-room'}];
  const plan=repairLegacyMessages(store,f.request),input={...f.request,planHash:plan.planHash,requestId:'saved-contract-reopen'},receipt=repairLegacyMessages(store,input,true);
  assert.equal(receipt.verified,1);assert.equal(receipt.replayContract.throughSequence,11);
  assert.equal(store.db.prepare("SELECT 1 FROM messages_backfill_blocks WHERE room_id='legacy-room'").get(),undefined);
  const savedReceipt=store.db.prepare("SELECT counts_json FROM operator_actions WHERE action='legacy_session_backfill_reconciled'").get().counts_json;
  store.transaction(()=>{
    store.db.prepare('DELETE FROM message_replay_snapshots WHERE room_id=?').run('legacy-room');
    store.db.prepare('DELETE FROM messages_backfill_state WHERE room_id IN (?,?)').run('legacy-room','legacy-room\0anchor');
    store.db.prepare('DELETE FROM projection_checkpoints WHERE room_id=?').run('legacy-room');
  });
  if(append){const key=store.issueAccessKey('legacy-room','owner');store.command(key,'legacy-room',{id:'after-contract',type:'message.posted',data:{messageId:'after-contract',body:'Synthetic modern suffix'}});}
  const expected=structuredClone(store.room('legacy-room').state);
  store.close();store=new RoomStore(file);
  assert.equal(store.db.prepare("SELECT counts_json FROM operator_actions WHERE action='legacy_session_backfill_reconciled'").get().counts_json,savedReceipt);
  return {store,expected,receipt,input};
}
test('ordinary projection replay consumes the saved successful exact-prefix contract after checkpoint loss and reopen',t=>{
  const {store,expected}=repaired(t);
  assert.deepEqual(store.rebuildProjection('legacy-room').state,expected);
});
test('ordinary message catch-up consumes saved contract then applies a modern suffix after checkpoint loss and reopen',t=>{
  const {store,expected}=repaired(t,true);
  const result=store.backfillMessages({limit:64});
  assert.deepEqual(result.quarantined,[]);
  assert.equal(store.db.prepare("SELECT 1 FROM messages_backfill_blocks WHERE room_id='legacy-room'").get(),undefined);
  assert.equal(store.checkMessagesParity({roomId:'legacy-room'}).ok,true);
  assert.deepEqual(store.room('legacy-room').state,expected);
});

const authority = store => Object.fromEntries(['rooms','messages','work_entities','integrity_room_state'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table}`).all()]));
const derived = store => Object.fromEntries(['messages_backfill_cursor','message_replay_snapshots','messages_backfill_blocks','operator_actions'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table}`).all()]));
// Deliberate on-disk corruption fixture only: bypass append-only triggers to
// prove reader refusal. Product code retains both triggers and never updates.
function tamper(store) {store.db.exec('DROP TRIGGER operator_actions_append_only_update; DROP TRIGGER operator_actions_append_only_delete;');}
function lookup(store) {return store.db.prepare("SELECT * FROM operator_actions WHERE action='legacy_session_replay_lookup'").get();}
function mutateReceipt(store, mutate) {
  const row=store.db.prepare("SELECT * FROM operator_actions WHERE action='legacy_session_backfill_reconciled'").get();
  const saved=JSON.parse(row.counts_json);mutate(saved);
  store.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(JSON.stringify(saved),row.id);
}
function observePrefix(store) {
  const original=store.db.prepare.bind(store.db);let reads=0;
  store.db.prepare=sql=>{if(sql.includes('SELECT sequence,CAST(id AS BLOB)'))reads++;return original(sql);};
  return {reads:()=>reads,restore:()=>{store.db.prepare=original;}};
}
test('saved prefix recovery charges the event budget before payload and preserves serving/proof bytes and receipt retry',t=>{
  const {store,input,receipt}=repaired(t,true),before=authority(store),beforeDerived=derived(store),counter=observePrefix(store);
  const small=store.backfillMessages({limit:1});
  assert.equal(small.events,0);assert.equal(small.budgetExceeded,true);assert.equal(counter.reads(),0);
  assert.deepEqual(derived(store),beforeDerived);
  const result=store.backfillMessages({limit:11});assert.equal(result.events,11);assert.equal(counter.reads(),1);
  assert.deepEqual(authority(store),before);assert.equal(store.db.prepare('SELECT state_seq FROM messages_backfill_cursor WHERE room_id=?').get('legacy-room').state_seq,11);
  store.backfillMessages({limit:1});assert.deepEqual(authority(store),before);
  assert.deepEqual(repairLegacyMessages(store,input,true),{...receipt,duplicate:true});counter.restore();
});
test('consumer preserves original input target-key order fingerprint and applies modern edit strictly after prefix',t=>{
  const {store,input,receipt}=repaired(t,true,true),key=store.issueAccessKey('legacy-room','owner');
  store.command(key,'legacy-room',{id:'modern-edit',type:'message.edited',data:{messageId:'after-contract',body:'Synthetic modern edited suffix',expectedMessageRevision:0}});
  const before=authority(store),expected=store.room('legacy-room').state;
  assert.deepEqual(store.rebuildProjection('legacy-room').state,expected);
  assert.deepEqual(store.backfillMessages({limit:64}).quarantined,[]);
  assert.deepEqual(authority(store),before);assert.deepEqual(repairLegacyMessages(store,input,true),{...receipt,duplicate:true});
});
for(const [name,change] of [
  ['lookup contract hash',s=>{const row=lookup(s),v=JSON.parse(row.counts_json);v.contractSha256='0'.repeat(64);s.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(JSON.stringify(v),row.id);}],
  ['missing original receipt',s=>s.db.prepare("DELETE FROM operator_actions WHERE action='legacy_session_backfill_reconciled'").run()],
  ['wrong original fingerprint',s=>mutateReceipt(s,v=>{v.requestFingerprint='0'.repeat(64);})],
  ['wrong successful receipt shape',s=>mutateReceipt(s,v=>{v.unexpected=true;})],
  ['wrong adapter version',s=>mutateReceipt(s,v=>{v.replayContract.adapterVersion=2;})],
  ['conflicting lookup head',s=>{const row=lookup(s),v=JSON.parse(row.counts_json);v.throughSequence=10;s.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(JSON.stringify(v),row.id);}],
  ['ambiguous lookup JSON',s=>{const row=lookup(s);s.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(row.counts_json.replace('{','{"version":1,'),row.id);}],
  ['changed prefix body',s=>s.db.prepare("UPDATE events SET body=json_set(body,'$.data.note','mutated') WHERE sequence=3").run()],
  ['changed prefix event ID',s=>s.db.prepare("UPDATE events SET id='mutated-prefix-id' WHERE sequence=3").run()]
]) test('saved contract refuses '+name+' without serving, staging, quarantine or receipt changes',t=>{
  const {store}=repaired(t,true);tamper(store);change(store);const before=authority(store),progress=derived(store);
  assert.throws(()=>store.rebuildProjection('legacy-room'),e=>e.code==='projection_corrupt');
  assert.throws(()=>store.backfillMessages({limit:64}),e=>e.code==='projection_corrupt');
  assert.deepEqual(authority(store),before);assert.deepEqual(derived(store),progress);
});
for(const [name,change] of [
  ['oversized lookup',s=>{const row=lookup(s);s.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(' '.repeat(513),row.id);}],
  ['oversized original reason',s=>s.db.prepare("UPDATE operator_actions SET reason=? WHERE action='legacy_session_backfill_reconciled'").run('x'.repeat(281))],
  ['oversized prefix',s=>s.db.prepare('UPDATE events SET body=? WHERE sequence=3').run(JSON.stringify({note:'x'.repeat(256*1024)}))]
]) test(name+' fails scalar admission before prefix payload transfer',t=>{
  const {store}=repaired(t,true);tamper(store);change(store);const counter=observePrefix(store),before=derived(store);
  assert.throws(()=>store.backfillMessages({limit:64}),e=>e.code==='projection_corrupt');
  assert.equal(counter.reads(),0);assert.deepEqual(derived(store),before);counter.restore();
});
test('missing lookup preserves strict default rather than discovering unrelated historical receipts',t=>{
  const {store}=repaired(t,true);tamper(store);store.db.prepare("DELETE FROM operator_actions WHERE action='legacy_session_replay_lookup'").run();
  assert.throws(()=>store.rebuildProjection('legacy-room'),/Invalid transition/);
  assert.equal(store.backfillMessages({limit:64}).quarantined[0].sequence,9);
});

test('proved historical adapter never extends to an unproved modern suffix',t=>{
  const {store}=repaired(t,true),incoming=historicalSequence().find(e=>e.type==='work.accepted');
  store.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('legacy-room',13,'invalid-modern-accept',JSON.stringify({...incoming,id:'invalid-modern-accept'}));
  store.db.prepare('UPDATE rooms SET sequence=13 WHERE id=?').run('legacy-room');
  assert.throws(()=>store.rebuildProjection('legacy-room'),/Invalid transition from working/);
});
test('lookup insert fault rolls back original success receipt, derived repair and proofs atomically',t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());const f=seedLegacyFixture(store);
  const plan=repairLegacyMessages(store,f.request),before=authority(store),progress=derived(store);
  store.db.exec("CREATE TRIGGER fail_lookup BEFORE INSERT ON operator_actions WHEN NEW.action='legacy_session_replay_lookup' BEGIN SELECT RAISE(ABORT,'synthetic lookup write fault'); END");
  assert.throws(()=>repairLegacyMessages(store,{...f.request,planHash:plan.planHash,requestId:'lookup-atomic'},true),/synthetic lookup write fault/);
  assert.deepEqual(authority(store),before);assert.deepEqual(derived(store),progress);
  store.db.exec('DROP TRIGGER fail_lookup');
  const receipt=repairLegacyMessages(store,{...f.request,planHash:plan.planHash,requestId:'lookup-atomic'},true);
  assert.equal(receipt.verified,1);assert.ok(lookup(store));
});

test('exact same-head lookup reuse is append-only and projection recovery itself is read-only',t=>{
  const {store,receipt}=repaired(t),row=lookup(store),id=JSON.parse(row.counts_json).receiptId;
  const before=authority(store),progress=derived(store);
  store.transaction(()=>appendHistoricalReplayLookup(store.db,'legacy-room',11,id,receipt.replayContract,store.now()));
  assert.deepEqual(derived(store),progress);
  store.rebuildProjection('legacy-room');assert.deepEqual(authority(store),before);assert.deepEqual(derived(store),progress);
});

for(const receiptId of [null,{},'malformed']) test('malformed lower-head receipt ID refuses despite a valid higher lookup: '+JSON.stringify(receiptId),t=>{
  const {store}=repaired(t,true),row=lookup(store),value={...JSON.parse(row.counts_json),throughSequence:10,receiptId};
  store.db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(row.id.replace(/_11$/,'_10'),row.at,row.action,row.target_kind,row.target_id,row.reason,null,JSON.stringify(value),'verified',null);
  const before=authority(store),progress=derived(store);
  assert.throws(()=>store.rebuildProjection('legacy-room'),e=>e.code==='projection_corrupt');
  assert.throws(()=>store.backfillMessages({limit:64}),e=>e.code==='projection_corrupt');
  assert.deepEqual(authority(store),before);assert.deepEqual(derived(store),progress);
});
