import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRuntimePackage} from '../scripts/runtime-package.mjs';
import {backupRoom} from '../server/backup.mjs';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText,replayNdjson,sanitizeCell} from '../server/room-export.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,abandonReplayCapture,cleanupReplayCapture} from '../server/replay-cutover.mjs';

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'replay-recovery-'));
  const store=new RoomStore(join(directory,'source.sqlite'));
  store.initialize(initialRoom());store.db.exec(replayCutoverSchema());
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const input={roomId:'commons',requestId:'capture-recovery',expectedHead:store.headSequence('commons'),reason:'Synthetic recovery control'};
  const captured=captureReplayWitness(store,input);
  return {store,directory,input,captured};
}

test('recovery recognizes explicit sidecar without activating it on ordinary opens',t=>{
  const f=fixture(t);
  assert.equal(auditRecovery(f.store).checks.writerFence,true);
  const plain=new RoomStore(':memory:');t.after(()=>plain.close());
  assert.equal(plain.db.prepare("SELECT name FROM sqlite_master WHERE name='message_replay_units'").get(),undefined);
});

test('whole-store restore preserves exact captured authority and historical phase receipts',t=>{
  const f=fixture(t),before=f.store.db.prepare('SELECT * FROM message_replay_units ORDER BY generation,domain,unit_key').all();
  const receipts=f.store.db.prepare("SELECT * FROM operator_actions WHERE action LIKE 'replay_cutover_%'").all();
  const filename=join(f.directory,'restored.sqlite');
  assert.equal(replayNdjson(exportNdjsonText(f.store.db),filename).verified,true);
  const restored=new RoomStore(filename);t.after(()=>restored.close());
  assert.deepEqual(restored.db.prepare('SELECT * FROM message_replay_units ORDER BY generation,domain,unit_key').all(),before);
  assert.deepEqual(restored.db.prepare("SELECT * FROM operator_actions WHERE action LIKE 'replay_cutover_%'").all(),receipts);
  assert.equal(captureReplayWitness(restored,f.input).duplicate,true);
  assert.equal(advanceReplayWitness(restored,{roomId:'commons',generation:f.captured.generation,expectedBytes:0,requestId:'recovered-step'}).phase,'witness_verified');
});

test('structured sidecar BLOBs obey the existing text token scrub policy',()=>{
  const token='pri_syntheticPrivateToken123';
  for(const value of [Buffer.from(JSON.stringify({body:token})),new TextEncoder().encode(token).buffer]){
    const sanitized=sanitizeCell('message_replay_units','payload',value);
    const decoded=Buffer.from(sanitized.$base64,'base64').toString('utf8');
    assert.ok(!decoded.includes(token));
    assert.equal(decoded.length,value.byteLength-token.length+64);
  }
  assert.throws(()=>sanitizeCell('message_replay_units','payload',Uint8Array.of(0xff)),/UTF-8|encoded data/);
});

test('physical backup preserves sidecar and independent receipt bytes',async t=>{
  const f=fixture(t);
  const backup=await backupRoom(join(f.directory,'source.sqlite'),f.directory);
  assert.equal(backup.verified,true);
  const restored=new RoomStore(backup.filename,{readOnly:true});t.after(()=>restored.close());
  assert.deepEqual(restored.db.prepare('SELECT * FROM message_replay_units').all(),f.store.db.prepare('SELECT * FROM message_replay_units').all());
  assert.deepEqual(restored.db.prepare("SELECT * FROM operator_actions WHERE action LIKE 'replay_cutover_%'").all(),f.store.db.prepare("SELECT * FROM operator_actions WHERE action LIKE 'replay_cutover_%'").all());
});

test('the pinned prior recovery tool refuses the unknown extension',t=>{
  const f=fixture(t),destination=join(f.directory,'prior-runtime');
  createRuntimePackage({repository:fileURLToPath(new URL('../',import.meta.url)),
    commit:'564b0438d3a1946e6d07b179112a4f7cacb158e2',destination});
  const code=`import {RoomStore} from ${JSON.stringify(pathToFileURL(join(destination,'server/store.mjs')).href)};
    import {auditRecovery} from ${JSON.stringify(pathToFileURL(join(destination,'server/recovery.mjs')).href)};
    let s;
    try{s=new RoomStore(process.argv[1],{readOnly:true});auditRecovery(s);process.exitCode=2;}catch(error){if(!['Recovery data requires operator reconciliation','Database schema is newer than this service'].includes(error.message))throw error;}
    finally{s?.close();}`;
  assert.doesNotThrow(()=>execFileSync(process.execPath,['--input-type=module','-e',code,join(f.directory,'source.sqlite')],{stdio:'pipe'}));
});

for(const mode of ['buffered','streaming'])test(`existing ${mode} restore carries explicit sidecar`,async t=>{
  const f=fixture(t),target=new RoomStore(join(f.directory,mode+'.sqlite'));t.after(()=>target.close());
  const {replayNdjsonInto,createBackupReplaySession}=await import('../server/restore-ndjson.mjs');
  const exported=exportNdjsonText(f.store.db);
  const result=mode==='buffered'?replayNdjsonInto(exported,target):(()=>{
    const session=createBackupReplaySession(target);session.writeText(exported);return session.finish();
  })();
  assert.equal(result.verified,true);
  assert.deepEqual(target.db.prepare('SELECT * FROM message_replay_units').all(),f.store.db.prepare('SELECT * FROM message_replay_units').all());
});

for(const mutation of ['schema','checkpoint','witness','orphan'])test(`recovery refuses preserved ${mutation} corruption without self-certification`,t=>{
  const f=fixture(t),db=f.store.db;
  if(mutation==='schema')db.exec('DROP TRIGGER replay_source_update');
  if(mutation==='checkpoint')db.prepare("UPDATE message_replay_units SET payload=CAST(json_set(CAST(payload AS TEXT),'$.state','{}') AS BLOB),payload_sha256=? WHERE domain='hash'").run('0'.repeat(64));
  if(mutation==='witness')db.prepare("UPDATE message_replay_units SET payload=CAST(replace(CAST(payload AS TEXT),'commons','changed') AS BLOB) WHERE domain='witness'").run();
  if(mutation==='orphan')db.prepare("DELETE FROM message_replay_units WHERE domain='header'").run();
  assert.throws(()=>auditRecovery(f.store),/replay|reconciliation/);
});

test('codec phase admits every variable continuation control before SQL work',t=>{
  const f=fixture(t),before=f.store.db.prepare('SELECT * FROM operator_actions').all();
  for(const change of [{generation:'x'.repeat(2*1024*1024)},{expectedBytes:'x'.repeat(2*1024*1024)},{expectedBytes:-1}])
    assert.throws(()=>partitionReplayWitness(f.store,{roomId:'commons',requestId:'bad-codec',generation:f.captured.generation,expectedBytes:0,...change}),/invalid replay hash intent/);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM operator_actions').all(),before);
});

for(const duplicate of ['{"id":"a","nested":{"x":1,"x":2}}','{"id":"a","nested":{"x":1,"\\u0078":2}}'])
test('captured exact bytes do not authorize shadowed nested object keys',t=>{
  const f=fixture(t),db=f.store.db;
  // This is a new independently witnessed fixture, not a rewrite of a capture.
  const state=JSON.parse(db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  state.messages=[];
  const text=JSON.stringify(state).replace('"messages":[]','"messages":['+duplicate+']');
  abandonReplayCapture(f.store,{roomId:'commons',generation:f.captured.generation,requestId:'discard-original-fixture',reason:'Create a distinct malformed source fixture'});
  let cleanup={deleted:0},serial=0;do{cleanup=cleanupReplayCapture(f.store,{roomId:'commons',generation:f.captured.generation,requestId:'discard-fixture-'+serial++,expectedDeleted:cleanup.deleted});}while(!cleanup.done);
  db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(text);
  db.prepare("UPDATE integrity_room_state SET metadata_hash=? WHERE room_id='commons'").run(createHash('sha256').update(text).digest('hex'));
  const captured=captureReplayWitness(f.store,{...f.input,requestId:'duplicate-key-capture'});
  advanceReplayWitness(f.store,{roomId:'commons',generation:captured.generation,expectedBytes:0,requestId:'duplicate-key-hash'});
  const before=db.prepare('SELECT * FROM message_replay_units').all();
  assert.throws(()=>partitionReplayWitness(f.store,{roomId:'commons',generation:captured.generation,expectedBytes:0,requestId:'duplicate-key-codec'}),/duplicate replay projection object key/);
  assert.deepEqual(db.prepare('SELECT * FROM message_replay_units').all(),before);
});

test('whole-store restore preserves complete H work qualification and independently bound continuation',t=>{
  const f=fixture(t);let progress={bytes:0},n=0;
  while(progress.phase!=='witness_verified')progress=advanceReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:progress.bytes,requestId:'semantic-hash-'+n++});
  progress={bytes:0};n=0;
  while(progress.phase!=='codec_partitioned')progress=partitionReplayWitness(f.store,{roomId:'commons',generation:f.captured.generation,expectedBytes:progress.bytes,requestId:'semantic-codec-'+n++});
  const input={roomId:'commons',generation:f.captured.generation,expectedWorkCount:0,requestId:'semantic-qualify'};
  const qualified=qualifyReplayHWork(f.store,input);assert.equal(qualified.workDefaultsQualified,true);
  const before=f.store.db.prepare("SELECT * FROM message_replay_units WHERE domain='semantic'").all();
  const filename=join(f.directory,'semantic-restored.sqlite');assert.equal(replayNdjson(exportNdjsonText(f.store.db),filename).verified,true);
  const restored=new RoomStore(filename);t.after(()=>restored.close());
  assert.deepEqual(restored.db.prepare("SELECT * FROM message_replay_units WHERE domain='semantic'").all(),before);
  assert.deepEqual({...qualifyReplayHWork(restored,input),duplicate:false},qualified);
  assert.equal(auditRecovery(restored).checks.writerFence,true);
});
