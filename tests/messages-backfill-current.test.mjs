import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {auditRecovery} from '../server/recovery.mjs';

function mixed(t){
 const s=new RoomStore(':memory:');t.after(()=>s.close());
 s.initialize(initialRoom('legacy'),{representation:null});
 s.initialize(initialRoom('native'),{representation:'normalized-current-v1'});
 for(const id of ['legacy','native']){
  const key=s.issueAccessKey(id,'owner');
  s.command(key,id,{id:'post-'+id,type:'message.posted',data:{messageId:'saved-'+id,body:'Saved '+id}});
 }
 return s;
}
function nativeRows(s){
 const result={};
 for(const table of ['messages','current_room_head','current_room_records','current_room_record_proofs','events','commands','messages_backfill_cursor'])
  result[table]=s.db.prepare(`SELECT * FROM ${table} WHERE room_id=? ORDER BY rowid`).all('native');
 return result;
}
test('legacy replay and parity finish in a mixed store without rewriting native message authority',t=>{
 const s=mixed(t),before=nativeRows(s);
 let result;
 for(let n=0;n<10;n++){result=s.backfillMessages({limit:100});if(result.done)break;}
 assert.equal(result.done,true);assert.equal(result.failed.length,0);
 const parity=s.checkMessagesParity();assert.equal(parity.ok,true);assert.equal(parity.roomId,'legacy');
 assert.equal(s.db.prepare('SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get('legacy').parity_at_seq,s.headSequence('legacy'));
 assert.deepEqual(nativeRows(s),before);
 assert.throws(()=>s.checkMessagesParity({roomId:'native'}),e=>e.status===409&&/independent current-record integrity audit/.test(e.message));
 assert.deepEqual(nativeRows(s),before);
 assert.throws(()=>s.db.prepare("UPDATE messages SET body='old writer' WHERE room_id='native'").run(),/unsupported current room writer/);
 assert.doesNotThrow(()=>auditRecovery(s));
});
test('legacy replay refuses a closed current marker without its independent head',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom('broken'),{representation:null});
 // Explicit synthetic corruption: a legacy room cannot legitimately publish a
 // current carrier without its protected head. It must not be replayed away.
 s.transaction(()=>s.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run('{"normalizedCurrent":{"version":1,"headRevision":0,"headHash":"missing"}}','broken'));
 const before=s.db.prepare('SELECT projection FROM rooms WHERE id=?').get('broken').projection;
 assert.throws(()=>s.backfillMessages({limit:100}),/closed current marker lacks its independent head/);
 assert.equal(s.db.prepare('SELECT projection FROM rooms WHERE id=?').get('broken').projection,before);
});
test('legacy selection does not certify excluded current heads; independent audit still rejects corruption',t=>{
 const s=mixed(t);
 s.db.exec('DROP TRIGGER current_room_guard_current_room_head_update');
 s.transaction(()=>s.db.prepare("UPDATE current_room_head SET head_sha256='forged' WHERE room_id='native'").run());
 assert.equal(s.backfillMessages({limit:100}).done,true);
 assert.throws(()=>s.checkMessagesParity({roomId:'native'}),/owned serving schema changed|head commitment changed/);
 assert.throws(()=>auditRecovery(s),/schema|head|guard|commitment/i);
});
test('many native rooms do not hydrate native metadata during legacy candidate selection',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());
 for(let i=0;i<40;i++)s.initialize(initialRoom('a-native-'+String(i).padStart(2,'0')),{representation:'normalized-current-v1'});
 s.initialize(initialRoom('z-legacy'),{representation:null});
 const prepare=s.db.prepare.bind(s.db);let nativeHeadReads=0,nativeRecordReads=0,selectedCandidates=0;
 s.db.prepare=sql=>{
  const statement=prepare(sql);
  if(/FROM current_room_head WHERE room_id=/.test(sql)){
   const get=statement.get.bind(statement);statement.get=(...args)=>{if(String(args[0]).startsWith('a-native-'))nativeHeadReads++;return get(...args);};
  }
  if(/FROM current_room_records WHERE/.test(sql))nativeRecordReads++;
  if(sql.includes('SELECT r.id AS id, r.sequence AS sequence')){
   const get=statement.get.bind(statement);statement.get=(...args)=>{const row=get(...args);if(row)selectedCandidates++;return row;};
  }
  return statement;
 };
 try{
  assert.equal(s.backfillMessages({limit:100}).done,true);
  assert.equal(s.checkMessagesParity().roomId,'z-legacy');
 }finally{s.db.prepare=prepare;}
 assert.equal(nativeHeadReads,0);assert.equal(nativeRecordReads,0);assert.equal(selectedCandidates,1);
 assert.equal(s.db.prepare("SELECT count(*) AS n FROM messages_backfill_cursor WHERE room_id LIKE 'a-native-%'").get().n,0);
 // Anti-join selection may examine room IDs in SQLite; this proves bounded
 // returned payload/JS work, not constant physical SQL cost for all room counts.
});
