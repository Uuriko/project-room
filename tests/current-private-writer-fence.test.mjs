import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,symlinkSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {CURRENT_ROOM_GUARDS} from '../server/current-room-repository.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
test('actual older same-floor reader and writer refuse privacy format before serving or mutating',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'current-private-old45-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const archive=execFileSync('git',['archive','1c36aee6aaa0a651a711eaab2cb3c6adbc8f5c37','server','src','client','strings','package.json'],{maxBuffer:64*1024*1024});execFileSync('tar',['-x','-C',directory],{input:archive});symlinkSync(realpathSync(new URL('../node_modules',import.meta.url)),join(directory,'node_modules'),'dir');
 const {RoomStore:OldStore}=await import(pathToFileURL(join(directory,'server/store.mjs')).href),path=join(directory,'room.sqlite'),old=new OldStore(path);t.after(()=>old.close());
 const events=initialRoom();for(const memberId of ['producer','observer'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[]}}));
 events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'private',title:'OLD-READER-PRIVATE-TITLE',definitionOfDone:'Private',accountableMemberId:'producer'}}),event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'private-request',workItemId:'private',toMemberId:'producer',requestKind:'reply',requestPolicyVersion:1,body:'Private request'}}));
 old.initialize(events,{representation:'normalized-current-v1'});const observer=old.issueAccessKey('commons','observer'),owner=old.issueAccessKey('commons','owner');
 // Warm the genuine old module's schema cache and prove this source really
 // lacks the corrected privacy interpretation before the format transition.
 assert.ok(JSON.stringify(old.currentOverview('commons','observer')).includes('OLD-READER-PRIVATE-TITLE'));
 const start=CURRENT_ROOM_GUARDS.indexOf('CREATE TRIGGER IF NOT EXISTS current_room_permit_update '),end=CURRENT_ROOM_GUARDS.indexOf('\nCREATE TRIGGER',start);assert.ok(start>=0&&end>start);
 // Controlled offline format-install seam, not a production upgrade claim.
 old.transaction(()=>{old.db.exec('DROP TRIGGER current_room_permit_update');old.db.exec(CURRENT_ROOM_GUARDS.slice(start,end));});
 const snapshot=()=>JSON.stringify(Object.fromEntries(['rooms','events','commands','current_room_head','current_room_records','current_room_record_proofs','operator_actions'].map(table=>[table,old.db.prepare('SELECT * FROM '+table).all()]))),before=snapshot();
 assert.throws(()=>old.roomContext(observer,'commons'),/current_room_corrupt|serving schema|schema requires/);
 assert.throws(()=>old.command(owner,'commons',{id:'old45-write',type:'message.posted',data:{messageId:'old45-write',body:'Must not commit'}}),/current_room_corrupt|serving schema|schema requires|unsupported current room permit/);
 assert.equal(snapshot(),before);
 assert.throws(()=>{const cold=new OldStore(path);try{cold.roomContext(observer,'commons');}finally{cold.close();}},/current_room_corrupt|serving schema|schema requires/);
 assert.equal(snapshot(),before);
});
