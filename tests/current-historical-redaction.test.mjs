import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {replayNdjsonInto} from '../server/restore-ndjson.mjs';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';
import {seedHistoricalRedactionSource} from './helpers/historical-redaction-source.mjs';
const relevant=['rooms','events','commands','messages','work_entities','current_room_head','current_room_records','current_room_record_proofs','operator_actions'];
const snapshot=s=>Object.fromEntries(relevant.map(table=>[table,s.db.prepare('SELECT * FROM '+table).all()]));
const originals=s=>s.db.prepare("SELECT id,counts_json FROM operator_actions WHERE action IN ('legacy_session_backfill_reconciled','legacy_session_replay_lookup') ORDER BY id").all();
function fixture(t){const s=new RoomStore(':memory:');t.after(()=>s.close());const f=seedHistoricalRedactionSource(s);s.room=()=>{throw Error('whole room hydration');};return{s,...f};}
function absent(s){for(const table of relevant)for(const row of s.db.prepare('SELECT * FROM '+table).all())for(const value of Object.values(row))assert.equal(String(value).includes('sensitive-prefix-'),false,'live erased payload in '+table);}
function tamper(s,operation){
 const guards=s.db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('operator_actions_append_only_update','operator_actions_append_only_delete') ORDER BY name").all();
 s.transaction(()=>withCurrentRoomWriter(s.db,'legacy-room',()=>{for(const name of ['operator_actions_append_only_update','operator_actions_append_only_delete'])s.db.exec('DROP TRIGGER '+name);try{operation();}finally{for(const {sql} of guards)s.db.exec(sql);}}));
}
function changeProof(s,action,change){tamper(s,()=>{const row=s.db.prepare('SELECT id,counts_json FROM operator_actions WHERE action=?').get(action),value=JSON.parse(row.counts_json);change(value);s.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(JSON.stringify(value),row.id);});}

test('real repaired H source permits multiple prefix erasures, exact original receipts and full export/restore oracle',t=>{
 const f=fixture(t),{s}=f;
 for(const id of ['prefix-one','prefix-two','prefix-private'])f.erase(id);
 assert.equal(s.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='historical_replay_privacy_basis'").get().n,1);
 assert.equal(s.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='historical_replay_erased'").get().n,3);
 for(const row of s.db.prepare("SELECT counts_json FROM operator_actions WHERE action='historical_replay_erased'").all()){const erasure=JSON.parse(row.counts_json),opened=JSON.parse(s.db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(erasure.admission[0]).counts_json);assert.equal(opened.format,'normalized-current-v1-native-work-6','real current format admission is independently verified');}
 assert.deepEqual(originals(s),f.original);absent(s);assert.doesNotThrow(()=>auditRecovery(s));
 const before=snapshot(s);assert.equal(f.erase('prefix-one').duplicate,true);assert.deepEqual(snapshot(s),before);
 const target=new RoomStore(':memory:');t.after(()=>target.close());replayNdjsonInto(exportNdjsonText(s.db),target);target.room=()=>{throw Error('whole room hydration');};
 assert.deepEqual(originals(target),f.original);assert.doesNotThrow(()=>auditRecovery(target));absent(target);
 const retry=target.command(f.key,'legacy-room',{id:'erase-prefix-one',type:'message.deleted',data:{messageId:'prefix-one',expectedMessageRevision:1,reason:'Authorized removal'}});assert.equal(retry.duplicate,true);assert.deepEqual(snapshot(target),before);
});
for(const stage of ['source','basis','receipt'])test('privacy '+stage+' save fault rolls back original events, canonical proofs and immutable ledgers',t=>{
 const {s,erase,original}=fixture(t),before=snapshot(s),prepare=s.db.prepare.bind(s.db);let reached=false;
 s.db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=(...args)=>{const value=run(...args);if(stage==='source'&&sql==='UPDATE events SET body=? WHERE room_id=? AND sequence=?'||stage==='basis'&&args[2]==='historical_replay_privacy_basis'||stage==='receipt'&&args[2]==='historical_replay_erased'){reached=true;throw Error('historical privacy save interrupted');}return value;};return statement;};
 try{assert.throws(()=>erase('prefix-one'),/historical privacy save interrupted/);}finally{s.db.prepare=prepare;}
 assert.equal(reached,true);assert.deepEqual(snapshot(s),before);assert.deepEqual(originals(s),original);assert.doesNotThrow(()=>auditRecovery(s));erase('prefix-one');assert.doesNotThrow(()=>auditRecovery(s));
});
for(const [name,mutation] of [
 ['descriptor alone',s=>tamper(s,()=>s.db.prepare("DELETE FROM operator_actions WHERE action='historical_replay_erased'").run())],
 ['missing basis',s=>tamper(s,()=>s.db.prepare("DELETE FROM operator_actions WHERE action='historical_replay_privacy_basis'").run())],
 ['unreviewed writer format99',s=>tamper(s,()=>{const erased=JSON.parse(s.db.prepare("SELECT counts_json FROM operator_actions WHERE action='historical_replay_erased'").get().counts_json),row=s.db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(erased.admission[0]),opened=JSON.parse(row.counts_json);opened.format='normalized-current-v1-native-work-99';s.db.prepare('UPDATE operator_actions SET counts_json=? WHERE id=?').run(JSON.stringify(opened),erased.admission[0]);})],
 ['wrong actor',s=>changeProof(s,'historical_replay_erased',value=>{value.actorId='worker';})],
 ['unrelated command',s=>changeProof(s,'historical_replay_erased',value=>{value.command[0]='saved-modern-result';})],
 ['edited target hash substitution',s=>changeProof(s,'historical_replay_privacy_basis',value=>{const row=value.rows.find(row=>row[4]==='prefix-one');row[3]='a'.repeat(64);})],
 ['transition substitution',s=>changeProof(s,'historical_replay_erased',value=>{value.transition[3]++;})],
 ['resurrected original text',s=>tamper(s,()=>{const row=s.db.prepare("SELECT sequence,body FROM events WHERE room_id='legacy-room' AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')='prefix-one'").get(),value=JSON.parse(row.body);value.data.body='sensitive-prefix-one-original';delete value.data.redacted;s.db.prepare('UPDATE events SET body=? WHERE room_id=? AND sequence=?').run(JSON.stringify(value),'legacy-room',row.sequence);})]
])test('cold independent recovery refuses '+name,t=>{
 const {s,erase,original}=fixture(t);erase('prefix-one');mutation(s);assert.deepEqual(originals(s),original);assert.throws(()=>auditRecovery(s),/Saved historical replay evidence|Recovery data requires operator reconciliation/);const target=new RoomStore(':memory:');t.after(()=>target.close());assert.throws(()=>replayNdjsonInto(exportNdjsonText(s.db),target),/Saved historical replay evidence|Recovery data requires operator reconciliation/);
});

test('oversized privacy proof is refused before any new source erasure',t=>{
 const {s,erase}=fixture(t);erase('prefix-one');
 changeProof(s,'historical_replay_privacy_basis',value=>{value.padding='x'.repeat(64*1024);});
 const before=snapshot(s),prepare=s.db.prepare.bind(s.db);let rewrites=0;
 s.db.prepare=sql=>{const statement=prepare(sql);if(sql==='UPDATE events SET body=? WHERE room_id=? AND sequence=?'){const run=statement.run.bind(statement);statement.run=(...args)=>{rewrites++;return run(...args);};}return statement;};
 try{assert.throws(()=>erase('prefix-two'),/Saved historical replay evidence/);}finally{s.db.prepare=prepare;}
 assert.equal(rewrites,0);assert.deepEqual(snapshot(s),before);
});

test('post-write verification exempts only its current open permit, never an earlier erasure',t=>{
 const {s,erase}=fixture(t);erase('prefix-one');const before=snapshot(s),prior=JSON.parse(s.db.prepare("SELECT counts_json FROM operator_actions WHERE action='historical_replay_erased'").get().counts_json),closed=prior.admission[0]+'_closed',guard=s.db.prepare("SELECT sql FROM sqlite_master WHERE name='operator_actions_append_only_delete'").get().sql,prepare=s.db.prepare.bind(s.db);let injected=false;
 s.db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(args[2]==='historical_replay_erased'){injected=true;s.db.exec('DROP TRIGGER operator_actions_append_only_delete');try{prepare('DELETE FROM operator_actions WHERE id=?').run(closed);}finally{s.db.exec(guard);}}return result;};return statement;};
 try{assert.throws(()=>erase('prefix-two'),/Saved historical replay evidence/);}finally{s.db.prepare=prepare;}
 assert.equal(injected,true);assert.deepEqual(snapshot(s),before);assert.doesNotThrow(()=>auditRecovery(s));
});

test('legal escaped reason bytes remain within aggregate admission and preserve command causation binding',t=>{
 const {s,key,original}=fixture(t),command={id:'escaped-prefix-erasure',causationId:s.db.prepare("SELECT id FROM events WHERE room_id='legacy-room' ORDER BY sequence LIMIT 1").get().id,type:'message.deleted',data:{messageId:'prefix-one',expectedMessageRevision:1,reason:''}};
 while(Buffer.byteLength(JSON.stringify(command))+6<=16384)command.data.reason+='\u0000';
 assert.ok(Buffer.byteLength(JSON.stringify(command))<=16384);
 s.command(key,'legacy-room',command);
 const deleted=s.db.prepare("SELECT length(CAST(body AS BLOB)) bytes FROM events WHERE room_id='legacy-room' AND json_extract(body,'$.type')='message.deleted' ORDER BY sequence DESC LIMIT 1").get();
 assert.ok(deleted.bytes>16384,'server event envelope exceeds the legal command byte cap');assert.doesNotThrow(()=>auditRecovery(s));assert.deepEqual(originals(s),original);assert.equal(s.command(key,'legacy-room',command).duplicate,true);
});

 test('aggregate privacy admission refuses legal repeated erasures before source mutation',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const {key}=seedHistoricalRedactionSource(s,{extraPrefixMessages:12});let succeeded=0,refused=false;
 for(let i=0;i<12;i++){
  const command={id:'large-erase-'+i,type:'message.deleted',data:{messageId:'prefix-extra-'+i,expectedMessageRevision:0,reason:''}};
  while(Buffer.byteLength(JSON.stringify(command))+6<=16384)command.data.reason+='\u0000';
  const before=snapshot(s);try{s.command(key,'legacy-room',command);succeeded++;}catch(error){assert.match(error.message,/Saved historical replay evidence/);assert.deepEqual(snapshot(s),before);refused=true;break;}
 }
 assert.ok(succeeded>1);assert.equal(refused,true);assert.doesNotThrow(()=>auditRecovery(s));
});
