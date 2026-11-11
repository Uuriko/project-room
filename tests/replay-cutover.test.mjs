import {STORE_SCHEMA_VERSION} from '../server/writer-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomStore} from '../server/store.mjs';
import {applyEvent,event} from '../src/events.js';
import {initialRoom} from '../server/bootstrap.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,REPLAY_CAPTURE_BYTES} from '../server/replay-cutover.mjs';
function fixture(t,bytes=0){
  const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom());
  if(bytes){const state=structuredClone(s.room('commons').state);state.room.syntheticPadding='';state.room.syntheticPadding='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(state)));s.transaction(()=>s.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(s.storedProjection('commons',state)));}
  s.db.exec(replayCutoverSchema());
  const input={roomId:'commons',requestId:'capture-1',expectedHead:s.headSequence('commons'),reason:'Synthetic bounded capture'};
  return{s,input,capture:()=>captureReplayWitness(s,input),step:(generation,expectedBytes,n)=>advanceReplayWitness(s,{roomId:'commons',generation,expectedBytes,requestId:'step-'+n})};
}
function authority(db){return Object.fromEntries(['rooms','events','messages','integrity_room_state','projection_bodies','work_entities','messages_backfill_cursor','messages_backfill_state','message_replay_snapshots'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));}

test('explicit capture leaves serving, journal and legacy checkpoint bytes unchanged',t=>{
  const f=fixture(t),db=f.s.db;
  db.prepare('INSERT OR REPLACE INTO messages_backfill_state VALUES(?,?,?)').run('commons',0,'Unchanged legacy checkpoint');
  const before=authority(db),result=f.capture();assert.equal(result.certified,false);assert.deepEqual(authority(db),before);
  assert.equal(db.prepare("SELECT json FROM messages_backfill_state WHERE room_id='commons' AND part=0").get().json,'Unchanged legacy checkpoint');
  const duplicate=f.capture();assert.equal(duplicate.duplicate,true);assert.deepEqual({...duplicate,duplicate:false},result);
  assert.throws(()=>captureReplayWitness(f.s,{...f.input,reason:'Changed intent'}),/idempotency conflict/);
});

test('Muse-sized capture advances with bounded payloads while later posts and edits preserve H',t=>{
  const f=fixture(t,2376000),start=f.capture(),key=f.s.issueAccessKey('commons','owner');
  let result={bytes:0},steps=0,maxPayload=0,measuring=false;const db=f.s.db,prepare=db.prepare.bind(db);
  db.prepare=sql=>{const statement=prepare(sql);return new Proxy(statement,{get(target,k){const value=Reflect.get(target,k,target);if(k==='get')return(...args)=>{const row=value.apply(target,args);for(const x of Object.values(row??{}))if(measuring&&(typeof x==='string'||x instanceof Uint8Array))maxPayload=Math.max(maxPayload,typeof x==='string'?Buffer.byteLength(x):x.byteLength);return row;};return typeof value==='function'?value.bind(target):value;}});};
  while(result.phase!=='witness_verified'){
    measuring=true;result=f.step(start.generation,result.bytes,steps++);measuring=false;
    if(steps<=3)f.s.command(key,'commons',{id:'later-'+steps,type:'message.posted',data:{messageId:'later-'+steps,body:'A later independently proved post'}});
    if(steps===4)f.s.command(key,'commons',{id:'later-edit',type:'message.edited',data:{messageId:'later-1',body:'Edited after capture',expectedMessageRevision:0}});
  }
  assert.equal(result.bytes,2376000);assert.equal(result.head,start.head);assert.ok(f.s.headSequence('commons')>start.head);
  assert.ok(maxPayload<=16384,'no growing live projection crosses into the hash continuation');
  assert.equal(result.certified,false);assert.equal(result.publication,'pending');
  const original=f.step(start.generation,0,0);assert.equal(original.duplicate,true);assert.equal(original.bytes,16384);
  const done=f.step(start.generation,result.bytes,'done');assert.equal(done.phase,'witness_verified');
});

for(const mutation of ['older-body','older-sequence','delete','prefix-insert'])test(`current migration fence refuses ${mutation} before source mutation`,t=>{
  const f=fixture(t),start=f.capture(),db=f.s.db;
  const before=authority(db),mutate=()=>{
  if(mutation==='older-body')db.prepare("UPDATE events SET body=json_set(body,'$.data.name','Changed old source') WHERE room_id='commons' AND sequence=1").run();
  if(mutation==='older-sequence')db.prepare("UPDATE events SET sequence=sequence+100 WHERE room_id='commons' AND sequence=1").run();
  if(mutation==='delete')db.prepare("DELETE FROM events WHERE room_id='commons' AND sequence=1").run();
  if(mutation==='prefix-insert')db.prepare("INSERT INTO events(room_id,sequence,id,body) SELECT room_id,0,'prefix',body FROM events WHERE room_id='commons' LIMIT 1").run();
  };
  assert.throws(mutate,/unsupported current room writer|immutable/);
  assert.deepEqual(authority(db),before,'unregistered source mutation must not commit');
  assert.equal(f.step(start.generation,0,0).phase,'witness_verified');
  assert.equal(db.prepare("SELECT row_version FROM message_replay_units WHERE domain='control' AND unit_key='epoch'").get().row_version,0);
});

test('source and capture output faults roll back the whole step and audit receipt',t=>{
  const f=fixture(t),db=f.s.db,before=authority(db);
  db.exec("CREATE TRIGGER fail_replay_receipt BEFORE INSERT ON operator_actions WHEN NEW.action LIKE 'replay_cutover_%' BEGIN SELECT RAISE(ABORT,'synthetic audit fault'); END");
  assert.throws(f.capture,/synthetic audit fault/);assert.deepEqual(authority(db),before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM message_replay_units').get().n,0);
});

test('changed, oversized and malformed source controls refuse before witness copy',t=>{
  const f=fixture(t),db=f.s.db;
  assert.throws(()=>captureReplayWitness(f.s,{...f.input,expectedHead:f.input.expectedHead+1}),/head changed/);
  assert.throws(()=>captureReplayWitness(f.s,{...f.input,ceilingBytes:1}),/byte limit/);
  assert.throws(()=>captureReplayWitness(f.s,{...f.input,ceilingBytes:REPLAY_CAPTURE_BYTES+1}),/invalid/);
  db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run('x'.repeat(2*1024*1024));
  assert.throws(f.capture,/head changed/);assert.equal(db.prepare('SELECT count(*) AS n FROM message_replay_units').get().n,0);
});

test('corrupt copied bytes cannot certify against an unchanged independent old proof',t=>{
  const f=fixture(t),db=f.s.db;db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.name','Changed unproved bytes') WHERE id='commons'").run();
  const start=f.capture();assert.throws(()=>f.step(start.generation,0,0),/independent replay witness mismatch/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='replay_cutover_hash'").get().n,0);
});

for(const damage of ['header-self-hash','checkpoint-self-hash','epoch-type','capture-head','missing-trigger'])test(`independent control binding refuses ${damage}`,t=>{
  const f=fixture(t),start=f.capture(),db=f.s.db;
  if(damage==='missing-trigger')db.exec('DROP TRIGGER replay_source_update');
  else if(damage==='epoch-type')db.prepare("UPDATE message_replay_units SET row_version=? WHERE domain='control' AND unit_key='epoch'").run('x'.repeat(2*1024*1024));
  else if(damage==='capture-head')db.prepare("UPDATE message_replay_units SET row_version=0 WHERE domain='control' AND unit_key='capture-head'").run();
  else {
    const domain=damage==='header-self-hash'?'header':'hash';
    const row=db.prepare('SELECT payload FROM message_replay_units WHERE generation=? AND domain=?').get(start.generation,domain),value=JSON.parse(Buffer.from(row.payload).toString('utf8'));
    if(domain==='header')value.ceiling=1;
    else {const state=JSON.parse(value.state);state.words[0]^=1;value.state=JSON.stringify(state);}
    const payload=Buffer.from(JSON.stringify(value));
    db.prepare('UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE generation=? AND domain=?')
      .run(payload,payload.length,createHash('sha256').update(payload).digest('hex'),start.generation,domain);
  }
  assert.throws(()=>f.step(start.generation,0,0),/independent|epoch|control|schema/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='replay_cutover_hash'").get().n,0);
});

test('one active generation refuses a second capture rather than copying the blob again',t=>{
  const f=fixture(t);f.capture();
  assert.throws(()=>captureReplayWitness(f.s,{...f.input,requestId:'a-different-capture'}),/requires continuation/);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM message_replay_units WHERE domain='witness'").get().n,1);
});

test('ordinary append source guard uses a single primary-key control lookup despite 17,405 derived leaves',t=>{
  const f=fixture(t),start=f.capture(),db=f.s.db;
  const insert=db.prepare("INSERT INTO message_replay_units VALUES(?,?,'message',?,1,2,?,?)");
  f.s.transaction(()=>{for(let i=0;i<17405;i++)insert.run('commons',start.generation,'message-'+i,createHash('sha256').update('{}').digest('hex'),Buffer.from('{}'));});
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM message_replay_units WHERE room_id=? AND generation='' AND domain='control' AND unit_key='capture-head'").all('commons');
  assert.ok(plan.every(row=>!row.detail.includes('SCAN')));assert.ok(plan.some(row=>row.detail.includes('SEARCH')));
  const key=f.s.issueAccessKey('commons','owner');f.s.command(key,'commons',{id:'append-amid-leaves',type:'message.posted',data:{messageId:'new-message',body:'A bounded guard lookup'}});
  assert.equal(db.prepare("SELECT row_version FROM message_replay_units WHERE domain='control' AND unit_key='epoch'").get().row_version,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_replay_units WHERE domain='message'").get().n,17405);
});

test('current registered schema writer preserves H and prospectively binds its legacy append',t=>{
  const directory=mkdtempSync(join(tmpdir(),'replay-old44-')),path=join(directory,'room.sqlite');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let s=new RoomStore(path);s.initialize(initialRoom());s.db.exec(replayCutoverSchema());
  const input={roomId:'commons',requestId:'old44-capture',expectedHead:s.headSequence('commons'),reason:'Synthetic compatibility'};
  const captured=captureReplayWitness(s,input),before=s.db.prepare('SELECT * FROM message_replay_units ORDER BY generation,domain,unit_key').all();s.close();
  s=new RoomStore(path);try{
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,STORE_SCHEMA_VERSION);
    const key=s.issueAccessKey('commons','owner');s.command(key,'commons',{id:'old44-post',type:'message.posted',data:{messageId:'old44-post',body:'A valid current-schema post'}});
    for(const row of before)assert.deepEqual(s.db.prepare('SELECT * FROM message_replay_units WHERE room_id=? AND generation=? AND domain=? AND unit_key=?').get(row.room_id,row.generation,row.domain,row.unit_key),row);
    assert.equal(s.db.prepare("SELECT count(*) n FROM message_replay_units WHERE domain='tail-event'").get().n,1);
    assert.equal(advanceReplayWitness(s,{roomId:'commons',generation:captured.generation,expectedBytes:0,requestId:'old44-hash'}).phase,'witness_verified');
  }finally{s.close();}
});

function hashToEnd(f,start){let result={bytes:0};for(let n=0;result.phase!=='witness_verified'&&n<300;n++)result=f.step(start.generation,result.bytes,'hash-full-'+n);assert.equal(result.phase,'witness_verified');return result;}
function codecStep(f,start,offset,n){return partitionReplayWitness(f.s,{roomId:'commons',generation:start.generation,expectedBytes:offset,requestId:'codec-'+n});}

test('durable shared-codec partition requires the independent hash and keeps source cursor bytes untouched',t=>{
  const f=fixture(t),start=f.capture(),before=authority(f.s.db);
  assert.throws(()=>codecStep(f,start,0,0),/verified witness/);hashToEnd(f,start);
  const result=codecStep(f,start,0,0);assert.equal(result.phase,'codec_partitioned');assert.equal(result.certified,false);assert.deepEqual(authority(f.s.db),before);
  assert.equal(codecStep(f,start,0,0).duplicate,true);
  assert.throws(()=>codecStep(f,start,1,'changed'),/cursor changed/);
});

test('Muse-sized message array partitions into point-addressable leaves with bounded steps',t=>{
  const f=fixture(t),s=f.s,db=s.db;
  const base=structuredClone(s.room('commons').state),sample=applyEvent(base,event({id:'template',roomId:'commons',actorId:'owner',type:'message.posted',at:'2026-01-01T00:00:00.000Z',data:{messageId:'template',body:'Synthetic Muse-sized body'}})).messages[0];
  base.messages=Array.from({length:17405},(_,i)=>({...sample,id:'m'+i}));
  s.transaction(()=>db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(s.storedProjection('commons',base)));
  const bytes=db.prepare("SELECT octet_length(projection) AS n FROM rooms WHERE id='commons'").get().n;assert.ok(bytes>2376000&&bytes<4194304);
  const start=f.capture();hashToEnd(f,start);let state={bytes:0},steps=0,maxRecords=0;
  while(state.phase!=='codec_partitioned'&&steps<1000){state=codecStep(f,start,state.bytes,'large-'+steps++);maxRecords=Math.max(maxRecords,state.records);}
  assert.equal(state.phase,'codec_partitioned');assert.equal(state.messages,17405);assert.ok(steps>500);assert.ok(maxRecords<=32);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_replay_units WHERE domain='message'").get().n,17405);
  const leaf=db.prepare("SELECT payload FROM message_replay_units WHERE room_id='commons' AND generation=? AND domain='message' AND unit_key='m17404'").get(start.generation);
  assert.equal(JSON.parse(Buffer.from(leaf.payload).toString()).id,'m17404');assert.equal(state.certified,false);
});

test('codec state tamper plus recomputed local checksum refuses against its old phase receipt',t=>{
  const f=fixture(t),start=f.capture();hashToEnd(f,start);const db=f.s.db;
  const row=db.prepare("SELECT payload FROM message_replay_units WHERE domain='codec'").get(),value=JSON.parse(Buffer.from(row.payload).toString());
  const state=JSON.parse(value.state);state.phase='done';value.state=JSON.stringify(state);const payload=Buffer.from(JSON.stringify(value));
  db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='codec'").run(payload,payload.length,createHash('sha256').update(payload).digest('hex'));
  assert.throws(()=>codecStep(f,start,0,0),/independent replay codec binding/);
});
