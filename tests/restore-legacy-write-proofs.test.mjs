import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRuntimePackage} from '../scripts/runtime-package.mjs';
import {exportNdjsonText,replayNdjson} from '../server/room-export.mjs';
import {replayNdjsonInto,createBackupReplaySession,operatorRestoreResponse,operatorRestoreFromBackupResponse} from '../server/restore-ndjson.mjs';
import {projectionDigest} from '../server/write-integrity.mjs';
import {STORE_SCHEMA_VERSION} from '../server/writer-fence.mjs';
import {writeKvBackup} from '../cloudflare/room-backup.mjs';

const methods=['file','buffered','stream'];
function fixture(t){const root=mkdtempSync(join(tmpdir(),'restore-proofs-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function replay(method,ndjson,filename,options={}){
 if(method==='file')return replayNdjson(ndjson,filename,{audit:'report',...options});
 const target=new RoomStore(filename);
 try {
  if(method==='buffered')return replayNdjsonInto(ndjson,target,{audit:'report',...options});
  const session=createBackupReplaySession(target,{audit:'report',...options});
  try {session.writeText(ndjson);return session.finish();}catch(error){session.abort();throw error;}
 }finally{target.close();}
}
function checkWritable(filename,{historical=null}={}){
 const target=new RoomStore(filename);
 try {
  const row=target.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
  const proof=target.db.prepare("SELECT metadata_hash,projection_hash FROM integrity_room_state WHERE room_id='commons'").get();
  assert.equal(proof?.metadata_hash,projectionDigest(row.projection));
  assert.equal(proof.projection_hash,historical,'prospective adoption must retain historical verification exactly');
  const key=target.issueAccessKey('commons','owner');
  target.command(key,'commons',{id:'after-restore',type:'message.posted',data:{messageId:'after-restore',body:'Unicode café 🧪'}});
  assert.equal(target.room('commons').state.messages.at(-1).body,'Unicode café 🧪');
 }finally{target.close();}
}
function raw(filename,fn){const db=new DatabaseSync(filename,{readOnly:true});try{return fn(db);}finally{db.close();}}
function missingProofRefuses(filename){const s=new RoomStore(filename);try{const key=s.issueAccessKey('commons','owner');assert.throws(()=>s.command(key,'commons',{id:'no-proof',type:'message.posted',data:{body:'Must refuse'}}),/projection_corrupt/);}finally{s.close();}}

for(const [variant,version,commit] of [
 ['v42',42,'1ab906c37b5c5bdfe07f1b12808c8855128a713f'],
 ['v43-weak',43,'72a7d6e4d7e67e866b6314c2218e8a2a0cac8fc5'],
 ['v43-strong',43,'4b060ff07ce0bbedb3eae216e40825315cc9eff5'],
]) test(`genuine ${variant} restore adopts only explicitly authorized prospective proofs`,async t=>{
 const root=fixture(t),runtime=join(root,'prior');createRuntimePackage({repository:process.cwd(),commit,destination:runtime});
 const {RoomStore:OldStore}=await import(pathToFileURL(join(runtime,'server/store.mjs')));
 const {exportNdjsonText:oldExport}=await import(pathToFileURL(join(runtime,'server/room-export.mjs')));
 const old=new OldStore(join(root,'source.sqlite'));let ndjson,corrupt,historical=null;
 try {
  old.initialize(initialRoom());assert.equal(old.db.prepare('PRAGMA user_version').get().user_version,version);
  if(variant==='v43-strong'){
   await old.verifyRoomIntegrity({yieldBetween:async()=>{}});await old.verifyRoomIntegrity({yieldBetween:async()=>{}});
   historical=old.db.prepare("SELECT projection_hash FROM integrity_room_state WHERE room_id='commons'").get().projection_hash;assert.match(historical,/^[a-f0-9]{64}$/);
  }
  ndjson=oldExport(old.db);assert.equal(JSON.parse(ndjson.split('\n')[0]).sourceSchemaVersion,undefined);
  if(historical){const original=old.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;old.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(original.replace('Commons','Xommons'));corrupt=oldExport(old.db);}
 }finally{old.close();}
 for(const method of methods){
  await t.test(`${method}: legacy attestation enables cold Unicode writes without inventing history`,()=>{
   const filename=join(root,`${method}-explicit.sqlite`),result=replay(method,ndjson,filename,{sourceSchemaVersion:version});
   assert.equal(result.writeProofs.sourceSchemaVersion,version);assert.equal(result.writeProofs.metadataProofsAdded,1);assert.equal(result.writeProofs.historicalVerification,'unchanged');
   checkWritable(filename,{historical});
  });
  await t.test(`${method}: bad trailer cannot establish prospective proof`,()=>{
   const lines=ndjson.trim().split('\n'),trailer=JSON.parse(lines.at(-1));trailer.events++;lines[lines.length-1]=JSON.stringify(trailer);
   const filename=join(root,`${method}-bad-trailer.sqlite`);
   assert.throws(()=>replay(method,lines.join('\n')+'\n',filename,{sourceSchemaVersion:version}),/torn|event|trailer|count/i);
   if(existsSync(filename))raw(filename,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM rooms').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM integrity_room_state WHERE metadata_hash IS NOT NULL').get().n,0);});
  });
  if(!historical)await t.test(`${method}: unmarked default remains fail closed`,()=>{
   const filename=join(root,`${method}-default.sqlite`);replay(method,ndjson,filename);missingProofRefuses(filename);
  });
  if(corrupt)await t.test(`${method}: valid trailer cannot bless a corrupt historical baseline even in report mode`,()=>{
   const filename=join(root,`${method}-corrupt.sqlite`);assert.throws(()=>replay(method,corrupt,filename,{sourceSchemaVersion:version}),/projection_corrupt: legacy content does not match its baseline/);
   raw(filename,db=>{for(const p of db.prepare('SELECT metadata_hash FROM integrity_room_state').all())assert.equal(p.metadata_hash,null);if(method==='stream')assert.equal(db.prepare('SELECT count(*) AS n FROM rooms').get().n,0);});
  });
 }
 if(variant==='v42'){
  await t.test('CLI explicit legacy attestation produces a writable cold restore',()=>{
   const input=join(root,'old.ndjson'),filename=join(root,'cli.sqlite');writeFileSync(input,ndjson);
   const out=JSON.parse(execFileSync(process.execPath,['scripts/restore-room-backup.mjs','--from',input,'--to',filename,'--audit','report','--source-schema-version','42'],{encoding:'utf8'}));
   assert.equal(out.writeProofs.sourceSchemaVersion,42);checkWritable(filename);
  });
  await t.test('authenticated body and KV restore accept explicit legacy source',async()=>{
   const token='synthetic-restore-token';
   const first=new RoomStore(join(root,'http.sqlite'));
   try{const request=new Request('https://room.example/api/operator/restore?audit=report&sourceSchemaVersion=42',{method:'POST',headers:{authorization:`Bearer ${token}`},body:ndjson});const response=await operatorRestoreResponse(request,token,first);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).writeProofs.sourceSchemaVersion,42);}finally{first.close();}
   checkWritable(join(root,'http.sqlite'));
   const map=new Map(),kv={get:async key=>map.get(key)??null,put:async(key,value)=>map.set(key,value)},key='room-backups/2026-10-31.ndjson';
   await writeKvBackup(kv,key,new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(ndjson));c.close();}}));
   const second=new RoomStore(join(root,'kv.sqlite'));
   try{const request=new Request('https://room.example/api/operator/restore-from-backup',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({key,audit:'report',sourceSchemaVersion:42})});const response=await operatorRestoreFromBackupResponse(request,token,second,kv);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).writeProofs.sourceSchemaVersion,42);}finally{second.close();}
   checkWritable(join(root,'kv.sqlite'));
  });
 }
});

test('current schema marker prevents legacy attestation from blessing missing proofs',async t=>{
 const root=fixture(t),s=new RoomStore(join(root,'current.sqlite'));let ndjson;
 try{s.initialize(initialRoom());s.db.exec('DELETE FROM integrity_room_state');ndjson=exportNdjsonText(s.db);}finally{s.close();}
 // This is a current-writer export, not a frozen schema44 fixture. Keep
 // current exports outside the explicitly attested legacy42/43 path.
 assert.ok(STORE_SCHEMA_VERSION>=44);
 assert.equal(JSON.parse(ndjson.split('\n')[0]).sourceSchemaVersion,STORE_SCHEMA_VERSION);
 for(const method of methods){
  const filename=join(root,`${method}.sqlite`);replay(method,ndjson,filename);missingProofRefuses(filename);
  assert.throws(()=>replay(method,ndjson,join(root,`${method}-conflict.sqlite`),{sourceSchemaVersion:42}),/attestation conflicts/);
 }
});
