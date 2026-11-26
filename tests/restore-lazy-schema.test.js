import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workspacePreviews} from '../server/workspace-previews.mjs';
import {RoomStore} from '../server/store.mjs';
import {restoreProgress} from '../server/restore-admission.mjs';
import {exportNdjsonText,replayNdjson} from '../server/room-export.mjs';
import {replayNdjsonInto,createBackupReplaySession,continueRestoreCoverage} from '../server/restore-ndjson.mjs';
import {seedLazyRestoreStore,lazyRestoreRows,lazyRestoreTables} from './helpers/lazy-restore-fixture.mjs';
function source(t){const store=new RoomStore(':memory:');t.after(()=>store.close());seedLazyRestoreStore(store);return store;}
function target(t){const store=new RoomStore(':memory:');t.after(()=>store.close());return store;}
for(const mode of ['file','buffered','streaming','staged']) test(`${mode} strict restore preserves production-like lazy schemas and content hashes`,t=>{
  const original=source(t);
  const previews=workspacePreviews(original.db);
  const sharedId='a'.repeat(32),directedId='b'.repeat(32);
  const document={title:'Release notes',base:'c'.repeat(40),head:'d'.repeat(40),html:'<p>Revision B</p>',
    patch:'diff --git a/notes.md b/notes.md\n',output:'Document checks passed'};
  const reject=(_status,code)=>assert.fail(code);
  previews.publish('commons','owner',{...document,id:sharedId,expectedRevision:0},1,reject);
  previews.publish('commons','owner',{...document,id:directedId,recipientId:'reviewer',expectedRevision:0},1,reject);
  previews.publish('commons','owner',{...document,title:'Revised release notes',id:directedId,recipientId:'reviewer',expectedRevision:1},2,reject);
  const expected=lazyRestoreRows(original),ndjson=exportNdjsonText(original.db);
  let restored,result,filename;
  if(mode==='file'||mode==='staged'){
    const dir=mkdtempSync(join(tmpdir(),'lazy-restore-'));
    t.after(()=>{restored?.close();rmSync(dir,{recursive:true,force:true});});
    filename=join(dir,'room.sqlite');
  }
  if(mode==='file'){
    result=replayNdjson(ndjson,filename);
    restored=new RoomStore(filename);
  }else{
    restored=filename ? new RoomStore(filename) : target(t);
    if(mode==='buffered')result=replayNdjsonInto(ndjson,restored);
    else if(mode==='streaming'){
      const session=createBackupReplaySession(restored);
      for(let n=0;n<ndjson.length;n+=733)session.writeText(ndjson.slice(n,n+733));
      result=session.finish();
    }else{
      const rows=ndjson.trimEnd().split('\n');
      const index=rows.findIndex(line=>JSON.parse(line).table==='room_workspace_directed_previews');
      assert.ok(index>1);
      const [directedRow]=rows.splice(index,1);
      rows.splice(1,0,directedRow);
      result=replayNdjsonInto(rows.join('\n')+'\n',restored,{staged:true});
      assert.equal(result.pending,true);
      restored.close();
      restored=new RoomStore(filename);
      assert.ok(restoreProgress(restored.db).seal.inventory.includes('room_workspace_directed_previews'));
      assert.throws(()=>restored.headSequence('commons'),error=>error.status===503);
      for(let step=0;result.pending && step<100;step++){
        result=continueRestoreCoverage(restored,{restoreId:result.restoreId,sourceSeal:result.sourceSeal,
          expectedRevision:result.revision,requestId:'workspace-coverage-'+step});
      }
    }
  }
  assert.equal(result.verified,true);assert.equal(result.contentVerification,'full');assert.equal(result.audit.ok,true);
  assert.deepEqual(lazyRestoreRows(restored),expected);
  const recovered=workspacePreviews(restored.db,{create:false});
  const exact=recovered.get('commons',directedId,'reviewer');
  assert.equal(exact.revision,2);
  assert.deepEqual(exact,previews.get('commons',directedId,'reviewer'));
  assert.equal(recovered.get('commons',directedId,'other'),recovered.get('commons','e'.repeat(32),'other'));
  assert.deepEqual(recovered.list('commons','other').map(row=>row.id),[sharedId]);
  assert.deepEqual(recovered.list('commons','reviewer').map(row=>row.id),[directedId,sharedId]);
  for(const table of lazyRestoreTables)assert.equal(result.skippedTables?.[table],undefined);
});
for(const mode of ['file','buffered','streaming','staged']) test(`${mode} restore still rejects an unknown application table`,t=>{
  const original=source(t);original.db.exec("CREATE TABLE unrecognized_restore_table(id TEXT); INSERT INTO unrecognized_restore_table VALUES('fixture')");
  const ndjson=exportNdjsonText(original.db);
  const restore=()=>{
    if(mode==='file'){const dir=mkdtempSync(join(tmpdir(),'unknown-restore-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return replayNdjson(ndjson,join(dir,'room.sqlite'));}
    const store=target(t);if(mode==='buffered'||mode==='staged')return replayNdjsonInto(ndjson,store,{staged:mode==='staged'});
    const session=createBackupReplaySession(store);try{session.writeText(ndjson);return session.finish();}finally{session.abort();}
  };
  assert.throws(restore,/Export names a table this store does not have/);
});
test('lazy table content tampering still fails verification',t=>{
  const original=source(t),ndjson=exportNdjsonText(original.db);
  const tampered=ndjson.split('\n').map(line=>{if(!line)return line;const row=JSON.parse(line);if(row.table==='patrol_blocks')row.row.head_seq++;return JSON.stringify(row);}).join('\n');
  assert.throws(()=>replayNdjsonInto(tampered,target(t)),/digest|content|match/i);
});
