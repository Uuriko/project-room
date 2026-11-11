import test from 'node:test';import assert from 'node:assert/strict';import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
const snapshot=s=>Object.fromEntries(['rooms','events','messages','commands','current_room_head','current_room_records','current_room_record_proofs','operator_actions'].map(t=>[t,s.db.prepare('SELECT * FROM '+t).all()]));
test('previous native-work-4 warm format readers, cold schema-floor readers and prepared writers refuse the v2 activation floor',async t=>{
 const {mkdtempSync,mkdirSync,rmSync,symlinkSync,realpathSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{execFileSync}=await import('node:child_process'),{pathToFileURL}=await import('node:url');
 const {CURRENT_ROOM_GUARDS}=await import('../server/current-room-repository.mjs'),root=mkdtempSync(join(tmpdir(),'current-history-old4-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const archive=join(root,'old');mkdirSync(archive);
 execFileSync('tar',['-x','-C',archive],{input:execFileSync('git',['archive','06af4213d0b8fe1dc228ea35b04b50cec7ddb15e','server','src','client','strings','package.json'],{maxBuffer:64*1024*1024})});symlinkSync(realpathSync('node_modules'),join(archive,'node_modules'));
 const {RoomStore:OldStore}=await import(pathToFileURL(join(archive,'server/store.mjs'))),oldRepo=await import(pathToFileURL(join(archive,'server/current-room-repository.mjs'))),oldAdmission=await import(pathToFileURL(join(archive,'server/restore-admission.mjs'))),path=join(root,'room.sqlite'),old=new OldStore(path);t.after(()=>old.close());
 const prepared=old.db.prepare("UPDATE events SET body='{}' WHERE room_id='commons'");
 // This is a deliberate upgrade fixture for a verified EMPTY target only,
 // never an ordinary writer bypass or an existing-room format conversion.
 old.transaction(()=>{oldRepo.verifyCurrentRoomSchema(old.db);oldAdmission.verifyRestoreControl(old.db);assert.equal(old.db.prepare('SELECT count(*) n FROM rooms').get().n,0);assert.deepEqual({...old.db.prepare('SELECT state,restore_id FROM current_restore_admission').get()},{state:'clear',restore_id:null});for(const[name]of oldAdmission.RESTORE_CONTROL_GUARDS)old.db.exec('DROP TRIGGER '+name);old.db.exec('DROP TRIGGER current_room_permit_update');old.db.exec(CURRENT_ROOM_GUARDS);});
 const current=new RoomStore(path);t.after(()=>current.close());const es=initialRoom();es.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'saved',body:'preserved'}}));current.initialize(es,{representation:'normalized-current-v1'});const key=current.issueAccessKey('commons','owner'),before=snapshot(current);
 assert.throws(()=>prepared.run(),/no such function: project_room_writer_v46/);
 // A schema-compatible current connection still reaches the normalized permit guard.
 const sameFloor=current.db.prepare("UPDATE events SET body='{}' WHERE room_id='commons'");assert.throws(()=>current.transaction(()=>sameFloor.run()),/unsupported current room writer/);
 assert.throws(()=>old.roomAuthority('commons'),/owned serving schema changed|reconciliation/);
 assert.throws(()=>old.command(key,'commons',{id:'old-delete',type:'message.deleted',data:{messageId:'saved',expectedMessageRevision:0}}),/owned serving schema changed|reconciliation/);
 assert.throws(()=>new OldStore(path),/Database schema is newer than this service/);assert.deepEqual(snapshot(current),before);
});
