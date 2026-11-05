import {transitionEmptyCurrentPermit} from './helpers/empty-current-permit-transition.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,rmSync,symlinkSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {RoomStore} from '../server/store.mjs';import {RESTORE_CONTROL_SCHEMA,RESTORE_CONTROL_GUARDS,restoreProgress} from '../server/restore-admission.mjs';import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';import {exportNdjsonText} from '../server/room-export.mjs';import {seedRecoveryInvitationSource} from './helpers/recovery-invitation-source.mjs';
const token='synthetic-independent-invitation-restore';
test('genuine protocol15 cold/preopened continuation and prepared writer refuse16 before progress',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'invitation-protocol-gate-')),oldRoot=join(directory,'old'),filename=join(directory,'target.sqlite');mkdirSync(oldRoot);t.after(()=>rmSync(directory,{recursive:true,force:true}));execFileSync('tar',['-xf','-','-C',oldRoot],{input:execFileSync('git',['archive','--format=tar','aa4a88c21','server','src','client','strings','package.json','cloudflare/room-backup.mjs'],{maxBuffer:64*1024*1024})});symlinkSync(realpathSync('node_modules'),join(oldRoot,'node_modules'));
 const {RoomStore:OldStore}=await import(pathToFileURL(join(oldRoot,'server/store.mjs'))),oldAdmission=await import(pathToFileURL(join(oldRoot,'server/restore-admission.mjs'))),oldCurrent=await import(pathToFileURL(join(oldRoot,'server/current-room-repository.mjs'))),oldRestore=await import(pathToFileURL(join(oldRoot,'server/restore-ndjson.mjs'))),held=new OldStore(filename),source=new RoomStore(':memory:');t.after(()=>{held.close();source.close();});seedRecoveryInvitationSource(source);const prepared=held.db.prepare("UPDATE credentials SET revoked=1 WHERE kind='access'");
 // Explicit verified-empty offline control transition only. No old source rows
 // or guards are silently accepted by16; an old open connection remains held.
 held.transaction(()=>{oldAdmission.verifyRestoreControl(held.db);assert.equal(held.db.prepare('SELECT count(*) n FROM rooms').get().n,0);assert.equal(oldAdmission.restoreProgress(held.db).state,'clear');transitionEmptyCurrentPermit(held,oldCurrent);for(const[name]of oldAdmission.RESTORE_CONTROL_GUARDS)held.db.exec('DROP TRIGGER '+name);held.db.exec(RESTORE_CONTROL_SCHEMA);for(const[,sql]of RESTORE_CONTROL_GUARDS)held.db.exec(sql);});
 const current=new RoomStore(filename);t.after(()=>current.close());
 const request=body=>new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)});
 const response=await operatorRestoreResponse(request(exportNdjsonText(source.db)),token,current);assert.equal(response.status,202);const state=await response.json(),before=restoreProgress(current.db),input={restoreId:state.restoreId,sourceSeal:state.sourceSeal,expectedRevision:state.revision,requestId:'old15-denied'};let drops=0;const exec=held.db.exec.bind(held.db);held.db.exec=sql=>{if(/^DROP TRIGGER current_restore_/.test(sql))drops++;return exec(sql);};
 try{
  // Genuine schema45 code cannot execute the installed v46 writer guard.
  assert.throws(()=>prepared.run(),/no such function: project_room_writer_v46/);
  // A compatible writer independently reaches the original restore seal.
  const sameFloor=current.db.prepare("UPDATE credentials SET revoked=1 WHERE kind='access'");
  assert.throws(()=>sameFloor.run(),/sealed|restore admission/);
  assert.throws(()=>new OldStore(filename),/Database schema is newer than this service/);
  const oldResponse=await oldRestore.operatorRestoreResponse(request(input),token,held);assert.equal(oldResponse.status,422);assert.equal(drops,0);assert.deepEqual(restoreProgress(current.db),before);
  assert.equal((await operatorRestoreResponse(request(input),token,current)).status,202);
 }finally{held.db.exec=exec;}
});
