import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event,replay} from '../src/events.js';
import {storedProjection,hydrateProjection} from '../server/projection-at-rest.mjs';
import {messageProofMatches} from '../server/write-integrity.mjs';
import {messageRowParityFields} from '../server/messages-store.mjs';
import {WITNESS_SCHEMA,WITNESS_SLICE,captureProjectionWitness,witnessChunk} from '../scripts/prototypes/replay-projection-witness.mjs';
import {initialReplayHash,advanceReplayHash,finishReplayHash,encodeReplayHash,decodeReplayHash} from '../server/replay-sha256.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(t,slim=false,archive=false){
  const events=[...initialRoom()];
  for(let i=0;i<5;i++)events.push(event({id:'post-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'m'+i,body:'Synthetic '+i+'🦉'.repeat(260)}}));
  const s=new RoomStore(':memory:',{bodiesAtRest:slim});t.after(()=>s.close());s.initialize(events);
  while(!s.backfillMessages({limit:200}).done){}s.checkMessagesParity({roomId:'commons'});
  if(archive)assert.equal(s.archiveMessages('commons',{keepNewest:1,dryRun:false}).ok,true);
  s.db.exec(WITNESS_SCHEMA);const head=s.headSequence('commons');
  const authority=()=>Object.fromEntries(['rooms','integrity_room_state','messages','projection_bodies','work_entities'].map(table=>[table,s.db.prepare(`SELECT * FROM ${table} WHERE ${table==='rooms'?'id':'room_id'}=?`).all('commons')]));
  const capture=(extra={})=>s.transaction(()=>captureProjectionWitness(s.db,{captureId:'captured-head',roomId:'commons',expectedHead:head,...extra}));
  return{s,events,head,authority,capture};
}
function read(s){const chunks=[];for(let offset=0;;offset+=WITNESS_SLICE){const chunk=witnessChunk(s.db,'captured-head',offset);if(!chunk?.length)break;assert.ok(chunk.byteLength<=WITNESS_SLICE);chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
for(const slim of [false,true])for(const archive of [false,true])test(`captured independent proof matches shared codec: bodyRefs=${slim}, archived=${archive}`,t=>{
  const f=fixture(t,slim,archive),before=f.authority();f.capture();const text=read(f.s),saved=f.s.db.prepare('SELECT metadata_hash FROM replay_projection_witness WHERE metadata_hash IS NOT NULL').get();
  assert.equal(sha(text),saved.metadata_hash);assert.deepEqual(f.authority(),before,'capture makes no serving writes');
  const hydrated=hydrateProjection(f.s.db,'commons',JSON.parse(text),{verifyBodyHashes:true});assert.equal(hydrated.missing.length,0);
  const shadow=new RoomStore(':memory:',{bodiesAtRest:slim});t.after(()=>shadow.close());shadow.initialize(f.events);
  const encoded=shadow.transaction(()=>storedProjection(shadow.db,'commons',structuredClone(hydrated.state),{enabled:slim}));
  assert.equal(encoded,text,'shared codec reproduces captured bytes and key order exactly');assert.equal(sha(encoded),saved.metadata_hash);
  if(slim&&process.env.WITNESS_RAW_HYDRATION_CONTROL==='1')assert.equal(sha(JSON.stringify(hydrated.state)),saved.metadata_hash,'raw hydrated JSON cannot stand in for the shared at-rest codec');
});

test('capture stays immutable through repeated modern appends and an edit; duplicate cannot copy the new live blob',t=>{
  const f=fixture(t),before=f.authority();f.capture();const captured=read(f.s),proof=f.s.db.prepare('SELECT metadata_hash FROM replay_projection_witness WHERE metadata_hash IS NOT NULL').get().metadata_hash;
  const key=f.s.issueAccessKey('commons','owner');
  for(let i=0;i<12;i++){f.s.command(key,'commons',{id:'append-'+i,type:'message.posted',data:{messageId:'later-'+i,body:'Later '+i}});assert.equal(f.capture().duplicate,true);assert.equal(read(f.s),captured);}
  f.s.command(key,'commons',{id:'edit-original',type:'message.edited',data:{messageId:'m0',body:'A modern edited body',expectedMessageRevision:0}});
  assert.equal(read(f.s),captured);assert.equal(sha(captured),proof);assert.notDeepEqual(f.authority(),before);
});

for(const damage of ['absent-proof','changed-head','oversize'])test(`capture admission refuses ${damage} before copying any body`,t=>{
  const f=fixture(t);if(damage==='absent-proof')f.s.db.prepare("UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id='commons'").run();
  const input=damage==='changed-head'?{expectedHead:f.head+1}:damage==='oversize'?{ceilingBytes:10}:{};
  assert.throws(()=>f.capture(input),/proof|head|ceiling/);assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM replay_projection_witness').get().n,0);
});

test('copied bytes are not trusted merely because a fresh hash exists',t=>{
  const f=fixture(t);f.s.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.name','Unproved synthetic change') WHERE id='commons'").run();f.capture();
  assert.notEqual(sha(read(f.s)),f.s.db.prepare('SELECT metadata_hash FROM replay_projection_witness WHERE metadata_hash IS NOT NULL').get().metadata_hash);
});

function archiveWitness(f){
  const source=f.s.db.prepare("SELECT sequence,body FROM events WHERE room_id='commons' ORDER BY sequence").all(),expected=replay(source.map(x=>JSON.parse(x.body))),byId=new Map(expected.messages.map(m=>[m.id,m]));
  const captured=JSON.parse(read(f.s)),marker=captured.messagesArchive,retained=new Set(marker.retainedIds??[]);
  const rows=f.s.db.prepare("SELECT * FROM messages WHERE room_id='commons' AND seq<=? ORDER BY seq").all(marker.throughSeq).filter(row=>!retained.has(row.message_id));
  assert.equal(rows.length,marker.count,'independently bound archive membership');
  for(const row of rows){assert.equal(messageProofMatches(row),true,'archive needs pre-existing independent content proof');const seq=source.find(r=>JSON.parse(r.body).data?.messageId===row.message_id)?.sequence;assert.deepEqual(messageRowParityFields(row,byId.get(row.message_id),{sequence:seq,pinned:false,threadMessages:byId}),[],'archive content and posting provenance must match replay');}
}
test('archive witness checks content and membership, not count alone',t=>{const f=fixture(t,false,true);f.capture();archiveWitness(f);});
for(const damage of ['event-content','row-content','missing-row','missing-proof'])test(`archive witness rejects ${damage}`,t=>{
  const f=fixture(t,false,true);f.capture();
  if(damage==='event-content')f.s.db.prepare("UPDATE events SET body=json_set(body,'$.data.body','Changed source') WHERE id='post-0'").run();
  if(damage==='row-content')f.s.db.prepare("UPDATE messages SET body='Changed current row' WHERE message_id='m0'").run();
  if(damage==='missing-row')f.s.db.prepare("DELETE FROM messages WHERE message_id='m0'").run();
  if(damage==='missing-proof')f.s.db.prepare("UPDATE messages SET entity_hash=NULL WHERE message_id='m0'").run();
  assert.throws(()=>archiveWitness(f));
});

test('one-time Node SQL capture admits an explicit 8 MiB existing value with UTF-8 content and preserves its old independent proof',t=>{
  const f=fixture(t),state=structuredClone(f.s.room('commons').state);state.room.syntheticPadding='';
  const target=8*1024*1024,remaining=target-Buffer.byteLength(JSON.stringify(state));
  state.room.syntheticPadding='🦉'.repeat(Math.floor(remaining/4))+'p'.repeat(remaining%4);
  f.s.transaction(()=>{const text=f.s.storedProjection('commons',state);assert.equal(Buffer.byteLength(text),target);f.s.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(text);});
  const proof=f.s.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash;
  assert.equal(f.capture().byte_length,target);assert.equal(sha(read(f.s)),proof);
});

test('changed ceiling is changed capture intent and an insert fault rolls back without serving writes',t=>{
  const f=fixture(t);f.capture();assert.throws(()=>f.capture({ceilingBytes:1024*1024}),/intent conflict/);
  const fresh=fixture(t),before=fresh.authority();fresh.s.db.exec("CREATE TRIGGER fail_capture AFTER INSERT ON replay_projection_witness BEGIN SELECT RAISE(ABORT,'synthetic capture fault'); END");
  assert.throws(()=>fresh.capture(),/synthetic capture fault/);assert.equal(fresh.s.db.prepare('SELECT count(*) AS n FROM replay_projection_witness').get().n,0);assert.deepEqual(fresh.authority(),before);
});

test('oversized SQLite integer-affinity controls are refused before materialization',t=>{
  const f=fixture(t);f.s.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run('x'.repeat(2*1024*1024));
  assert.throws(()=>f.capture(),/head changed/);assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM replay_projection_witness').get().n,0);
});

test('legacy part identity cannot store a second parallel witness without overwriting checkpoint bytes',t=>{
  const f=fixture(t),db=f.s.db;db.prepare('DELETE FROM messages_backfill_state WHERE room_id=?').run('commons');
  db.prepare('INSERT INTO messages_backfill_state(room_id,part,json) VALUES(?,?,?)').run('commons',0,'legacy checkpoint source');
  assert.throws(()=>db.prepare('INSERT INTO messages_backfill_state(room_id,part,json) VALUES(?,?,?)').run('commons',0,'independent projection witness'),/UNIQUE/);
  assert.equal(db.prepare('SELECT json FROM messages_backfill_state WHERE room_id=? AND part=0').get('commons').json,'legacy checkpoint source');
  f.capture();assert.ok(db.prepare("SELECT count(*) AS n FROM replay_projection_witness WHERE unit_kind IN ('whole','page')").get().n>0);
  assert.equal(db.prepare('SELECT json FROM messages_backfill_state WHERE room_id=? AND part=0').get('commons').json,'legacy checkpoint source');
});

for(const mode of ['whole','split'])test(`capture mode ${mode} preserves exact authority and binds duplicate intent`,t=>{
  const f=fixture(t,false,true),before=f.authority();f.capture({mode});assert.deepEqual(f.authority(),before);
  const proof=f.s.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash;
  assert.equal(sha(read(f.s)),proof);assert.equal(f.capture({mode}).duplicate,true);
  assert.throws(()=>f.capture({mode:mode==='whole'?'split':'whole'}),/intent conflict/);archiveWitness(f);
});

test('ceiling plus one is refused by byte admission before CAST or capture writes',t=>{
  const f=fixture(t),db=f.s.db,bytes=db.prepare("SELECT octet_length(projection) AS n FROM rooms WHERE id='commons'").get().n;
  const original=db.prepare.bind(db);db.prepare=sql=>{assert.ok(!sql.includes('INSERT INTO replay_projection_witness'),'no capture copy');return original(sql);};
  assert.throws(()=>f.capture({ceilingBytes:bytes-1}),/byte ceiling/);db.prepare=original;
  assert.equal(db.prepare('SELECT count(*) AS n FROM replay_projection_witness').get().n,0);
});

for(const slim of [false,true])for(const archived of [false,true])test(`portable resumed hash binds captured H and independent proof: refs=${slim}, archive=${archived}`,t=>{
  const f=fixture(t,slim,archived);const proof=f.s.db.prepare("SELECT sequence,metadata_hash FROM integrity_room_state WHERE room_id='commons'").get();
  f.capture();if(archived)archiveWitness(f);
  let state=initialReplayHash();
  const key=f.s.issueAccessKey('commons','owner');
  f.s.command(key,'commons',{id:'after-capture',type:'message.posted',data:{messageId:'after-capture',body:'A later independently proved event'}});
  f.s.command(key,'commons',{id:'edit-retained',type:'message.edited',data:{messageId:'m4',body:'A later retained message edit',expectedMessageRevision:0}});
  for(let offset=0;;offset+=WITNESS_SLICE){
    const chunk=witnessChunk(f.s.db,'captured-head',offset);if(!chunk?.length)break;
    state=decodeReplayHash(encodeReplayHash(advanceReplayHash(state,chunk)));
  }
  assert.equal(finishReplayHash(state),proof.metadata_hash,'old independent proof, not a captured self-hash');
  assert.equal(f.s.db.prepare("SELECT head FROM replay_projection_witness WHERE unit_kind='header'").get().head,proof.sequence);
  assert.ok(f.s.headSequence('commons')>proof.sequence);
});
