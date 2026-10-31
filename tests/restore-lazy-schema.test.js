import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText,replayNdjson} from '../server/room-export.mjs';
import {replayNdjsonInto,createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {seedLazyRestoreStore,lazyRestoreRows,lazyRestoreTables} from './helpers/lazy-restore-fixture.mjs';
function source(t){const store=new RoomStore(':memory:');t.after(()=>store.close());seedLazyRestoreStore(store);return store;}
function target(t){const store=new RoomStore(':memory:');t.after(()=>store.close());return store;}
for(const mode of ['file','buffered','streaming']) test(`${mode} strict restore preserves production-like lazy schemas and content hashes`,t=>{
  const original=source(t),expected=lazyRestoreRows(original),ndjson=exportNdjsonText(original.db);let restored,result;
  if(mode==='file'){
    const dir=mkdtempSync(join(tmpdir(),'lazy-restore-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const filename=join(dir,'room.sqlite');result=replayNdjson(ndjson,filename);
    restored=new RoomStore(filename);t.after(()=>restored.close());
  }else{
    restored=target(t);
    if(mode==='buffered')result=replayNdjsonInto(ndjson,restored);
    else{const session=createBackupReplaySession(restored);for(let n=0;n<ndjson.length;n+=733)session.writeText(ndjson.slice(n,n+733));result=session.finish();}
  }
  assert.equal(result.verified,true);assert.equal(result.contentVerification,'full');assert.equal(result.audit.ok,true);
  assert.deepEqual(lazyRestoreRows(restored),expected);
  for(const table of lazyRestoreTables)assert.equal(result.skippedTables?.[table],undefined);
});
for(const mode of ['file','buffered','streaming']) test(`${mode} restore still rejects an unknown application table`,t=>{
  const original=source(t);original.db.exec("CREATE TABLE unrecognized_restore_table(id TEXT); INSERT INTO unrecognized_restore_table VALUES('fixture')");
  const ndjson=exportNdjsonText(original.db);
  const restore=()=>{
    if(mode==='file'){const dir=mkdtempSync(join(tmpdir(),'unknown-restore-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return replayNdjson(ndjson,join(dir,'room.sqlite'));}
    const store=target(t);if(mode==='buffered')return replayNdjsonInto(ndjson,store);
    const session=createBackupReplaySession(store);try{session.writeText(ndjson);return session.finish();}finally{session.abort();}
  };
  assert.throws(restore,/Export names a table this store does not have/);
});
test('lazy table content tampering still fails verification',t=>{
  const original=source(t),ndjson=exportNdjsonText(original.db);
  const tampered=ndjson.split('\n').map(line=>{if(!line)return line;const row=JSON.parse(line);if(row.table==='patrol_blocks')row.row.head_seq++;return JSON.stringify(row);}).join('\n');
  assert.throws(()=>replayNdjsonInto(tampered,target(t)),/digest|content|match/i);
});
